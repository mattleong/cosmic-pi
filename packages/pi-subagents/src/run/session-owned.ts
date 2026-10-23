import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import type * as Scope from "effect/Scope";
import { SubagentRuntimeClosedError } from "./errors.ts";

/** A closing scope refuses new fibers: `forkIn` returns them interrupted, never started. */
export const isScopeClosed = (scope: Scope.Scope): boolean =>
  Predicate.isTagged(scope.state, "Closed");

/**
 * Hands claimed work to the session scope and waits for it under `restore`, so a cancelled caller
 * stops only its wait. Once the session is closing, the commit never starts and the caller learns
 * so; shutdown's leaf-first traversal reclaims whatever the claim left on its runs.
 */
export const commitSessionOwned = <A, E, R>(
  ownerScope: Scope.Scope,
  commit: Effect.Effect<A, E, R>,
  restore: <X, Y, Z>(effect: Effect.Effect<X, Y, Z>) => Effect.Effect<X, Y, Z>,
  onOwned?: () => void,
) =>
  Effect.suspend<A, E | SubagentRuntimeClosedError, R>(() =>
    isScopeClosed(ownerScope)
      ? Effect.fail(SubagentRuntimeClosedError.make({ message: "Parent session shut down." }))
      : Effect.forkIn(commit, ownerScope, { startImmediately: true }).pipe(
          Effect.tap(() => Effect.sync(() => onOwned?.())),
          Effect.flatMap((fiber) => restore(Fiber.join(fiber))),
        ),
  );

export const runSessionOwned = <C, E2, R2, A, E, R>(
  ownerScope: Scope.Scope,
  claim: Effect.Effect<C, E2, R2>,
  commit: (claimed: C) => Effect.Effect<A, E, R>,
  onOwned?: () => void,
): Effect.Effect<A, E | E2 | SubagentRuntimeClosedError, R | R2> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(claim, (claimed) =>
      commitSessionOwned(ownerScope, commit(claimed), restore, onOwned),
    ),
  );
