import { describe, expect, it } from "@effect/vitest";
import assert from "node:assert/strict";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import { deferredPromise, yieldUntil } from "pi-cosmic-core/testing";
import {
  ActivityService,
  type ActivityActionRequest,
  type ActivityServiceOptions,
} from "../src/activity/service.ts";
import {
  ACTIVITY_LIMITS,
  ActivityEnvelopeSchema,
  activityKey,
  type ActivityEnvelope,
  type ActivityItem,
} from "../src/activity/protocol.ts";
import type { ActivityRow } from "../src/activity/model.ts";
const item = (revision = "1"): ActivityItem => ({
  id: "one",
  title: "Work",
  kind: "command",
  status: "running",
  revision,
  actions: [{ id: "stop", label: "Stop" }],
});
const throwingCallback = () => {
  throw new Error("private producer error");
};
// Hosts admit provider envelopes through the protocol schema.
const envelope = Schema.decodeUnknownSync(ActivityEnvelopeSchema);
const registration = (
  token: ActivityEnvelope["token"],
  invoke = () => Promise.resolve(),
  items: readonly ActivityItem[] = [item()],
): ActivityEnvelope =>
  envelope({
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
const recordingService = (connect?: ActivityServiceOptions["connect"]) =>
  Effect.gen(function* () {
    let rows: readonly ActivityRow[] = [];
    let starting = 0;
    let available = false;
    const service = yield* ActivityService.make({
      publish: (next, count) => {
        rows = next;
        starting = count;
      },
      ...(connect && { connect }),
    });
    const register = (
      items: ActivityEnvelope["items"],
      overrides: Partial<ActivityEnvelope> = {},
    ): ActivityEnvelope => ({
      ...registration({}),
      items,
      acknowledge: (next) => {
        available = next;
      },
      ...overrides,
    });
    const rejectsEach = (
      event: ActivityEnvelope,
      snapshots: ReadonlyArray<ActivityEnvelope["items"]>,
    ) =>
      Effect.forEach(
        snapshots,
        (items) =>
          Effect.gen(function* () {
            yield* service.receive(event);
            expect(available).toBe(true);
            expect(rows).not.toEqual([]);
            yield* Effect.flip(service.receive({ ...event, operation: "publish", items }));
            expect([rows, starting, available]).toEqual([[], 0, false]);
          }),
        { discard: true },
      );
    return {
      service,
      rows: () => rows,
      starting: () => starting,
      available: () => available,
      register,
      rejectsEach,
    };
  });
const near = (limit: number) => `${Fn.pipe("a", Str.repeat(limit - 8))} token=x`;

describe("activity service", () => {
  it.effect(
    "replaces an existing provider at capacity while rejecting an additional provider",
    () =>
      Effect.gen(function* () {
        const { service, rows } = yield* recordingService();
        const original = { ...registration({}), providerId: "provider-0" };
        yield* service.receive(original);
        const originalAction = action(rows()[0]!);
        for (let index = 1; index < 32; index++)
          yield* service.receive({ ...registration({}), providerId: `provider-${index}` });
        yield* service.receive({ ...registration({}), providerId: "additional" });
        expect(rows()).toHaveLength(32);
        expect(Arr.some(rows(), (row) => row.providerId === "additional")).toBe(false);
        let replacementAvailable = false;
        let invoked = false;
        yield* service.receive(
          envelope({
            ...original,
            token: {},
            acknowledge: (available: boolean) => {
              replacementAvailable = available;
            },
            invoke: () => {
              invoked = true;
              return Promise.resolve();
            },
          }),
        );
        expect(replacementAvailable).toBe(true);
        expect(rows()).toHaveLength(32);
        expect(yield* service.invoke(originalAction).pipe(Effect.flip)).toMatchObject({
          reason: "stale",
        });
        const replacement = Option.getOrThrow(
          Arr.findFirst(rows(), (row) => row.providerId === original.providerId),
        );
        yield* service.invoke(action(replacement));
        expect(invoked).toBe(true);
      }),
  );
  it.effect("withdraws a snapshot that throws while it is decoded", () =>
    Effect.gen(function* () {
      const { register, rejectsEach } = yield* recordingService();
      const hostile = new Proxy([], {
        get() {
          throw new Error("hostile snapshot");
        },
      });
      yield* rejectsEach(register([item()]), [hostile]);
    }),
  );
  it.effect("keeps each cleaned field within its own limit after redaction lengthens it", () =>
    Effect.gen(function* () {
      const { service, rows } = yield* recordingService();
      yield* service.receive(
        registration({}, undefined, [
          { ...item(), title: near(ACTIVITY_LIMITS.title), profile: near(ACTIVITY_LIMITS.profile) },
        ]),
      );
      const [row] = rows();
      assert.ok(row);
      assert.ok(row.profile);
      expect(row.title.length).toBeLessThanOrEqual(ACTIVITY_LIMITS.title);
      expect(row.profile.length).toBeLessThanOrEqual(ACTIVITY_LIMITS.profile);
      expect(`${row.title}${row.profile}`).not.toContain("token=x");
    }),
  );
  it.effect("rejects stale revisions, removed actions and replaced registration capabilities", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const { service, rows } = yield* recordingService();
      const token = {};
      yield* service.receive(
        registration(token, () => {
          calls.push("old");
          return Promise.resolve();
        }),
      );
      const old = action(rows()[0]!);
      yield* service.receive({ ...registration(token), operation: "publish", items: [item("2")] });
      yield* Effect.flip(service.invoke(old));
      const second = action(rows()[0]!);
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
      yield* service.invoke(action(rows()[0]!));
      expect(calls).toEqual(["new"]);
      expect(rows()[0]!.key).toBe(activityKey("tasks", "one"));
    }),
  );
  it.effect(
    "publishes a republished snapshot only when its content changed, whatever its revisions",
    () =>
      Effect.gen(function* () {
        const published: Array<readonly ActivityRow[]> = [];
        const service = yield* ActivityService.make({
          publish: (rows) => void published.push(rows),
        });
        const token = {};
        const other = { ...item(), id: "two", title: "Other" };
        const publish = (items: readonly ActivityItem[], starting?: number) =>
          service.receive({ ...registration(token), operation: "publish", items, starting });
        yield* service.receive(registration(token, undefined, [item(), other]));
        const accepted = published.length;
        const [first] = published.at(-1) ?? [];

        yield* publish([item(), { ...other, actions: [{ id: "stop", label: "Stop" }] }]);
        expect(published).toHaveLength(accepted);

        const renamed = { ...other, title: "Renamed" };
        const halted = { ...renamed, actions: [{ id: "stop", label: "Halt" }] };
        for (const changed of [renamed, halted]) {
          yield* publish([item(), changed]);
          expect(published.at(-1)?.[1]).toMatchObject({ title: "Renamed", revision: "1" });
        }
        expect(published.at(-1)?.[1]?.actions).toEqual(halted.actions);
        yield* publish([item(), halted], 1);
        expect(published).toHaveLength(accepted + 3);
        // The unchanged row is shared rather than copied into each publication.
        expect(published.at(-1)?.[0]).toBe(first);
      }),
  );
  it.effect("restores availability for a valid republish matching its withdrawn snapshot", () =>
    Effect.gen(function* () {
      const { service, available, register } = yield* recordingService();
      const event = register([]);
      yield* service.receive(event);
      yield* Effect.flip(service.receive({ ...event, operation: "publish", items: [{}] }));
      expect(available()).toBe(false);
      yield* service.receive({ ...event, operation: "publish", items: [] });
      expect(available()).toBe(true);
    }),
  );
  it.effect("revokes rows and actions on disposal and closes host resources exactly once", () =>
    Effect.gen(function* () {
      const availability: boolean[] = [];
      let releases = 0;
      const owned = yield* Effect.scoped(
        Effect.gen(function* () {
          const { service, rows } = yield* recordingService(() => () => {
            releases++;
          });
          yield* service.receive({
            ...registration({}),
            acknowledge: (value) => {
              availability.push(value);
            },
          });
          return { service, rows, request: action(rows()[0]!) };
        }),
      );
      expect(availability).toEqual([true, false]);
      expect(releases).toBe(1);
      expect(owned.rows()).toEqual([]);
      yield* Effect.flip(owned.service.invoke(owned.request));
    }),
  );
  it.effect("loads bounded redacted details lazily and rejects late stale results", () =>
    Effect.gen(function* () {
      const { service, rows } = yield* recordingService();
      const token = {};
      let calls = 0;
      yield* service.receive(
        envelope({
          ...registration(token),
          getDetail: () => {
            calls++;
            return Promise.resolve(`token=private-value\n${Fn.pipe("x", Str.repeat(20000))}`);
          },
        }),
      );
      expect(calls).toBe(0);
      const detail = yield* service.detail(action(rows()[0]!));
      expect(detail.length).toBeLessThanOrEqual(16384);
      expect(detail).not.toContain("private-value");
      expect(calls).toBe(1);
      const pending = deferredPromise<string>();
      let started = false;
      yield* service.receive(
        envelope({
          ...registration({}),
          getDetail: () => {
            started = true;
            return pending.promise;
          },
        }),
      );
      const fiber = yield* service.detail(action(rows()[0]!)).pipe(Effect.exit, Effect.forkScoped);
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
      const { service, rows } = yield* recordingService();
      let signal: AbortSignal | undefined;
      const pending = deferredPromise();
      yield* service.receive(
        envelope({
          ...registration({}),
          invoke: (_item: string, _action: string, _revision: string, value: AbortSignal) => {
            signal = value;
            return pending.promise;
          },
        }),
      );
      const fiber = yield* service.invoke(action(rows()[0]!)).pipe(Effect.forkScoped);
      yield* yieldUntil(() => signal !== undefined);
      yield* Fiber.interrupt(fiber);
      expect(signal?.aborted).toBe(true);
      pending.resolve(undefined);
    }),
  );
  it.effect("fails typed when a producer callback throws or returns a non-string detail", () =>
    Effect.gen(function* () {
      const { service, rows } = yield* recordingService();
      yield* service.receive(envelope({ ...registration({}), getDetail: () => 42 }));
      expect(yield* Effect.flip(service.detail(action(rows()[0]!)))).toMatchObject({
        reason: "invalid",
      });
      yield* service.receive(
        envelope({ ...registration({}, throwingCallback), getDetail: throwingCallback }),
      );
      expect(yield* Effect.flip(service.detail(action(rows()[0]!)))).toMatchObject({
        reason: "failed",
      });
      expect(yield* Effect.flip(service.invoke(action(rows()[0]!)))).toMatchObject({
        reason: "failed",
      });
      yield* service.receive(envelope({ ...registration({}), getDetail: () => "Ready" }));
      expect(yield* service.detail(action(rows()[0]!))).toBe("Ready");
    }),
  );
  it.effect("cannot revive a revoked token and contains rejected producer actions", () =>
    Effect.gen(function* () {
      const { service, rows } = yield* recordingService();
      const token = {};
      yield* service.receive(
        registration(token, () => Promise.reject(new Error("private producer error"))),
      );
      yield* Effect.flip(service.invoke(action(rows()[0]!)));
      yield* service.receive({ ...registration(token), operation: "revoke" });
      yield* service.receive(registration(token));
      expect(rows()).toEqual([]);
    }),
  );
  it.live("contains a rejected acknowledgement", () =>
    Effect.gen(function* () {
      const { service, rows } = yield* recordingService();
      const event = envelope({
        ...registration({}),
        acknowledge: () => Promise.reject(new Error("private producer error")),
      });
      yield* service.receive(event);
      expect(rows()).toHaveLength(1);
      yield* service.receive({ ...event, operation: "revoke" });
      expect(rows()).toEqual([]);
      // Vitest fails the run on an unhandled rejection; let it surface before the test ends.
      yield* Effect.sleep("1 millis");
    }),
  );
});
