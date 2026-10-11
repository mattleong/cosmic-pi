import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

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
