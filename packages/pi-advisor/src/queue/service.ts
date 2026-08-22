import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { AdvisorRuntimeServiceContract } from "../runtime/runtime.ts";
import {
  makeAdvisorReviewQueue,
  type AdvisorReviewQueue,
  type AdvisorReviewQueueOptions,
} from "./review-queue.ts";

export {
  makeAdvisorReviewQueue,
  MAX_PENDING_CHECKPOINTS,
  type AdvisorReviewQueue,
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
      make: (runtime, options) =>
        makeAdvisorReviewQueue(runtime, options).pipe(Effect.provideService(Scope.Scope, scope)),
    });
  }),
);
