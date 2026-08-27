import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { LocalProcess } from "./boundary/local-process.ts";
import { BackgroundTaskConfigStore } from "./config/store.ts";
import { BackgroundTaskService } from "./task/service.ts";
import type { BackgroundTaskProjection } from "./task/model.ts";

export interface BackgroundTaskSessionInput {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

export interface BackgroundTaskLayerOptions {
  readonly publish: (projection: BackgroundTaskProjection) => void;
}

export const makeBackgroundTaskLayer = (
  input: BackgroundTaskSessionInput,
  options: BackgroundTaskLayerOptions,
) => {
  const platform = Layer.merge(
    nodeFilePlatformLayer,
    AgentDirectory.layerFromHost(() => getAgentDir()),
  );
  const config = BackgroundTaskConfigStore.layer({
    cwd: input.cwd,
    projectTrusted: input.projectTrusted,
  }).pipe(Layer.provide(platform));
  const dependencies = Layer.mergeAll(platform, config, LocalProcess.layer);
  return BackgroundTaskService.layer({ publish: options.publish }).pipe(
    Layer.provideMerge(dependencies),
  );
};

export type BackgroundTaskApplicationLayer = ReturnType<typeof makeBackgroundTaskLayer>;
export type BackgroundTaskApplication = Layer.Success<BackgroundTaskApplicationLayer>;
export type BackgroundTaskRuntimeError = Layer.Error<BackgroundTaskApplicationLayer>;
