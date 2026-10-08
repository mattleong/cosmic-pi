import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { CodePreviewSchedulerService } from "pi-code-previews";
import * as MutableRef from "effect/MutableRef";
import { AgentDirectory, SafeFile, nodePlatformLayer } from "pi-cosmic-core";
import { OpenAICompactionClient } from "./boundary/openai-compaction.ts";
import { SharpAdapter } from "./boundary/sharp.ts";
import { OpenAICompactionService } from "./compaction/service.ts";
import { FastModeService } from "./fast/service.ts";
import { OpenAIImageService } from "./image/service.ts";
import { OpenAIUsageService } from "./usage/controller.ts";
import type { OpenAIProjection } from "./usage/projection.ts";
import type { FastSnapshot } from "./fast/controller.ts";

/** Plain session values captured by the Pi adapter before runtime construction. */
export interface OpenAISessionInput {
  readonly ctx: ExtensionContext;
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly publicationOwner: MutableRef.MutableRef<boolean>;
}

export interface OpenAIApplicationLayerOptions {
  readonly projection: MutableRef.MutableRef<OpenAIProjection>;
  readonly fastProjection: MutableRef.MutableRef<FastSnapshot>;
  readonly isUsageVisible: () => boolean;
  readonly onUsageChange: (context: MutableRef.MutableRef<ExtensionContext>) => void;
}

/** Compose the complete Better OpenAI dependency graph for one Pi session. */
export const makeOpenAIApplicationLayer = (
  { context, cwd, projectTrusted, publicationOwner }: OpenAISessionInput,
  options: OpenAIApplicationLayerOptions,
) => {
  const usage = OpenAIUsageService.layer({
    context,
    cwd,
    projection: options.projection,
    projectTrusted,
    canPublish: () => MutableRef.get(publicationOwner),
    onChange: () => options.onUsageChange(context),
    isUsageVisible: options.isUsageVisible,
  });
  const fast = FastModeService.layer({
    projection: options.fastProjection,
    canPublish: () => MutableRef.get(publicationOwner),
  }).pipe(Layer.provideMerge(usage));
  const image = OpenAIImageService.layer({ context, projection: options.projection }).pipe(
    Layer.provide(Layer.merge(SharpAdapter.layer, SafeFile.layer)),
  );
  const compaction = OpenAICompactionService.layer({
    context,
    projection: options.projection,
    fastProjection: options.fastProjection,
  }).pipe(Layer.provide(OpenAICompactionClient.layer(() => MutableRef.get(context).modelRegistry)));
  const platform = Layer.merge(
    nodePlatformLayer,
    AgentDirectory.layerFromHost(() => getAgentDir()),
  );
  return Layer.mergeAll(fast, image, compaction, CodePreviewSchedulerService.layer).pipe(
    Layer.provide(platform),
  );
};

export type OpenAIApplicationLayer = ReturnType<typeof makeOpenAIApplicationLayer>;
export type OpenAIApplication = Layer.Success<OpenAIApplicationLayer>;
export type OpenAIRuntimeError = Layer.Error<OpenAIApplicationLayer>;
