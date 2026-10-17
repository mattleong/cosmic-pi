import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import {
  createRefreshCoordinator,
  type RefreshRequest,
} from "../src/coordination/refresh-coordinator.ts";

const gated = () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const requests: RefreshRequest[] = [];
    const operation = (request: RefreshRequest) =>
      Effect.gen(function* () {
        requests.push(request);
        if (requests.length === 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
        }
      });
    return { started, release, requests, operation };
  });

describe("RefreshCoordinator", () => {
  it.effect(
    "interrupts joiner waiting without cancelling its owner or losing the merged request",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* createRefreshCoordinator();
        const { started, release, requests, operation } = yield* gated();
        const owner = yield* coordinator.run({}, operation).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const joiner = yield* coordinator.run({ force: true }, operation).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(joiner);
        expect(requests).toEqual([{}]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        expect(requests).toEqual([{}, { force: true, notify: false }]);
        yield* coordinator.run({ notify: true }, operation);
        expect(requests).toEqual([{}, { force: true, notify: false }, { notify: true }]);
      }),
  );

  it.effect("coalesces force and notify into one follow-up", () =>
    Effect.gen(function* () {
      const coordinator = yield* createRefreshCoordinator();
      const { started, release, requests, operation } = yield* gated();
      const owner = yield* coordinator.run({}, operation).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const forced = yield* coordinator.run({ force: true }, operation).pipe(Effect.forkScoped);
      const notified = yield* coordinator.run({ notify: true }, operation).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
      yield* Fiber.join(forced);
      yield* Fiber.join(notified);
      expect(requests).toEqual([{}, { force: true, notify: true }]);
    }).pipe(Effect.scoped),
  );

  it.effect("replays typed owner failure to every waiter and permits retry", () =>
    Effect.gen(function* () {
      const coordinator = yield* createRefreshCoordinator<string>();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const failing = () =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return yield* Effect.fail("boom");
        });
      const owner = yield* coordinator.run({}, failing).pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(started);
      const waiter = yield* coordinator
        .run({ force: true }, failing)
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      const ownerExit = yield* Fiber.join(owner);
      const waiterExit = yield* Fiber.join(waiter);
      expect(Exit.isFailure(ownerExit)).toBe(true);
      expect(Exit.isFailure(waiterExit)).toBe(true);
      expect(calls).toBe(1);
      yield* coordinator.run({}, () => Effect.sync(() => calls++));
      expect(calls).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("replays interruption and does not run queued follow-up", () =>
    Effect.gen(function* () {
      const coordinator = yield* createRefreshCoordinator();
      const started = yield* Deferred.make<void>();
      let calls = 0;
      const operation = () =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        });
      const owner = yield* coordinator.run({}, operation).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const waiter = yield* coordinator.run({ force: true }, operation).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(owner);
      const waiterExit = yield* Fiber.await(waiter);
      expect(Exit.isFailure(waiterExit)).toBe(true);
      expect(calls).toBe(1);
    }).pipe(Effect.scoped),
  );
});
