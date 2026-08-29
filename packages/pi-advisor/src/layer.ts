import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import type { AdvisorExtensionDependencies } from "./application/controller.ts";
import { advisorControllerApplicationLayer } from "./application/lifecycle/layer.ts";
import { advisorPlatformLayer, type AdvisorEffectExecutor } from "./boundary/executor.ts";
import { configStoreLayer } from "./config/store.ts";
import { failureLoggerLayer } from "./logging/logger.ts";
import { advisorChildFactoryLayer, advisorRuntimeServiceLayer } from "./runtime/runtime.ts";

export interface AdvisorApplicationLayerOptions {
  readonly pi: ExtensionAPI;
  readonly executor: AdvisorEffectExecutor;
  readonly dependencies: AdvisorExtensionDependencies;
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
    resolvedConfigStoreLayer,
    loggerLayer,
  ).pipe(Layer.provide(advisorPlatformLayer));

  return advisorControllerApplicationLayer(options).pipe(
    Layer.provide(dependenciesLayer),
    Layer.provideMerge(advisorPlatformLayer),
  );
};
