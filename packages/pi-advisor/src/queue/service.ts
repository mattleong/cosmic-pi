import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { AdvisorRuntimeServiceContract } from "../runtime/runtime.ts";
import { initialReviewQueueState } from "./state.ts";
import {
  AdvisorReviewQueue,
  MAX_PENDING_CHECKPOINTS,
  type AdvisorReviewQueueOptions,
  type QueuedCheckpoint,
} from "./review-queue.ts";

export {
  MAX_PENDING_CHECKPOINTS,
  AdvisorReviewQueue,
  type ReviewQueueCheckpointRequest,
  type QueuedCheckpoint,
  type AdvisorReprimeState,
  type AdvisorReviewQueueOptions,
} from "./review-queue.ts";
export interface AdvisorReviewQueueServiceContract {
  readonly make: (
    runtime: AdvisorRuntimeServiceContract,
    options?: AdvisorReviewQueueOptions,
  ) => Effect.Effect<AdvisorReviewQueue>;
}
export class AdvisorReviewQueueService extends Context.Service<
  AdvisorReviewQueueService,
  AdvisorReviewQueueServiceContract
>()("pi-advisor/queue/service/AdvisorReviewQueueService") {}

export const advisorReviewQueueServiceLayer = Layer.effect(
  AdvisorReviewQueueService,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    return AdvisorReviewQueueService.of({
      make: (runtime, options = {}) =>
        Effect.gen(function* () {
          const state = yield* SynchronizedRef.make(initialReviewQueueState());
          const requestQueue = yield* Queue.dropping<QueuedCheckpoint>(MAX_PENDING_CHECKPOINTS + 1);
          const resourceScope = yield* Scope.fork(scope);
          const queue = new AdvisorReviewQueue(
            runtime,
            options,
            resourceScope,
            state,
            requestQueue,
          );
          yield* queue.initializeEffect();
          return queue;
        }),
    });
  }),
);
