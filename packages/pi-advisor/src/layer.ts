import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import {
  advisorControllerApplicationLayer,
  type AdvisorExtensionDependencies,
} from "./application/controller.ts";
import type { AdvisorHostBindings } from "./application/host-bindings.ts";
import { advisorPlatformLayer, type AdvisorEffectExecutor } from "./boundary/executor.ts";
import {
  ConfigRepository,
  configRepositoryLayer,
  configRepositoryTestLayer,
} from "./config-repository.ts";
import { FailureLogger, failureLoggerLayer, failureLoggerTestLayer } from "./failure-logger.ts";
import { HostNotifier, hostNotifierLayer } from "./host-notifier.ts";
import { PiCommandAdapter } from "./pi-command-adapter.ts";
import { AdvisorReviewQueueService, advisorReviewQueueServiceLayer } from "./review-queue.ts";
import { AdvisorRuntimeService, advisorRuntimeServiceLayer } from "./advisor-runtime.ts";

export interface AdvisorApplicationLayerOptions {
  readonly pi: ExtensionAPI;
  readonly executor: AdvisorEffectExecutor;
  readonly dependencies: AdvisorExtensionDependencies;
  readonly hostBindings: AdvisorHostBindings;
}

/** Sole composition root for one Advisor session application. */
export const makeAdvisorApplicationLayer = (options: AdvisorApplicationLayerOptions) => {
  const repositoryLayer = options.dependencies.loadConfig
    ? configRepositoryTestLayer(options.dependencies.loadConfig)
    : configRepositoryLayer;
  const loggerLayer = options.dependencies.logFailure
    ? failureLoggerTestLayer(options.dependencies.logFailure)
    : failureLoggerLayer;
  const dependenciesLayer = Layer.mergeAll(
    advisorRuntimeServiceLayer(options.executor),
    advisorReviewQueueServiceLayer,
    PiCommandAdapter.layer,
    repositoryLayer,
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
  | ConfigRepository
  | FailureLogger
  | HostNotifier
  | PiCommandAdapter;
