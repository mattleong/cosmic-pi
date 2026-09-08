import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as MutableRef from "effect/MutableRef";
import type { CosmicFooterTextContribution as FooterTextPrimitive } from "pi-cosmic-ui/protocol";
import type { ResolvedConfig } from "../config/schema.ts";
import { isFastActive, type FastSnapshot } from "../fast/controller.ts";
import { visibleStatusLine, type OpenAIProjection } from "../usage/projection.ts";

export function fastModeFooterPrimitive(
  ctx: ExtensionContext,
  snapshot: FastSnapshot,
): FooterTextPrimitive | undefined {
  if (!isFastActive(ctx, snapshot)) return undefined;
  return {
    kind: "text",
    id: "openai.fast",
    region: "identity",
    text: "⚡",
    compactText: "⚡",
    tone: "normal",
    color: "warning",
    // Prefix the effort entry when present; render the glyph standalone otherwise.
    decorates: "effort",
    priority: 80,
    order: 110,
  };
}

export function openAIUsageFooterPrimitive(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  projection: MutableRef.MutableRef<OpenAIProjection>,
): FooterTextPrimitive | undefined {
  const text = visibleStatusLine(ctx, cfg, projection);
  if (!text) return undefined;
  return {
    kind: "text",
    id: "openai.usage",
    region: "details",
    text,
    // The footer wraps provider windows and reset dates itself; keep the complete projection in
    // compact mode so a narrow terminal never silently loses a reset date.
    compactText: text,
    label: "OpenAI",
    tone: "dim",
    priority: 60,
    order: 100,
  };
}
