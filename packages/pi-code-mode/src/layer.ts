/** Effect composition root for one Code Mode session runtime. */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import type { CodeModeResults } from "./results/service.ts";
import type { CodePreviewSchedulerService } from "pi-code-previews";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { CodeModeConfigStore, type CodeModeState } from "./config/store.ts";

export interface CodeModeLayerInput {
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

export const makeCodeModeLayer = (
  input: CodeModeLayerInput,
  publish: (state: CodeModeState) => void,
) => {
  const platform = Layer.merge(
    nodeFilePlatformLayer,
    AgentDirectory.layerFromHost(() => getAgentDir()),
  );
  return CodeModeConfigStore.layer({
    cwd: input.cwd,
    projectTrusted: input.projectTrusted,
    publish,
  }).pipe(Layer.provide(platform));
};

export type CodeModeApplication =
  | Layer.Success<ReturnType<typeof makeCodeModeLayer>>
  | CodePreviewSchedulerService
  | CodeModeResults;
export type CodeModeRuntimeError = Layer.Error<ReturnType<typeof makeCodeModeLayer>>;
