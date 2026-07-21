import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCosmicFooterClient } from "pi-cosmic-ui/client";
import type { ResolvedConfig } from "../config.ts";
import type { FastSnapshot } from "../fast-controller.ts";
import * as MutableRef from "effect/MutableRef";
import type { OpenAIProjection } from "../usage-controller.ts";
import {
  fastModeFooterPrimitive,
  fastModeUiState,
  openAIUsageFooterPrimitive,
  openAIUsageUiState,
} from "./primitives.ts";

export interface CosmicUiAdapter {
  readonly active: boolean;
  detectHost(): boolean;
  update(ctx: ExtensionContext, cfg: ResolvedConfig): void;
  shutdown(): void;
}
export function createCosmicUiAdapter(options: {
  pi: ExtensionAPI;
  fastProjection: MutableRef.MutableRef<FastSnapshot>;
  projection: MutableRef.MutableRef<OpenAIProjection>;
}): CosmicUiAdapter {
  const client = createCosmicFooterClient(options.pi.events, "pi-better-openai");
  return {
    get active() {
      return client.active;
    },
    detectHost: client.query,
    update(ctx, cfg) {
      if (!client.active) return;
      const fast = fastModeFooterPrimitive(
        fastModeUiState(ctx, MutableRef.get(options.fastProjection)),
      );
      const usage = openAIUsageFooterPrimitive(openAIUsageUiState(ctx, cfg, options.projection));
      if (fast) client.upsert(fast);
      else client.remove("openai.fast");
      if (usage) client.upsert(usage);
      else client.remove("openai.usage");
    },
    shutdown: client.shutdown,
  };
}
