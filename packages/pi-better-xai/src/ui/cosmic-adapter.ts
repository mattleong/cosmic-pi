import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCosmicFooterClient } from "pi-cosmic-ui/client";
import type { ResolvedConfig } from "../config.ts";
import type * as MutableRef from "effect/MutableRef";
import type { XaiProjection } from "../usage-controller.ts";
import { xaiUsageFooterPrimitive, xaiUsageUiStateFromProjection } from "./primitives.ts";

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
  const client = createCosmicFooterClient(options.pi.events, "pi-better-xai");
  return {
    get active() {
      return client.active;
    },
    detectHost: client.query,
    update(_ctx, _cfg) {
      if (!client.active) return;
      const usage = xaiUsageFooterPrimitive(xaiUsageUiStateFromProjection(options.projection));
      if (usage) client.upsert(usage);
      else client.remove("xai.usage");
    },
    shutdown: client.shutdown,
  };
}
