import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config/index.ts";
import * as MutableRef from "effect/MutableRef";
import { isUsingOAuthAtHostBoundary } from "../boundary/model-registry-auth.ts";
import {
  isXaiSubscriptionModel,
  visibleStatusLine,
  type XaiProjection,
} from "../usage/index.ts";
import type { CosmicFooterTextContribution as FooterTextPrimitive } from "pi-cosmic-ui/protocol";

export interface XaiUsageUiState {
  visible: boolean;
  text?: string;
  updatedAt?: number;
}

/** Projection-only state used by production renderers after Effect-owned synchronization. */
export function xaiUsageUiStateFromProjection(
  projection: MutableRef.MutableRef<XaiProjection>,
): XaiUsageUiState {
  const text = visibleStatusLine(projection);
  return text ? { visible: true, text } : { visible: false };
}

/** Public compatibility API: caller context and configuration remain authoritative guards. */
export function xaiUsageUiState(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  projection: MutableRef.MutableRef<XaiProjection>,
): XaiUsageUiState {
  if (!cfg.usage.enabled) return { visible: false };
  const model = ctx.model;
  const isUsingOAuth =
    model?.provider === "xai" && cfg.usage.showOnlyOnSubscriptionModels
      ? isUsingOAuthAtHostBoundary(ctx.modelRegistry, model)
      : false;
  if (!isXaiSubscriptionModel(ctx, cfg, isUsingOAuth)) return { visible: false };
  const text = MutableRef.get(projection).statusLine;
  return text ? { visible: true, text } : { visible: false };
}

export function xaiUsageFooterPrimitive(state: XaiUsageUiState): FooterTextPrimitive | undefined {
  if (!state.visible || !state.text) return undefined;
  return {
    kind: "text",
    id: "xai.usage",
    region: "details",
    text: state.text,
    // Drop reset suffixes in compact mode so bars stay readable.
    compactText: state.text.replace(/\s*\|\s*(?:7d|mo)\s*↺[^|]*/g, "").trim(),
    tone: "dim",
    priority: 60,
    order: 101,
  };
}
