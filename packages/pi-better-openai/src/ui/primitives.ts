import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import { supportsFast, type FastController } from "../fast-controller.ts";
import type * as MutableRef from "effect/MutableRef";
import { visibleStatusLine, type OpenAIProjection } from "../usage-controller.ts";
import type { CosmicFooterTextContribution as FooterTextPrimitive } from "pi-cosmic-ui/protocol";

export interface FastModeUiState {
  desired: boolean;
  active: boolean;
  supported: boolean;
  modelId?: string;
}

export interface OpenAIUsageUiState {
  visible: boolean;
  text?: string;
  updatedAt?: number;
}

export function fastModeUiState(
  ctx: ExtensionContext,
  controller: FastController,
): FastModeUiState {
  return {
    desired: controller.desiredActive,
    active: controller.active,
    supported: supportsFast(ctx),
    ...(ctx.model?.id ? { modelId: ctx.model.id } : {}),
  };
}

export function fastModeFooterPrimitive(state: FastModeUiState): FooterTextPrimitive | undefined {
  if (!state.active) return undefined;
  return {
    kind: "text",
    id: "openai.fast",
    region: "identity",
    text: "fast",
    tone: "success",
    priority: 80,
    order: 110,
  };
}

export function openAIUsageUiState(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  projection: MutableRef.MutableRef<OpenAIProjection>,
): OpenAIUsageUiState {
  const text = visibleStatusLine(ctx, cfg, projection);
  return text ? { visible: true, text } : { visible: false };
}

export function openAIUsageFooterPrimitive(
  state: OpenAIUsageUiState,
): FooterTextPrimitive | undefined {
  if (!state.visible || !state.text) return undefined;
  return {
    kind: "text",
    id: "openai.usage",
    region: "details",
    text: state.text,
    compactText: state.text.replace(/\s*\([^)]*\)/g, ""),
    tone: "dim",
    priority: 60,
    order: 100,
  };
}
