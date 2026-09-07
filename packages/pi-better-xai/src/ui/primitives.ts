import type { XaiProjection } from "../usage/projection.ts";
import type { CosmicFooterTextContribution as FooterTextPrimitive } from "pi-cosmic-ui/protocol";

export function xaiUsageFooterPrimitive(state: XaiProjection): FooterTextPrimitive | undefined {
  const text = state.statusLine;
  if (!state.config || !state.eligible || !text) return undefined;
  return {
    kind: "text",
    id: "xai.usage",
    region: "details",
    text,
    // Drop reset suffixes in compact mode so bars stay readable.
    compactText: text.replace(/\s*\|\s*(?:7d|mo)\s*↺[^|]*/g, "").trim(),
    label: "xAI",
    tone: "dim",
    priority: 60,
    order: 101,
  };
}
