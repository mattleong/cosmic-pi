import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { CodePreviewSchedulerService } from "pi-code-previews";
import { AgentDirectory } from "pi-cosmic-core/platform/agent-directory";
import { nodeFilePlatformLayer } from "pi-cosmic-core/platform/node-file";
import { LocalProcess, type HostShellSettings } from "./boundary/local-process.ts";
import { BackgroundTaskConfigStore, BackgroundTaskSettingsFiles } from "./config/store.ts";
import { BackgroundTaskService } from "./task/service.ts";
import type { BackgroundTaskNotice, BackgroundTaskProjection } from "./task/model.ts";

export interface BackgroundTaskSessionInput {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  /** Pi's shell settings when the session started, as its bash tool uses them. */
  readonly shell: HostShellSettings;
}

export const backgroundTaskLayer = (
  input: BackgroundTaskSessionInput,
  publish: (projection: BackgroundTaskProjection) => void,
  notify?: (notice: BackgroundTaskNotice) => void,
) => {
  const platform = Layer.merge(
    nodeFilePlatformLayer,
    AgentDirectory.layerFromHost(() => getAgentDir()),
  );
  const config = Layer.merge(
    BackgroundTaskConfigStore.layer({ cwd: input.cwd, projectTrusted: input.projectTrusted }),
    BackgroundTaskSettingsFiles.layer,
  ).pipe(Layer.provide(platform));
  return BackgroundTaskService.layer({ publish, ...(notify && { notify }) }).pipe(
    Layer.provideMerge(Layer.merge(config, Path.layer)),
    Layer.provide(LocalProcess.layerFor(input.shell)),
    Layer.merge(CodePreviewSchedulerService.layer),
  );
};

type BackgroundTaskApplicationLayer = ReturnType<typeof backgroundTaskLayer>;
export type BackgroundTaskApplication = Layer.Success<BackgroundTaskApplicationLayer>;
export type BackgroundTaskRuntimeError = Layer.Error<BackgroundTaskApplicationLayer>;
