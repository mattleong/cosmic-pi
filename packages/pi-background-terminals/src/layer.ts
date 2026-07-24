import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { LocalProcess } from "./boundary/local-process.ts";
import { BackgroundTerminalConfigStore } from "./config/store.ts";
import { BackgroundTerminalService } from "./job/service.ts";
import type { BackgroundTerminalProjection } from "./job/model.ts";

export interface BackgroundTerminalSessionInput {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

export interface BackgroundTerminalLayerOptions {
  readonly publish: (projection: BackgroundTerminalProjection) => void;
}

export const makeBackgroundTerminalLayer = (
  input: BackgroundTerminalSessionInput,
  options: BackgroundTerminalLayerOptions,
) => {
  const platform = Layer.merge(
    nodeFilePlatformLayer,
    AgentDirectory.layerFromHost(() => getAgentDir()),
  );
  const config = BackgroundTerminalConfigStore.layer({
    cwd: input.cwd,
    projectTrusted: input.projectTrusted,
  }).pipe(Layer.provide(platform));
  const dependencies = Layer.mergeAll(platform, config, LocalProcess.layer);
  return BackgroundTerminalService.layer({ publish: options.publish }).pipe(
    Layer.provideMerge(dependencies),
  );
};

export type BackgroundTerminalApplicationLayer = ReturnType<typeof makeBackgroundTerminalLayer>;
export type BackgroundTerminalApplication = Layer.Success<BackgroundTerminalApplicationLayer>;
export type BackgroundTerminalRuntimeError = Layer.Error<BackgroundTerminalApplicationLayer>;
