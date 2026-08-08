import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import type { AdvisorExtensionDependencies } from "./application/controller-types.ts";
import { advisorControllerApplicationLayer } from "./application/lifecycle.ts";
import { advisorPlatformLayer, type AdvisorEffectExecutor } from "./boundary/executor.ts";
import type { AdvisorHostBindings } from "./boundary/host-bindings.ts";
import { PiCommandAdapter } from "./boundary/host-commands.ts";
import { HostNotifier, hostNotifierLayer } from "./boundary/host-notifier.ts";
import { ConfigStore, configStoreLayer } from "./config/store.ts";
import { FailureLogger, failureLoggerLayer } from "./logging/logger.ts";
import { AdvisorReviewQueueService, advisorReviewQueueServiceLayer } from "./queue/service.ts";
import { AdvisorRuntimeService, advisorRuntimeServiceLayer } from "./runtime/runtime.ts";

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
  const dependenciesLayer = Layer.mergeAll(
    advisorRuntimeServiceLayer(options.executor),
    advisorReviewQueueServiceLayer,
    PiCommandAdapter.layer,
    resolvedConfigStoreLayer,
    loggerLayer,
    hostNotifierLayer,
  ).pipe(Layer.provideMerge(advisorPlatformLayer));

  return advisorControllerApplicationLayer(options).pipe(Layer.provideMerge(dependenciesLayer));
};

export type AdvisorApplicationLayer = ReturnType<typeof makeAdvisorApplicationLayer>;
export type AdvisorApplication = Layer.Success<AdvisorApplicationLayer>;
export type AdvisorApplicationRequirements =
  | AdvisorRuntimeService
  | AdvisorReviewQueueService
  | ConfigStore
  | FailureLogger
  | HostNotifier
  | PiCommandAdapter;
