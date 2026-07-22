import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import {
  advisorPlatformLayer,
  standaloneAdvisorExecutor,
  type AdvisorEffectExecutor,
} from "../src/boundary/executor.ts";
import { makeCheckpointOrchestrator } from "../src/checkpoint/orchestrator.ts";

const makeTestCheckpointOrchestrator = (
  executor: AdvisorEffectExecutor = standaloneAdvisorExecutor,
) =>
  Effect.gen(function* () {
    const platform = yield* Layer.build(advisorPlatformLayer);
    return yield* makeCheckpointOrchestrator(executor).pipe(Effect.provide(platform));
  });

it.effect(
  "finalizes synchronous cancellation exactly once and interrupts owned checkpoint fibers",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestCheckpointOrchestrator();
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
      const orchestrator = yield* makeTestCheckpointOrchestrator();
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
      const orchestrator = yield* makeTestCheckpointOrchestrator();
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

it.effect("cancels inline when layer finalization runs after executor deactivation", () =>
  Effect.gen(function* () {
    let executorActive = true;
    let forks = 0;
    let activeCancels = 0;
    let finalizations = 0;
    const executor = {
      ...standaloneAdvisorExecutor,
      fork: (<A, E>(effect: Effect.Effect<A, E, never>) => {
        if (!executorActive) throw new Error("session executor is inactive");
        forks += 1;
        return standaloneAdvisorExecutor.fork(effect);
      }) as typeof standaloneAdvisorExecutor.fork,
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* makeTestCheckpointOrchestrator(executor);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            executorActive = false;
          }),
        );
        orchestrator.start(Effect.never, {
          invalidate: () => undefined,
          finalizeCancellation: () => {
            finalizations += 1;
          },
          cancelActive: Effect.sync(() => {
            activeCancels += 1;
          }),
        });
      }),
    );

    expect(forks).toBe(1);
    expect(activeCancels).toBe(1);
    expect(finalizations).toBe(1);
  }),
);

it.effect("contains a defective cancellation hook and still finalizes owned work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* makeTestCheckpointOrchestrator();
      let finalizations = 0;
      orchestrator.start(Effect.never, {
        invalidate: () => undefined,
        finalizeCancellation: () => {
          finalizations += 1;
        },
        cancelActive: Effect.die("hostile cancellation defect"),
      });

      yield* orchestrator.cancelAll();
      expect(finalizations).toBe(1);
      expect(orchestrator.activeCount()).toBe(0);
    }),
  ),
);
