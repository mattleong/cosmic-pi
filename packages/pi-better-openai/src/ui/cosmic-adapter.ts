import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import type { FastController } from "../fast-controller.ts";
import type { UsageController } from "../usage-controller.ts";
import {
  fastModeFooterPrimitive,
  fastModeUiState,
  openAIUsageFooterPrimitive,
  openAIUsageUiState,
} from "./primitives.ts";
import {
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_PROTOCOL_VERSION,
  type BetterOpenAIFooterPrimitive,
} from "./protocol.ts";

const OWNER = "pi-better-openai";

export interface CosmicUiAdapter {
  readonly active: boolean;
  detectHost(): boolean;
  update(ctx: ExtensionContext, cfg: ResolvedConfig): void;
  shutdown(): void;
}

export function createCosmicUiAdapter(options: {
  pi: ExtensionAPI;
  fastController: FastController;
  usageController: UsageController;
}): CosmicUiAdapter {
  const { pi, fastController, usageController } = options;
  const events = (pi as ExtensionAPI & { events?: ExtensionAPI["events"] }).events;
  let hostActive = false;

  const upsert = (contribution: BetterOpenAIFooterPrimitive) => {
    events?.emit(COSMIC_UI_FOOTER_UPSERT, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: OWNER,
      contribution,
    });
  };
  const remove = (id?: string) => {
    events?.emit(COSMIC_UI_FOOTER_REMOVE, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: OWNER,
      id,
    });
  };

  return {
    get active() {
      return hostActive;
    },
    detectHost() {
      hostActive = false;
      events?.emit(COSMIC_UI_HOST_QUERY, {
        version: COSMIC_UI_PROTOCOL_VERSION,
        respond: () => {
          hostActive = true;
        },
      });
      return hostActive;
    },
    update(ctx, cfg) {
      if (!hostActive) return;
      const fast = fastModeFooterPrimitive(fastModeUiState(ctx, fastController));
      const usage = openAIUsageFooterPrimitive(openAIUsageUiState(ctx, cfg, usageController));
      if (fast) upsert(fast);
      else remove("openai.fast");
      if (usage) upsert(usage);
      else remove("openai.usage");
    },
    shutdown() {
      if (hostActive) remove();
      hostActive = false;
    },
  };
}
