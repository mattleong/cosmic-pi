import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { AdvisorEffectExecutor, AdvisorPlatform } from "./boundary/executor.ts";

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

export class CheckpointOrchestrator extends Context.Service<
  CheckpointOrchestrator,
  CheckpointOrchestratorShape
>()("pi-advisor/checkpoint-orchestrator/CheckpointOrchestrator") {}

/** Owns checkpoint fibers and their exact-once cancellation bookkeeping. */
export const makeCheckpointOrchestrator = (
  executor: AdvisorEffectExecutor,
): Effect.Effect<CheckpointOrchestratorShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    let nextId = 0;
    const active = new Map<number, ActiveCheckpoint>();
    const cancelling = new Set<ActiveCheckpoint>();

    const finalize = (entry: ActiveCheckpoint): void => {
      if (entry.cancellationFinalized) return;
      entry.cancellationFinalized = true;
      entry.hooks.finalizeCancellation();
    };
    const beginCancellation = (entry: ActiveCheckpoint): Fiber.Fiber<void, never> => {
      if (entry.cancellationFiber) return entry.cancellationFiber;
      entry.hooks.invalidate();
      cancelling.add(entry);
      const cancellationFiber = executor.fork(
        entry.hooks.cancelActive.pipe(Effect.ensuring(Effect.sync(() => cancelling.delete(entry)))),
      );
      entry.cancellationFiber = cancellationFiber;
      return cancellationFiber;
    };
    const start: CheckpointOrchestratorShape["start"] = (effect, hooks) => {
      const id = ++nextId;
      const entry: ActiveCheckpoint = {
        hooks,
        fiber: undefined,
        cancellationFiber: undefined,
        cancellationFinalized: false,
      };
      active.set(id, entry);
      const fiber = executor.fork(
        effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active.delete(id);
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
        cancelEffect: Effect.suspend(() => Fiber.join(beginCancellation(entry))),
        settlement: Fiber.await(fiber),
      };
    };
    const cancelAll = (): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entries = [...active.values()];
        const cancellations = new Set(
          [...cancelling].flatMap((entry) =>
            entry.cancellationFiber ? [entry.cancellationFiber] : [],
          ),
        );
        for (const entry of entries) cancellations.add(beginCancellation(entry));
        const checkpointFibers = entries.flatMap((entry) => (entry.fiber ? [entry.fiber] : []));
        const awaitCancellations = Effect.forEach(cancellations, (fiber) => Fiber.join(fiber), {
          discard: true,
          concurrency: "unbounded",
        });
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
    return CheckpointOrchestrator.of({
      start,
      cancelAll,
      activeCount: () => active.size,
      shutdown,
    });
  });

export const checkpointOrchestratorLayer = (executor: AdvisorEffectExecutor) =>
  Layer.effect(CheckpointOrchestrator, makeCheckpointOrchestrator(executor));
