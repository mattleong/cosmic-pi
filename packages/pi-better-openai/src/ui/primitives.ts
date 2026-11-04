import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import type { CosmicFooterTextContribution as FooterTextPrimitive } from "pi-cosmic-ui/protocol";
import type { ResolvedConfig } from "../config/schema.ts";
import { isFastActive, type FastSnapshot } from "../fast/controller.ts";
import { formatUsageStatus } from "../usage/format.ts";
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
    compactText: text,
    label: "OpenAI",
    tone: "dim",
    priority: 60,
    order: 100,
  };
}

/** The usage words Pi's own status line shows when Cosmic UI's footer is inactive. */
export function openAIUsageStatusText(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  projection: MutableRef.MutableRef<OpenAIProjection>,
): string | undefined {
  if (!visibleStatusLine(ctx, cfg, projection)) return undefined;
  const { snapshot } = MutableRef.get(projection);
  return snapshot ? formatUsageStatus(snapshot, cfg.usage, snapshot.capturedAt) : undefined;
}
