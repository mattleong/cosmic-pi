import * as MutableRef from "effect/MutableRef";
import { visibleStatusLine, type XaiProjection } from "../usage/index.ts";
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
