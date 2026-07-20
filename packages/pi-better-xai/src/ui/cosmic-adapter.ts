import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import type * as MutableRef from "effect/MutableRef";
import type { XaiProjection } from "../usage-controller.ts";
import { xaiUsageFooterPrimitive, xaiUsageUiState } from "./primitives.ts";
import {
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_PROTOCOL_VERSION,
  type BetterXaiFooterPrimitive,
} from "./protocol.ts";

const OWNER = "pi-better-xai";

export interface CosmicUiAdapter {
  readonly active: boolean;
  detectHost(): boolean;
  update(ctx: ExtensionContext, cfg: ResolvedConfig): void;
  shutdown(): void;
}

export function createCosmicUiAdapter(options: {
  pi: ExtensionAPI;
  projection: MutableRef.MutableRef<XaiProjection>;
}): CosmicUiAdapter {
  const { pi, projection } = options;
  const events = (pi as ExtensionAPI & { events?: ExtensionAPI["events"] }).events;
  let hostActive = false;

  const upsert = (contribution: BetterXaiFooterPrimitive) => {
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
      const usage = xaiUsageFooterPrimitive(xaiUsageUiState(ctx, cfg, projection));
      if (usage) upsert(usage);
      else remove("xai.usage");
    },
    shutdown() {
      if (hostActive) remove();
      hostActive = false;
    },
  };
}
