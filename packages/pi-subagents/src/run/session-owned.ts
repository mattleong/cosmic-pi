import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

/**
 * Runs `claim` under an uninterruptible mask, forks `commit(claimed)` into `ownerScope`
 * (started immediately), and joins that fiber with the caller's interruptibility restored.
 * Cancelling the waiter therefore never abandons a claimed transition, while closing
 * `ownerScope` still interrupts the commit. The optional total `onOwned` callback acknowledges
 * the fork inside that mask, before restoring waiter interruption; it must not throw.
 *
 * WARNING: `Effect.uninterruptibleMask` hands an identity `restore` to a caller that is already
 * uninterruptible, so such a caller keeps waiting on the commit even when interrupted.
 */
export const runSessionOwned = <C, E2, R2, A, E, R>(
  ownerScope: Scope.Scope,
  claim: Effect.Effect<C, E2, R2>,
  commit: (claimed: C) => Effect.Effect<A, E, R>,
  onOwned?: () => void,
): Effect.Effect<A, E | E2, R | R2> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(claim, (claimed) =>
      Effect.flatMap(
        Effect.forkIn(commit(claimed), ownerScope, { startImmediately: true }),
        (fiber) => Effect.sync(() => onOwned?.()).pipe(Effect.andThen(restore(Fiber.join(fiber)))),
      ),
    ),
  );
