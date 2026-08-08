import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { makeSynchronousIngress } from "pi-cosmic-core";
import type { AdvisorPlatform } from "../boundary/executor.ts";
import type { AdvisorToolRunner } from "./tools.ts";
import { AdvisorChildFactory } from "./child-factory.ts";
import { AdvisorRuntime } from "./session-runtime.ts";
import {
  type ActiveAdvisorChild,
  type AdvisorCheckpoint,
  type AdvisorCheckpointRequest,
  type AdvisorRuntimeStartOptions,
} from "./types.ts";
import { AdvisorModelError } from "./client.ts";

export {
  MAX_ADVISOR_STATE_SUMMARY_CHARS,
  MAX_ADVISOR_CHECKPOINT_CHARS,
  MAX_ADVISOR_CHECKPOINT_ID_CHARS,
  MAX_ADVISOR_TOOL_ROUNDS,
  MAX_ADVISOR_STREAM_CHARS,
  DEFAULT_ADVISOR_SESSION_ABORT_TIMEOUT_MS,
  AdvisorCheckpointWireSchema,
  AdvisorRuntimeResetRequiredError,
  type AdvisorCheckpoint,
  type AdvisorCheckpointRequest,
  type AdvisorRuntimeStartOptions,
} from "./types.ts";
export {
  AdvisorChildFactory,
  advisorChildFactoryLayer,
  type AdvisorChildFactoryShape,
} from "./child-factory.ts";
export { parseAdvisorCheckpointEffect } from "./checkpoint-parse.ts";
export { AdvisorRuntime } from "./session-runtime.ts";
export { NoDiscoveryAdvisorResourceLoader } from "./resource-loader.ts";

export interface AdvisorRuntimeServiceShape {
  readonly activeToolNames: () => readonly string[];
  readonly start: (options: AdvisorRuntimeStartOptions) => Effect.Effect<void, AdvisorModelError>;
  readonly checkpoint: (
    request: AdvisorCheckpointRequest,
  ) => Effect.Effect<AdvisorCheckpoint, AdvisorModelError>;
  readonly steer: (observations: string) => Effect.Effect<boolean, AdvisorModelError>;
  readonly reprime: (seed: string, stateSummary?: string) => Effect.Effect<void, AdvisorModelError>;
  readonly abort: () => Effect.Effect<void>;
  readonly dispose: () => Effect.Effect<void>;
}

export const makeAdvisorControlMailbox = (handle: () => Effect.Effect<void>) =>
  makeSynchronousIngress<void, never, never>({
    capacity: 1,
    overflow: "coalesce-latest",
    handle,
  }).pipe(Effect.orDie);

export class AdvisorRuntimeService extends Context.Service<
  AdvisorRuntimeService,
  AdvisorRuntimeServiceShape
>()("pi-advisor/runtime/runtime/AdvisorRuntimeService") {}

export const advisorRuntimeServiceLayer = (toolRunner: AdvisorToolRunner) =>
  Layer.effect(
    AdvisorRuntimeService,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const childFactory = yield* AdvisorChildFactory;
        const platform = yield* Effect.context<AdvisorPlatform>();
        let handleControl: () => Effect.Effect<void, never, AdvisorPlatform> = () => Effect.void;
        const controlMailbox = yield* makeAdvisorControlMailbox(() =>
          handleControl().pipe(Effect.provide(platform)),
        );
        const activeChild = yield* SynchronizedRef.make<ActiveAdvisorChild | undefined>(undefined);
        const lifecycleLock = yield* Semaphore.make(1);
        const runtime = new AdvisorRuntime(
          childFactory,
          toolRunner,
          scope,
          controlMailbox,
          activeChild,
          lifecycleLock,
        );
        handleControl = () => runtime.controlEffect();
        const provide = <A, E>(effect: Effect.Effect<A, E, AdvisorPlatform>) =>
          effect.pipe(Effect.provide(platform));
        return {
          runtime,
          service: AdvisorRuntimeService.of({
            activeToolNames: () => runtime.activeToolNames,
            start: (options) => provide(runtime.startEffect(options)),
            checkpoint: (request) => provide(runtime.checkpointEffect(request)),
            steer: (observations) => provide(runtime.steerEffect(observations)),
            reprime: (seed, stateSummary) => provide(runtime.reprimeEffect(seed, stateSummary)),
            abort: () => provide(runtime.abortEffect()),
            // The service is reused across branch/config restarts. Queue ownership ends at the
            // current child; terminal mailbox shutdown belongs only to the layer finalizer below.
            dispose: () => provide(runtime.disposeChildEffect()),
          }),
        };
      }),
      ({ runtime }) => runtime.disposeEffect(),
    ).pipe(Effect.map(({ service }) => service)),
  );
