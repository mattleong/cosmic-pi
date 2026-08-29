import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AdvisorChildFactory } from "./child-factory.ts";
import { makeAdvisorRuntimeOperations, type AdvisorRuntimeOperations } from "./session-runtime.ts";
import type { AdvisorToolRunner } from "./tools.ts";

export {
  MAX_ADVISOR_STATE_SUMMARY_CHARS,
  MAX_ADVISOR_CHECKPOINT_CHARS,
  MAX_ADVISOR_CHECKPOINT_ID_CHARS,
  MAX_ADVISOR_TOOL_ROUNDS,
  MAX_ADVISOR_STREAM_CHARS,
  DEFAULT_ADVISOR_SESSION_ABORT_TIMEOUT_MS,
  AdvisorCheckpointSchema,
  AdvisorRuntimeResetRequiredError,
  type AdvisorCheckpoint,
  type AdvisorCheckpointRequest,
  type AdvisorRuntimeStartOptions,
} from "./types.ts";
export {
  AdvisorChildFactory,
  advisorChildFactoryLayer,
  type AdvisorChildFactoryContract,
} from "./child-factory.ts";
export { parseAdvisorCheckpointEffect } from "./checkpoint-parse.ts";
export {
  AdvisorRuntime,
  makeAdvisorControlMailbox,
  makeAdvisorRuntimeOperations,
  type AdvisorRuntimeOperations,
  type ManagedAdvisorRuntimeOperations,
} from "./session-runtime.ts";
export { NoDiscoveryAdvisorResourceLoader } from "./resource-loader.ts";

export interface AdvisorRuntimeServiceContract extends AdvisorRuntimeOperations {}

export class AdvisorRuntimeService extends Context.Service<
  AdvisorRuntimeService,
  AdvisorRuntimeServiceContract
>()("pi-advisor/runtime/runtime/AdvisorRuntimeService") {}

export const advisorRuntimeServiceLayer = (toolRunner: AdvisorToolRunner) =>
  Layer.effect(
    AdvisorRuntimeService,
    Effect.acquireRelease(
      AdvisorChildFactory.use((childFactory) =>
        makeAdvisorRuntimeOperations(childFactory, toolRunner),
      ),
      (managed) => managed.dispose,
    ).pipe(Effect.map((managed) => AdvisorRuntimeService.of(managed.operations))),
  );
