import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { AgentDirectory, nodePlatformLayer } from "pi-cosmic-core";
import { XaiUsageService, type XaiUsageServiceOptions } from "./usage/controller.ts";

/** Plain session values captured by the Pi adapter before runtime construction. */
export interface XaiSessionInput {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly projectTrusted: boolean;
  readonly publicationOwner: MutableRef.MutableRef<boolean>;
}

/** Compose the complete Better xAI application dependency graph for one Pi session. */
export const makeXaiApplicationLayer = (
  { cwd, context, projectTrusted, publicationOwner }: XaiSessionInput,
  options: Required<Pick<XaiUsageServiceOptions, "projection" | "onChange" | "isUsageVisible">>,
) =>
  XaiUsageService.layer({
    ...options,
    cwd,
    context,
    projectTrusted,
    canPublish: () => MutableRef.get(publicationOwner),
  }).pipe(Layer.provide(Layer.merge(nodePlatformLayer, AgentDirectory.layerFromHost(getAgentDir))));

export type XaiApplication = Layer.Success<ReturnType<typeof makeXaiApplicationLayer>>;
export type XaiRuntimeError = Layer.Error<ReturnType<typeof makeXaiApplicationLayer>>;
