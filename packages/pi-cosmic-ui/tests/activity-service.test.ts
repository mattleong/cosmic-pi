import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { deferredPromise, yieldUntil } from "pi-cosmic-core/testing";
import { ActivityService, type ActivityActionRequest } from "../src/activity/service.ts";
import { activityKey, type ActivityEnvelope, type ActivityItem } from "../src/activity/protocol.ts";
import type { ActivityRow } from "../src/activity/model.ts";
import { renderActivityWidget } from "../src/activity/widget.ts";
import { SPINNER_FRAME_MS } from "../src/manager/chrome.ts";
const item = (revision = "1"): ActivityItem => ({
  id: "one",
  title: "Work",
  kind: "command",
  status: "running",
  revision,
  actions: [{ id: "stop", label: "Stop" }],
});
const registration = (
  token: ActivityEnvelope["token"],
  invoke = () => Promise.resolve(),
  items: readonly ActivityItem[] = [item()],
): ActivityEnvelope => ({
  version: 1,
  sessionId: "session",
  providerId: "tasks",
  token,
  hostToken: {},
  operation: "register",
  items,
  invoke,
  acknowledge: () => undefined,
});
const action = (row: ActivityRow): ActivityActionRequest => ({
  key: row.key,
  generation: row.generation,
  revision: row.revision,
  actionId: "stop",
});
/** A service whose publications and clock-driven widget renders are recorded. */
const recordingService = Effect.gen(function* () {
  let rows: readonly ActivityRow[] = [];
  let starting = 0;
  let rendered: readonly string[] = [];
  const service = yield* ActivityService.make({
    publish: (next, count) => {
      rows = next;
      starting = count;
    },
    tick: (now) => {
      rendered = renderActivityWidget(rows, 80, 8, { now, starting });
    },
  });
  return { service, rows: () => rows, starting: () => starting, rendered: () => rendered };
});
describe("activity service", () => {
  it.effect(
    "publishes starting counts without rows and clears stale or invalid metadata atomically",
    () =>
      Effect.gen(function* () {
        const { service, rows, starting } = yield* recordingService;
        const event = { ...registration({}, undefined, []), starting: 2 };
        yield* service.receive(event);
        expect(rows()).toEqual([]);
        expect(starting()).toBe(2);
        yield* service.receive({ ...event, operation: "publish", starting: 3 });
        expect(starting()).toBe(3);
        const pending: ActivityItem[] = ["a", "b", "c"].map((id) => ({
          ...item(),
          id,
          kind: "agent",
          status: "pending",
          inputTarget: undefined,
          blockedReason: undefined,
        }));
        yield* service.receive({ ...event, operation: "publish", items: pending });
        expect(starting()).toBe(2); // Lease counts are requested work, not additional pending rows.
        yield* service.receive({ ...event, operation: "publish", items: pending, starting: 0 });
        expect(starting()).toBe(3); // Resume/start rows still count without a start-tool lease.
        for (const invalid of [-1, 1.5, Infinity, 16385, "2", null]) {
          yield* service.receive({ ...event, operation: "publish", items: pending });
          yield* Effect.flip(
            service.receive({ ...event, operation: "publish", starting: invalid }),
          );
          expect(rows()).toEqual([]);
          expect(starting()).toBe(0);
        }
        const replacement = { ...event, token: {}, starting: 1 };
        yield* service.receive(replacement);
        yield* service.receive({ ...event, operation: "publish", starting: 8 });
        yield* service.receive({ ...event, operation: "revoke" });
        expect(starting()).toBe(1);
        yield* service.receive({ ...replacement, operation: "revoke" });
        expect(starting()).toBe(0);
        yield* service.receive({ ...replacement, operation: "publish", starting: 8 });
        expect(starting()).toBe(0);
      }),
  );
  it.effect("withdraws inconsistent workflow metadata and restores valid publication", () =>
    Effect.gen(function* () {
      const { service, rows } = yield* recordingService;
      let available = false;
      const workflow: ActivityItem = {
        id: "flow",
        title: "Review",
        kind: "workflow",
        status: "running",
        revision: "1",
        phases: [{ title: "Find" }, { title: "Verify", detail: "Run the checks" }],
        phase: "Find",
        actions: [{ id: "stop", label: "Stop workflow" }],
      };
      const member: ActivityItem = {
        id: "queued",
        title: "Queued agent",
        kind: "agent",
        status: "pending",
        revision: "1",
        parent: { providerId: "tasks", itemId: "flow" },
        phase: "Find",
        actions: [{ id: "skip", label: "Skip" }],
      };
      const event = {
        ...registration({}, undefined, [workflow, member]),
        acknowledge: (next: boolean) => {
          available = next;
        },
      };
      for (const invalid of [
        [workflow, { ...member, phases: [{ title: "Find" }] }],
        [workflow, { ...member, unphasedPlanned: 1 }],
        [{ ...workflow, phases: [{ title: "Find" }, { title: "Find" }] }],
        [{ ...workflow, phases: [{ title: "Find" }, { title: "Find \u0007" }] }],
        [{ ...workflow, phase: "Ship" }],
        [{ ...workflow, phases: undefined }],
        [{ ...workflow, phases: [{ title: "Find", work: { items: 1, finished: 2, stopped: 0 } }] }],
        [{ ...workflow, phases: [{ title: "Find", work: { items: 2, finished: 1, stopped: 2 } }] }],
        [
          {
            ...workflow,
            phases: [{ title: "Find", work: { items: 3, finished: 2, stopped: 1, failed: 2 } }],
          },
        ],
        [{ ...workflow, status: "needs-input", inputTarget: "user" }],
        [{ ...workflow, status: "blocked" }],
      ]) {
        yield* service.receive(event);
        expect(available).toBe(true);
        expect(rows().map((row) => row.id)).toEqual(["flow", "queued"]);
        yield* Effect.flip(service.receive({ ...event, operation: "publish", items: invalid }));
        expect(rows()).toEqual([]);
        expect(available).toBe(false);
      }
      // Members are placed leniently: retained history can outlive a workflow's phase list.
      yield* service.receive({ ...event, items: [workflow, { ...member, phase: "Elsewhere" }] });
      expect(available).toBe(true);
      expect(rows()).toHaveLength(2);
      // Failed work is part of the finished work, apart from stopped work.
      const failing = { title: "Find", work: { items: 3, finished: 2, stopped: 1, failed: 1 } };
      yield* service.receive({ ...event, items: [{ ...workflow, phases: [failing] }, member] });
      expect(rows()[0]?.phases).toEqual([failing]);
      // A workflow keeps its producer's count of planned members outside its phases.
      yield* service.receive({ ...event, items: [{ ...workflow, unphasedPlanned: 3 }, member] });
      expect(rows()[0]?.unphasedPlanned).toBe(3);
      yield* service.invoke({ ...action(rows()[1]!), actionId: "skip" });
    }),
  );
  it.effect("accepts planned work that never runs and never counts it as starting", () =>
    Effect.gen(function* () {
      const { service, rows, starting } = yield* recordingService;
      let available = false;
      const invoked: string[] = [];
      const planned: ActivityItem = {
        id: "planned",
        title: "Planned agent",
        kind: "agent",
        status: "pending",
        revision: "1",
        planned: true,
      };
      const skippable: ActivityItem = { ...planned, actions: [{ id: "skip", label: "Skip" }] };
      const event: ActivityEnvelope = {
        ...registration({}, undefined, [planned]),
        invoke: (_itemId, actionId) => {
          invoked.push(actionId);
          return Promise.resolve();
        },
        acknowledge: (next: boolean) => {
          available = next;
        },
      };
      yield* service.receive(event);
      expect(available).toBe(true);
      expect(rows().map((row) => row.id)).toEqual(["planned"]);
      // Declared work isn't a launch, so it neither shows the startup spinner nor counts.
      expect(starting()).toBe(0);
      // Planned work its owner may still start can offer actions, such as skipping it.
      yield* service.receive({ ...event, operation: "publish", items: [skippable] });
      expect(starting()).toBe(0);
      const offered = rows()[0]!;
      yield* service.invoke({ ...action(offered), actionId: "skip" });
      expect(invoked).toEqual(["skip"]);
      // A revision the producer has since replaced is refused before reaching it.
      yield* service.receive({
        ...event,
        operation: "publish",
        items: [{ ...skippable, revision: "2" }],
      });
      const stale = yield* Effect.flip(service.invoke({ ...action(offered), actionId: "skip" }));
      expect(stale.reason).toBe("stale");
      expect(invoked).toEqual(["skip"]);
      for (const invalid of [
        { ...planned, kind: "workflow", phases: [] },
        { ...skippable, status: "cancelled" },
        { ...planned, status: "running" },
        { ...planned, status: "done" },
      ]) {
        yield* service.receive(event);
        expect(available).toBe(true);
        yield* Effect.flip(service.receive({ ...event, operation: "publish", items: [invalid] }));
        expect(rows()).toEqual([]);
        expect(available).toBe(false);
      }
      yield* service.receive({ ...event, items: [{ ...planned, status: "cancelled" }] });
      expect(available).toBe(true);
      expect(rows()[0]).toMatchObject({ planned: true, status: "cancelled", actions: [] });
    }),
  );
  it.effect(
    "accepts skipped work only on cancelled work that isn't planned, a workflow or a question",
    () =>
      Effect.gen(function* () {
        const { service, rows } = yield* recordingService;
        let available = false;
        const skipped: ActivityItem = {
          id: "skipped",
          title: "Skipped agent",
          kind: "agent",
          status: "cancelled",
          revision: "1",
          skipped: true,
        };
        const event: ActivityEnvelope = {
          ...registration({}, undefined, [skipped]),
          acknowledge: (next: boolean) => {
            available = next;
          },
        };
        yield* service.receive(event);
        expect(rows()[0]).toMatchObject({ skipped: true, status: "cancelled" });
        for (const invalid of [
          { ...skipped, status: "done" },
          { ...skipped, planned: true },
          { ...skipped, kind: "question" },
          { ...skipped, kind: "workflow", phases: [] },
        ]) {
          yield* service.receive(event);
          expect(available).toBe(true);
          yield* Effect.flip(service.receive({ ...event, operation: "publish", items: [invalid] }));
          expect(rows()).toEqual([]);
          expect(available).toBe(false);
        }
        // A phase's skipped work is part of its finished work, apart from stopped and failed work.
        const workflow: ActivityItem = {
          id: "workflow",
          title: "Workflow",
          kind: "workflow",
          status: "running",
          revision: "1",
          phases: [{ title: "Find", work: { items: 2, finished: 2, stopped: 1, skipped: 2 } }],
        };
        yield* service.receive(event);
        expect(available).toBe(true);
        yield* Effect.flip(service.receive({ ...event, operation: "publish", items: [workflow] }));
        expect(rows()).toEqual([]);
        expect(available).toBe(false);
      }),
  );
  it.effect("withdraws invalid attention metadata and restores valid publication and actions", () =>
    Effect.gen(function* () {
      const { service, rows, starting } = yield* recordingService;
      let available = false;
      const valid = { ...item(), status: "needs-input", inputTarget: "user" };
      const event = {
        ...registration({}),
        items: [valid],
        starting: 2,
        acknowledge: (next: boolean) => {
          available = next;
        },
      };
      for (const metadata of [
        { status: "needs-input" },
        { status: "needs-input", inputTarget: "agent" },
        { status: "needs-input", inputTarget: "parent", blockedReason: "parent-review" },
        { status: "blocked", blockedReason: "unknown" },
        { status: "blocked", inputTarget: "user" },
      ]) {
        yield* service.receive(event);
        expect(available).toBe(true);
        expect(rows()[0]?.inputTarget).toBe("user");
        yield* Effect.flip(
          service.receive({ ...event, operation: "publish", items: [{ ...item(), ...metadata }] }),
        );
        expect(rows()).toEqual([]);
        expect(starting()).toBe(0);
        expect(available).toBe(false);
      }
      yield* service.receive({ ...event, items: [{ ...valid, inputTarget: "parent" }] });
      expect(available).toBe(true);
      expect(rows()[0]?.inputTarget).toBe("parent");
      expect(starting()).toBe(2);
      yield* service.invoke(action(rows()[0]!));
    }),
  );
  const startup = { ...registration({}, undefined, []), starting: 2 };
  it.effect.each([
    ["metadata-only startup", startup, { ...startup, operation: "publish", starting: 0 }],
    [
      "running work",
      registration({}),
      { ...registration({}), items: [{ ...item(), status: "done" }] },
    ],
  ] as const)(
    "animates %s between elapsed-second updates and settles once it clears",
    ([, started, cleared]) =>
      Effect.gen(function* () {
        const { service, rendered } = yield* recordingService;
        yield* service.receive(started);
        yield* TestClock.adjust("1 second");
        const first = rendered();
        expect(first).not.toEqual([]);
        yield* TestClock.adjust(`${SPINNER_FRAME_MS} millis`);
        expect(rendered()).not.toEqual(first);
        yield* service.receive(cleared);
        yield* TestClock.adjust("1 second");
        expect(rendered()).toEqual([]);
        yield* TestClock.adjust("1 second");
        expect(rendered()).toEqual([]);
      }),
  );
  it.effect("detaches summaries and withdraws invalid snapshots before restoring valid ones", () =>
    Effect.gen(function* () {
      const { service, rows } = yield* recordingService;
      const token = {};
      const source = { ...item(), title: "safe\u001b[2J", profile: "scout\u001b[2J" };
      const availability: boolean[] = [];
      yield* service.receive({
        ...registration(token, undefined, [source]),
        acknowledge: (value) => {
          availability.push(value);
        },
      });
      source.title = "mutated";
      expect(rows()[0]?.title).toBe("safe");
      expect(rows()[0]?.profile).toBe("scout");
      expect(Object.isFrozen(rows()[0])).toBe(true);
      yield* Effect.flip(
        service.receive({
          ...registration(token),
          operation: "publish",
          items: [{ ...item(), status: "bogus" }],
        }),
      );
      expect(rows()).toEqual([]);
      expect(availability).toEqual([true, false]);
      yield* service.receive({ ...registration(token), operation: "publish" });
      expect(availability).toEqual([true, false, true]);
    }),
  );
  it.effect("rejects stale revisions, removed actions and replaced registration capabilities", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const service = yield* ActivityService.make({ publish: () => undefined });
      const token = {};
      yield* service.receive(
        registration(token, () => {
          calls.push("old");
          return Promise.resolve();
        }),
      );
      const old = action((yield* service.snapshot)[0]!);
      yield* service.receive({ ...registration(token), operation: "publish", items: [item("2")] });
      yield* Effect.flip(service.invoke(old));
      const second = action((yield* service.snapshot)[0]!);
      yield* service.receive(
        registration(
          {},
          () => {
            calls.push("new");
            return Promise.resolve();
          },
          [item("2")],
        ),
      );
      yield* Effect.flip(service.invoke(second));
      yield* service.receive(registration(token));
      yield* service.invoke(action((yield* service.snapshot)[0]!));
      expect(calls).toEqual(["new"]);
      const latest = (yield* service.snapshot)[0]!;
      expect(latest.key).toBe(activityKey("tasks", "one"));
    }),
  );
  it.effect("revokes rows and actions on disposal and closes host resources exactly once", () =>
    Effect.gen(function* () {
      const availability: boolean[] = [];
      let releases = 0;
      const owned = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ActivityService.make({
            publish: () => undefined,
            connect: () => () => {
              releases++;
            },
          });
          yield* service.receive({
            ...registration({}),
            acknowledge: (value) => {
              availability.push(value);
            },
          });
          return { service, request: action((yield* service.snapshot)[0]!) };
        }),
      );
      expect(availability).toEqual([true, false]);
      expect(releases).toBe(1);
      expect(yield* owned.service.snapshot).toEqual([]);
      yield* Effect.flip(owned.service.invoke(owned.request));
    }),
  );
  it.effect("loads bounded redacted details lazily and rejects late stale results", () =>
    Effect.gen(function* () {
      const service = yield* ActivityService.make({ publish: () => undefined });
      const token = {};
      let calls = 0;
      yield* service.receive({
        ...registration(token),
        getDetail: () => {
          calls++;
          return Promise.resolve(`token=private-value\n${"x".repeat(20000)}`);
        },
      });
      expect(calls).toBe(0);
      const request = action((yield* service.snapshot)[0]!);
      const detail = yield* service.detail(request);
      expect(detail.length).toBeLessThanOrEqual(16384);
      expect(detail).not.toContain("private-value");
      expect(calls).toBe(1);
      const pending = deferredPromise<string>();
      let started = false;
      yield* service.receive({
        ...registration({}),
        getDetail: () => {
          started = true;
          return pending.promise;
        },
      });
      const current = action((yield* service.snapshot)[0]!);
      const fiber = yield* service.detail(current).pipe(Effect.exit, Effect.forkScoped);
      yield* yieldUntil(() => started);
      yield* service.receive(registration({}));
      pending.resolve("late detail");
      expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
    }),
  );
  it.effect("releases the clock ticker with the service scope", () =>
    Effect.gen(function* () {
      const ticks: number[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ActivityService.make({
            publish: () => undefined,
            tick: (now) => {
              ticks.push(now);
            },
          });
          yield* TestClock.adjust("2 seconds");
          expect(ticks.at(-1)).toBe(2000);
        }),
      );
      const settled = [...ticks];
      yield* TestClock.adjust("5 seconds");
      expect(ticks).toEqual(settled);
    }),
  );
  it.effect("aborts a producer capability when its owning operation is interrupted", () =>
    Effect.gen(function* () {
      const service = yield* ActivityService.make({ publish: () => undefined });
      let signal: AbortSignal | undefined;
      const pending = deferredPromise<void>();
      yield* service.receive({
        ...registration({}),
        invoke: (_item, _action, _revision, value) => {
          signal = value;
          return pending.promise;
        },
      });
      const fiber = yield* service
        .invoke(action((yield* service.snapshot)[0]!))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => signal !== undefined);
      yield* Fiber.interrupt(fiber);
      expect(signal?.aborted).toBe(true);
      pending.resolve(undefined);
    }),
  );
  it.effect("cannot revive a revoked token and contains rejected producer actions", () =>
    Effect.gen(function* () {
      const service = yield* ActivityService.make({ publish: () => undefined });
      const token = {};
      yield* service.receive(
        registration(token, () => Promise.reject(new Error("private producer error"))),
      );
      yield* Effect.flip(service.invoke(action((yield* service.snapshot)[0]!)));
      yield* service.receive({ ...registration(token), operation: "revoke" });
      yield* service.receive(registration(token));
      expect(yield* service.snapshot).toEqual([]);
    }),
  );
});
