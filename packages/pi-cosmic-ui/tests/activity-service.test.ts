import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import { ActivityService, type ActivityActionRequest } from "../src/activity/service.ts";
import { activityKey, type ActivityEnvelope, type ActivityItem } from "../src/activity/protocol.ts";
import type { ActivityRow } from "../src/activity/model.ts";
import { renderActivityWidget } from "../src/activity/widget.ts";
const promiseGate = <A>() => {
  const deferred = Deferred.makeUnsafe<A>();
  return {
    promise: Effect.runPromise(Deferred.await(deferred)),
    resolve: (value: A) => {
      Effect.runSync(Deferred.succeed(deferred, value));
    },
  };
};
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
describe("activity service", () => {
  it.effect("animates running work between elapsed-second updates", () =>
    Effect.gen(function* () {
      let rows: readonly ActivityRow[] = [];
      let rendered: readonly string[] = [];
      const service = yield* ActivityService.make({
        publish: (next) => {
          rows = next;
        },
        tick: (now) => {
          rendered = renderActivityWidget(rows, 80, 8, { now });
        },
      });
      yield* service.receive(registration({}));
      yield* TestClock.adjust("1 second");
      const first = rendered.join("\n");
      yield* TestClock.adjust("100 millis");
      expect(rendered.join("\n")).not.toBe(first);
      yield* service.receive({ ...registration({}), items: [{ ...item(), status: "done" }] });
      yield* TestClock.adjust("1 second");
      const finished = rendered.join("\n");
      yield* TestClock.adjust("1 second");
      expect(rendered.join("\n")).toBe(finished);
    }),
  );
  it.effect("detaches summaries and withdraws invalid snapshots before restoring valid ones", () =>
    Effect.gen(function* () {
      let projection: readonly ActivityRow[] = [];
      const service = yield* ActivityService.make({
        publish: (rows) => {
          projection = rows;
        },
      });
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
      expect(projection[0]?.title).toBe("safe");
      expect(projection[0]?.profile).toBe("scout");
      expect(Object.isFrozen(projection[0])).toBe(true);
      const invalid = yield* service
        .receive({
          ...registration(token),
          operation: "publish",
          items: [{ ...item(), status: "bogus" }],
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(invalid)).toBe(true);
      expect(projection).toEqual([]);
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
      expect(Exit.isFailure(yield* service.invoke(old).pipe(Effect.exit))).toBe(true);
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
      expect(Exit.isFailure(yield* service.invoke(second).pipe(Effect.exit))).toBe(true);
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
      expect(Exit.isFailure(yield* owned.service.invoke(owned.request).pipe(Effect.exit))).toBe(
        true,
      );
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
      const pending = promiseGate<string>();
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
      const pending = promiseGate<void>();
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
      const result = yield* service.invoke(action((yield* service.snapshot)[0]!)).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      yield* service.receive({ ...registration(token), operation: "revoke" });
      yield* service.receive(registration(token));
      expect(yield* service.snapshot).toEqual([]);
    }),
  );
});
