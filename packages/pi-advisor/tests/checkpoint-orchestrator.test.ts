import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { standaloneAdvisorExecutor } from "../src/boundary/executor.ts";
import { makeCheckpointOrchestrator } from "../src/checkpoint-orchestrator.ts";

it.effect(
  "finalizes synchronous cancellation exactly once and interrupts owned checkpoint fibers",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeCheckpointOrchestrator(standaloneAdvisorExecutor);
        let invalidations = 0;
        let finalizations = 0;
        let activeCancels = 0;
        orchestrator.start(Effect.never, {
          invalidate: () => {
            invalidations += 1;
          },
          finalizeCancellation: () => {
            finalizations += 1;
          },
          cancelActive: Effect.sync(() => {
            activeCancels += 1;
          }),
        });

        expect(orchestrator.activeCount()).toBe(1);
        yield* orchestrator.cancelAll();
        yield* orchestrator.cancelAll();
        expect(invalidations).toBe(1);
        expect(finalizations).toBe(1);
        expect(activeCancels).toBe(1);

        yield* orchestrator.shutdown;
        expect(orchestrator.activeCount()).toBe(0);
      }),
    ),
);

it.effect("awaits delayed active cancellation exactly once before cancelAll settles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* makeCheckpointOrchestrator(standaloneAdvisorExecutor);
      const cancellationStarted = yield* Deferred.make<void>();
      const releaseCancellation = yield* Deferred.make<void>();
      let activeCancels = 0;
      orchestrator.start(Effect.never, {
        invalidate: () => undefined,
        finalizeCancellation: () => undefined,
        cancelActive: Effect.gen(function* () {
          activeCancels += 1;
          yield* Deferred.succeed(cancellationStarted, undefined);
          yield* Deferred.await(releaseCancellation);
        }),
      });

      const cancellation = yield* orchestrator.cancelAll().pipe(Effect.forkScoped);
      yield* Deferred.await(cancellationStarted);
      expect(activeCancels).toBe(1);
      expect(cancellation.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(releaseCancellation, undefined);
      yield* Fiber.join(cancellation);
      yield* orchestrator.cancelAll();
      expect(activeCancels).toBe(1);
    }),
  ),
);

it.effect("keeps per-checkpoint cancellation separate from global finalization", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* makeCheckpointOrchestrator(standaloneAdvisorExecutor);
      let invalidations = 0;
      let finalizations = 0;
      let activeCancels = 0;
      const checkpoint = orchestrator.start(Effect.never, {
        invalidate: () => {
          invalidations += 1;
        },
        finalizeCancellation: () => {
          finalizations += 1;
        },
        cancelActive: Effect.sync(() => {
          activeCancels += 1;
        }),
      });

      checkpoint.cancel();
      expect(invalidations).toBe(1);
      expect(activeCancels).toBe(1);
      expect(finalizations).toBe(0);
      yield* orchestrator.shutdown;
      expect(finalizations).toBe(1);
    }),
  ),
);
