import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import {
  initialUsageProjection,
  isUsingOAuthAtHostBoundary,
  makeFrozenUsageProjection,
  resetFrozenUsageProjection,
  synchronizeUsageProjectionContext,
  withUsageEligibility,
  type UsageEligibilityStatusTexts,
  type UsageProjectionBase,
} from "pi-cosmic-core";
import type { ResolvedConfig } from "../config/schema.ts";
import { usageScopeForModel, type UsageSnapshot } from "./format.ts";

export interface OpenAIProjection extends UsageProjectionBase<ResolvedConfig, UsageSnapshot> {
  readonly accountId: string | undefined;
}

export const initialProjection = (): OpenAIProjection => ({
  ...initialUsageProjection<ResolvedConfig, UsageSnapshot>(),
  accountId: undefined,
});

export const makeProjection = () => makeFrozenUsageProjection(initialProjection);

export const resetProjection = (projection: MutableRef.MutableRef<OpenAIProjection>): void =>
  resetFrozenUsageProjection(projection, initialProjection);

export function usageConfigChanged(left: ResolvedConfig, right: ResolvedConfig): boolean {
  return (
    left.usage.refreshIntervalMs !== right.usage.refreshIntervalMs ||
    left.usage.showOnlyOnSubscriptionModels !== right.usage.showOnlyOnSubscriptionModels ||
    left.usage.showResetTimes !== right.usage.showResetTimes
  );
}

export function isOpenAISubscriptionModel(ctx: ExtensionContext, cfg: ResolvedConfig): boolean {
  const model = ctx.model;
  if (!model || (model.provider !== "openai" && model.provider !== "openai-codex")) return false;
  return (
    !cfg.usage.showOnlyOnSubscriptionModels || isUsingOAuthAtHostBoundary(ctx.modelRegistry, model)
  );
}

export const HIDDEN_USAGE_STATUS_TEXT =
  "Usage hidden: current model is not an OpenAI subscription model.";

interface OpenAIUsageDecision {
  readonly eligible: boolean;
  readonly clearUsage: boolean;
  readonly statusTexts: UsageEligibilityStatusTexts;
}

function openAIUsageDecision(
  state: OpenAIProjection,
  ctx: ExtensionContext,
  clearUsageRequested: boolean,
): OpenAIUsageDecision {
  try {
    const eligible = state.config ? isOpenAISubscriptionModel(ctx, state.config) : false;
    const scopeMatches = state.snapshot?.scope === usageScopeForModel(ctx.model?.id);
    return {
      eligible,
      clearUsage: clearUsageRequested || !scopeMatches,
      statusTexts: { hiddenStatusText: HIDDEN_USAGE_STATUS_TEXT },
    };
  } catch {
    return {
      eligible: false,
      clearUsage: true,
      statusTexts: {
        hiddenStatusText: "Usage unavailable.",
        unavailableStatusText: "Usage unavailable.",
      },
    };
  }
}

export function synchronizedProjection(
  state: OpenAIProjection,
  ctx: ExtensionContext,
  clearUsage: boolean,
): OpenAIProjection {
  const decision = openAIUsageDecision(state, ctx, clearUsage);
  return withUsageEligibility(state, decision.eligible, decision.clearUsage, decision.statusTexts);
}

export function synchronizeProjectionContext(
  projection: MutableRef.MutableRef<OpenAIProjection>,
  ctx: ExtensionContext,
): void {
  synchronizeUsageProjectionContext(projection, (state) => openAIUsageDecision(state, ctx, true));
}

export function visibleStatusLine(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  projection: MutableRef.MutableRef<OpenAIProjection>,
): string | undefined {
  if (!isOpenAISubscriptionModel(ctx, cfg)) return undefined;
  const state = MutableRef.get(projection);
  return state.snapshot?.scope === usageScopeForModel(ctx.model?.id) ? state.statusLine : undefined;
}
