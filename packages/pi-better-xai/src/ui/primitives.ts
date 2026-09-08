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
    // Provider reset dates remain part of the compact projection; Cosmic UI wraps them instead
    // of dropping the suffix on narrow terminals.
    compactText: text,
    label: "xAI",
    tone: "dim",
    priority: 60,
    order: 101,
  };
}
