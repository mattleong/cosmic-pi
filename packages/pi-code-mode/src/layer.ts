/** Effect composition root for one Code Mode session runtime. */
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { CodeModeConfigStore, type CodeModeState } from "./config/store.ts";

export interface CodeModeSessionInput {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

export interface CodeModeLayerOptions {
  readonly publish: (state: CodeModeState) => void;
}

export const makeCodeModeLayer = (input: CodeModeSessionInput, options: CodeModeLayerOptions) => {
  const platform = Layer.merge(
    nodeFilePlatformLayer,
    AgentDirectory.layerFromHost(() => getAgentDir()),
  );
  return CodeModeConfigStore.layer({
    cwd: input.cwd,
    projectTrusted: input.projectTrusted,
    publish: options.publish,
  }).pipe(Layer.provide(platform));
};

export type CodeModeApplicationLayer = ReturnType<typeof makeCodeModeLayer>;
export type CodeModeApplication = Layer.Success<CodeModeApplicationLayer>;
export type CodeModeRuntimeError = Layer.Error<CodeModeApplicationLayer>;
