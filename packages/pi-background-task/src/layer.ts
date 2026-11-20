import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { CodePreviewSchedulerService } from "pi-code-previews";
import { AgentDirectory } from "pi-cosmic-core/platform/agent-directory";
import { nodeFilePlatformLayer } from "pi-cosmic-core/platform/node-file";
import { LocalProcess } from "./boundary/local-process.ts";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "./config/schema.ts";
import { BackgroundTaskConfigStore, BackgroundTaskSettingsFiles } from "./config/store.ts";
import { BackgroundTaskService, type BackgroundTaskServiceOptions } from "./task/service.ts";

export const backgroundTaskHostLayer = (input: {
  readonly cwd: string;
  readonly projectTrusted: boolean;
}) =>
  Layer.mergeAll(
    BackgroundTaskConfigStore.layer(input),
    BackgroundTaskSettingsFiles.layer,
    CodePreviewSchedulerService.layer,
  ).pipe(
    Layer.provide(Layer.merge(nodeFilePlatformLayer, AgentDirectory.layerFromHost(getAgentDir))),
  );

export const backgroundTaskOwnerLayer = (options: BackgroundTaskServiceOptions) =>
  BackgroundTaskService.layer(options).pipe(
    Layer.provideMerge(Path.layer),
    Layer.provide(LocalProcess.layer),
    Layer.provide(Layer.succeed(BackgroundTaskConfigStore, DEFAULT_BACKGROUND_TASK_CONFIG)),
  );
