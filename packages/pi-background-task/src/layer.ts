import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { CodePreviewSchedulerService } from "pi-code-previews";
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

export const makeBackgroundTaskLayer = (
  input: BackgroundTaskSessionInput,
  publish: (projection: BackgroundTaskProjection) => void,
) => {
  const platform = Layer.merge(
    nodeFilePlatformLayer,
    AgentDirectory.layerFromHost(() => getAgentDir()),
  );
  const config = BackgroundTaskConfigStore.layer({
    cwd: input.cwd,
    projectTrusted: input.projectTrusted,
  }).pipe(Layer.provide(platform));
  return BackgroundTaskService.layer({ publish }).pipe(
    Layer.provideMerge(Layer.merge(config, Path.layer)),
    Layer.provide(LocalProcess.layer),
    Layer.merge(CodePreviewSchedulerService.layer),
  );
};

export type BackgroundTaskApplicationLayer = ReturnType<typeof makeBackgroundTaskLayer>;
export type BackgroundTaskApplication = Layer.Success<BackgroundTaskApplicationLayer>;
export type BackgroundTaskRuntimeError = Layer.Error<BackgroundTaskApplicationLayer>;
