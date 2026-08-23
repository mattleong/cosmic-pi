import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import type { AdvisorExtensionDependencies } from "./application/controller-types.ts";
import { advisorControllerApplicationLayer } from "./application/lifecycle.ts";
import { advisorPlatformLayer, type AdvisorEffectExecutor } from "./boundary/executor.ts";
import type { AdvisorHostBindings } from "./boundary/host-bindings.ts";
import { configStoreLayer } from "./config/store.ts";
import { failureLoggerLayer } from "./logging/logger.ts";
import { advisorReviewQueueServiceLayer } from "./queue/service.ts";
import { advisorChildFactoryLayer, advisorRuntimeServiceLayer } from "./runtime/runtime.ts";

export interface AdvisorApplicationLayerOptions {
  readonly pi: ExtensionAPI;
  readonly executor: AdvisorEffectExecutor;
  readonly dependencies: AdvisorExtensionDependencies;
  readonly hostBindings: AdvisorHostBindings;
}

/** Sole composition root for one Advisor session application. */
export const makeAdvisorApplicationLayer = (options: AdvisorApplicationLayerOptions) => {
  const resolvedConfigStoreLayer = options.dependencies.configStore ?? configStoreLayer;
  const loggerLayer = options.dependencies.failureLogger ?? failureLoggerLayer;
  const runtimeServiceLayer =
    options.dependencies.runtimeService ??
    advisorRuntimeServiceLayer(options.executor).pipe(Layer.provide(advisorChildFactoryLayer));
  const dependenciesLayer = Layer.mergeAll(
    runtimeServiceLayer,
    advisorReviewQueueServiceLayer,
    resolvedConfigStoreLayer,
    loggerLayer,
  ).pipe(Layer.provide(advisorPlatformLayer));

  return advisorControllerApplicationLayer(options).pipe(
    Layer.provide(dependenciesLayer),
    Layer.provideMerge(advisorPlatformLayer),
  );
};
