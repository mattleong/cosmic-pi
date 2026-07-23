import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { AgentDirectory, SafeFile, nodePlatformLayer } from "pi-cosmic-core";
import { OpenAICompactionClient } from "./boundary/openai-compaction.ts";
import { SharpAdapter } from "./boundary/sharp.ts";
import { OpenAICompactionService } from "./compaction/service.ts";
import { FastModeService } from "./fast/service.ts";
import { FAST_SERVICE_TIER } from "./fast/models.ts";
import { OpenAIImageService } from "./image/index.ts";
import { OpenAIUsageService, type OpenAIProjection } from "./usage/index.ts";
import type { FastSnapshot } from "./fast/controller.ts";

/** Plain session values captured by the Pi adapter before runtime construction. */
export interface OpenAISessionInput {
  readonly ctx: ExtensionContext;
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly cwd: string;
  readonly generation: number;
  readonly projectTrusted: boolean;
}

export interface OpenAIApplicationLayerOptions {
  readonly projection: MutableRef.MutableRef<OpenAIProjection>;
  readonly fastProjection: MutableRef.MutableRef<FastSnapshot>;
  readonly onUsageChange: (context: MutableRef.MutableRef<ExtensionContext>) => void;
  readonly registerFastInjectionIngress: (
    offer: (event: { readonly model: string; readonly tier: string }) => void,
  ) => void;
}

/** Compose the complete Better OpenAI dependency graph for one Pi session. */
export const makeOpenAIApplicationLayer = (
  { context, cwd, projectTrusted }: OpenAISessionInput,
  options: OpenAIApplicationLayerOptions,
) => {
  const usage = OpenAIUsageService.layer({
    context,
    cwd,
    projection: options.projection,
    projectTrusted,
    onChange: () => options.onUsageChange(context),
  });
  const fast = FastModeService.layer({
    serviceTier: FAST_SERVICE_TIER,
    projection: options.fastProjection,
    registerInjectionIngress: options.registerFastInjectionIngress,
  }).pipe(Layer.provide(usage));
  const image = OpenAIImageService.layer({ context, projection: options.projection }).pipe(
    Layer.provide(Layer.merge(SharpAdapter.layer, SafeFile.layer)),
  );
  const compaction = OpenAICompactionService.layer({
    context,
    projection: options.projection,
  }).pipe(Layer.provide(OpenAICompactionClient.layer(() => MutableRef.get(context).modelRegistry)));
  const platform = Layer.merge(
    nodePlatformLayer,
    AgentDirectory.layerFromHost(() => getAgentDir()),
  );
  return Layer.mergeAll(usage, fast, image, compaction).pipe(Layer.provide(platform));
};

export type OpenAIApplicationLayer = ReturnType<typeof makeOpenAIApplicationLayer>;
export type OpenAIApplication = Layer.Success<OpenAIApplicationLayer>;
export type OpenAIRuntimeError = Layer.Error<OpenAIApplicationLayer>;
