import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { runSessionOwned } from "../../src/run/session-owned.ts";

class ClaimRejected extends Data.TaggedError("ClaimRejected") {}

describe("runSessionOwned", () => {
  it.effect("fails the waiter with the claim error and never starts a commit", () =>
    Effect.gen(function* () {
      const ownerScope = yield* Scope.make();
      let commits = 0;
      const failure = yield* runSessionOwned(ownerScope, Effect.fail(new ClaimRejected()), () =>
        Effect.sync(() => void commits++),
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ClaimRejected);
      expect(commits).toBe(0);
      yield* Scope.close(ownerScope, Exit.void);
    }),
  );

  it.effect("keeps the owner-scoped commit running after the waiter is interrupted", () =>
    Effect.gen(function* () {
      const ownerScope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const commit = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Deferred.succeed(finished, undefined)),
        Effect.asVoid,
      );
      const waiter = yield* runSessionOwned(ownerScope, Effect.void, () => commit).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(waiter);
      expect(yield* Deferred.isDone(finished)).toBe(false);

      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(finished);
      yield* Scope.close(ownerScope, Exit.void);
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts the commit and the waiter when the owner scope closes", () =>
    Effect.gen(function* () {
      const ownerScope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const commit = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      );
      const waiter = yield* runSessionOwned(ownerScope, Effect.void, () => commit).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.await(started);
      yield* Scope.close(ownerScope, Exit.void);
      yield* Deferred.await(interrupted);
      const exit = yield* Fiber.await(waiter);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }).pipe(Effect.scoped),
  );
});
