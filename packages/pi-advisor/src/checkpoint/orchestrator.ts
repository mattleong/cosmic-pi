import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import type { AdvisorEffectExecutor, AdvisorPlatform } from "../boundary/executor.ts";

export interface AdvisorCheckpointHooks {
  readonly invalidate: () => void;
  readonly finalizeCancellation: () => void;
  readonly cancelActive: Effect.Effect<void, never, AdvisorPlatform>;
}

export interface AdvisorOrchestratedCheckpoint<A, E> {
  readonly invalidate: () => void;
  readonly cancel: () => void;
  readonly cancelEffect: Effect.Effect<void>;
  readonly settlement: Effect.Effect<Exit.Exit<A, E>>;
}

interface ActiveCheckpoint {
  readonly hooks: AdvisorCheckpointHooks;
  fiber: Fiber.Fiber<unknown, unknown> | undefined;
  cancellationFiber: Fiber.Fiber<void, never> | undefined;
  readonly cancellationDone: Deferred.Deferred<void>;
  cancellationClaimed: boolean;
  cancellationFinalized: boolean;
}

export interface CheckpointOrchestratorShape {
  readonly start: <A, E>(
    effect: Effect.Effect<A, E, AdvisorPlatform>,
    hooks: AdvisorCheckpointHooks,
  ) => AdvisorOrchestratedCheckpoint<A, E>;
  /** Cancels active work and completes only after owned checkpoint fibers settle. */
  readonly cancelAll: () => Effect.Effect<void>;
  readonly activeCount: () => number;
  readonly shutdown: Effect.Effect<void>;
}

/** Owns checkpoint fibers and their exact-once cancellation bookkeeping. */
export const makeCheckpointOrchestrator = (
  executor: AdvisorEffectExecutor,
): Effect.Effect<CheckpointOrchestratorShape, never, Scope.Scope | AdvisorPlatform> =>
  Effect.gen(function* () {
    const platform = yield* Effect.context<AdvisorPlatform>();
    const active = new Set<ActiveCheckpoint>();
    const cancelling = new Set<ActiveCheckpoint>();

    const finalize = (entry: ActiveCheckpoint): void => {
      if (entry.cancellationFinalized) return;
      entry.cancellationFinalized = true;
      try {
        entry.hooks.finalizeCancellation();
      } catch {
        // Caller bookkeeping cannot prevent owned fiber cleanup.
      }
    };
    const runCancellation = (entry: ActiveCheckpoint): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (entry.cancellationClaimed) return Deferred.await(entry.cancellationDone);
        entry.cancellationClaimed = true;
        try {
          entry.hooks.invalidate();
        } catch {
          // Invalidation is synchronous advisory bookkeeping; cancellation still owns cleanup.
        }
        cancelling.add(entry);
        return entry.hooks.cancelActive.pipe(
          Effect.provide(platform),
          Effect.catchCause(() => Effect.void),
          Effect.ensuring(
            Effect.sync(() => {
              cancelling.delete(entry);
            }).pipe(
              Effect.andThen(Deferred.succeed(entry.cancellationDone, undefined)),
              Effect.asVoid,
            ),
          ),
        );
      });
    const beginCancellation = (entry: ActiveCheckpoint): Fiber.Fiber<void, never> | undefined => {
      if (entry.cancellationFiber) return entry.cancellationFiber;
      try {
        const cancellationFiber = executor.fork(runCancellation(entry));
        entry.cancellationFiber = cancellationFiber;
        return cancellationFiber;
      } catch {
        // Scope finalization can still execute the unclaimed cancellation inline.
        return undefined;
      }
    };
    const start: CheckpointOrchestratorShape["start"] = (effect, hooks) => {
      const entry: ActiveCheckpoint = {
        hooks,
        fiber: undefined,
        cancellationFiber: undefined,
        cancellationDone: Deferred.makeUnsafe<void>(),
        cancellationClaimed: false,
        cancellationFinalized: false,
      };
      active.add(entry);
      const fiber = executor.fork(
        effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active.delete(entry);
            }),
          ),
        ),
      );
      entry.fiber = fiber;
      return {
        invalidate: hooks.invalidate,
        cancel: () => {
          beginCancellation(entry);
        },
        cancelEffect: Effect.suspend(() => {
          const cancellationFiber = beginCancellation(entry);
          return cancellationFiber
            ? Fiber.await(cancellationFiber).pipe(Effect.asVoid)
            : runCancellation(entry);
        }),
        settlement: Fiber.await(fiber),
      };
    };
    const cancelAll = (): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entries = [...active];
        const cancellationEntries = new Set([...cancelling, ...entries]);
        const checkpointFibers = entries.flatMap((entry) => (entry.fiber ? [entry.fiber] : []));
        // Layer finalization runs after the outer slot deactivates, so cancellation must be able
        // to execute inline without asking the deactivated executor to fork another fiber.
        const awaitCancellations = Effect.forEach(
          cancellationEntries,
          (entry) =>
            entry.cancellationFiber
              ? Fiber.await(entry.cancellationFiber).pipe(Effect.asVoid)
              : runCancellation(entry),
          { discard: true, concurrency: "unbounded" },
        );
        const interruptCheckpoints =
          checkpointFibers.length === 0
            ? Effect.void
            : Fiber.interruptAll(checkpointFibers).pipe(Effect.asVoid);
        return Effect.all([awaitCancellations, interruptCheckpoints], {
          discard: true,
          concurrency: "unbounded",
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              for (const entry of entries) finalize(entry);
            }),
          ),
        );
      });
    const shutdown = cancelAll();
    yield* Effect.addFinalizer(() => cancelAll());
    return {
      start,
      cancelAll,
      activeCount: () => active.size,
      shutdown,
    };
  });
