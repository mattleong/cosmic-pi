import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import type { UsageController } from "../usage-controller.ts";
import type { FooterTextPrimitive } from "./protocol.ts";

export interface XaiUsageUiState {
  visible: boolean;
  text?: string;
  updatedAt?: number;
}

export function xaiUsageUiState(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  controller: UsageController,
): XaiUsageUiState {
  const text = controller.statusLine(ctx, cfg);
  return { visible: Boolean(text), text };
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
