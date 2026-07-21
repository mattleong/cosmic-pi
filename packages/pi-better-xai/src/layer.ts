import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { AgentDirectory, nodePlatformLayer } from "pi-cosmic-core";
import { XaiUsageService, type XaiProjection } from "./usage-controller.ts";

/** Plain session values captured by the Pi adapter before runtime construction. */
export interface XaiSessionInput {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly generation: number;
  readonly projectTrusted: boolean;
}

export interface XaiApplicationLayerOptions {
  readonly projection: MutableRef.MutableRef<XaiProjection>;
  readonly onChange: (context: MutableRef.MutableRef<ExtensionContext>) => void;
}

/** Compose the complete Better xAI application dependency graph for one Pi session. */
export const makeXaiApplicationLayer = (
  { cwd, context, projectTrusted }: XaiSessionInput,
  options: XaiApplicationLayerOptions,
) => {
  const platform = Layer.merge(
    nodePlatformLayer,
    AgentDirectory.layerFromHost(() => getAgentDir()),
  );
  return XaiUsageService.layer({
    context,
    cwd,
    projection: options.projection,
    projectTrusted,
    onChange: () => options.onChange(context),
  }).pipe(Layer.provide(platform));
};

export type XaiApplicationLayer = ReturnType<typeof makeXaiApplicationLayer>;
export type XaiApplication = Layer.Success<XaiApplicationLayer>;
export type XaiRuntimeError = Layer.Error<XaiApplicationLayer>;
