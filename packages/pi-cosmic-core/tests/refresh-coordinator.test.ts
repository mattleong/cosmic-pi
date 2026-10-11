import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import {
  makeRefreshCoordinator,
  type RefreshRequest,
} from "../src/coordination/refresh-coordinator.ts";
import { interruptingScheduler } from "../testing.ts";

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
  it.effect("remains reusable across every scheduler interruption point in admission", () =>
    Effect.gen(function* () {
      for (let interruptAt = 1; interruptAt <= 100; interruptAt++) {
        const coordinator = yield* makeRefreshCoordinator();
        let checkpoints = 0;
        const admissionScheduler = interruptingScheduler(() => ++checkpoints === interruptAt);
        const owner = yield* coordinator
          .run({}, () => Effect.void)
          .pipe(Effect.provideService(Scheduler.Scheduler, admissionScheduler), Effect.forkScoped);
        yield* Fiber.await(owner);
        let reused = false;
        const retry = yield* coordinator
          .run({ force: true }, () =>
            Effect.sync(() => {
              reused = true;
            }),
          )
          .pipe(Effect.forkScoped);
        for (let turn = 0; turn < 20 && !reused; turn++) yield* Effect.yieldNow;
        expect(reused, `interruption checkpoint ${interruptAt}`).toBe(true);
        yield* Fiber.join(retry);
      }
    }),
  );

  it.effect(
    "interrupts joiner waiting without cancelling its owner or losing the merged request",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* makeRefreshCoordinator();
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
      const coordinator = yield* makeRefreshCoordinator();
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

  it.effect("executes a request merged while the follow-up is running", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeRefreshCoordinator();
      const started = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const followUpStarted = yield* Deferred.make<void>();
      const releaseFollowUp = yield* Deferred.make<void>();
      const requests: RefreshRequest[] = [];
      const operation = (request: RefreshRequest) =>
        Effect.gen(function* () {
          requests.push(request);
          if (requests.length === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(releaseFirst);
          } else if (requests.length === 2) {
            yield* Deferred.succeed(followUpStarted, undefined);
            yield* Deferred.await(releaseFollowUp);
          }
        });

      const owner = yield* coordinator.run({}, operation).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const queued = yield* coordinator.run({ force: true }, operation).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(followUpStarted);
      const late = yield* coordinator.run({ notify: true }, operation).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseFollowUp, undefined);
      yield* Fiber.join(owner);
      yield* Fiber.join(queued);
      yield* Fiber.join(late);
      expect(requests).toEqual([
        {},
        { force: true, notify: false },
        { force: false, notify: true },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("replays follow-up failure to late waiters and permits immediate reuse", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeRefreshCoordinator<string>();
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const followUpStarted = yield* Deferred.make<void>();
      const releaseFollowUp = yield* Deferred.make<void>();
      const requests: RefreshRequest[] = [];
      const operation = (request: RefreshRequest): Effect.Effect<void, string> =>
        Effect.gen(function* () {
          requests.push(request);
          if (requests.length === 1) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          } else if (requests.length === 2) {
            yield* Deferred.succeed(followUpStarted, undefined);
            yield* Deferred.await(releaseFollowUp);
            return yield* Effect.fail("follow-up-boom");
          }
        });

      const owner = yield* coordinator.run({}, operation).pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      const queued = yield* coordinator
        .run({ force: true }, operation)
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(followUpStarted);
      const late = yield* coordinator
        .run({ notify: true }, operation)
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseFollowUp, undefined);

      for (const fiber of [owner, queued, late]) {
        const exit = yield* Fiber.join(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
      }
      expect(requests).toEqual([{}, { force: true, notify: false }]);
      yield* coordinator.run({ force: true, notify: true }, operation);
      expect(requests).toEqual([{}, { force: true, notify: false }, { force: true, notify: true }]);
    }).pipe(Effect.scoped),
  );

  it.effect("replays typed owner failure to every waiter and permits retry", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeRefreshCoordinator<string>();
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
      const coordinator = yield* makeRefreshCoordinator();
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
