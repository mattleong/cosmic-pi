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
  readonly authSource: "modelRegistry" | "authFile" | undefined;
  readonly accountId: string | undefined;
}

type OpenAIProjectionExtras = Pick<OpenAIProjection, "authSource" | "accountId">;

const initialExtras = (): OpenAIProjectionExtras => ({
  authSource: undefined,
  accountId: undefined,
});

export const initialProjection = (): OpenAIProjection => ({
  ...initialUsageProjection<ResolvedConfig, UsageSnapshot>(),
  ...initialExtras(),
});

export const makeProjection = (): MutableRef.MutableRef<OpenAIProjection> =>
  makeFrozenUsageProjection<ResolvedConfig, UsageSnapshot, OpenAIProjectionExtras>(initialExtras());

export const resetProjection = (projection: MutableRef.MutableRef<OpenAIProjection>): void => {
  resetFrozenUsageProjection(projection, initialExtras);
};

export function usageConfigChanged(left: ResolvedConfig, right: ResolvedConfig): boolean {
  return (
    left.usage.enabled !== right.usage.enabled ||
    left.usage.refreshIntervalMs !== right.usage.refreshIntervalMs ||
    left.usage.showOnlyOnSubscriptionModels !== right.usage.showOnlyOnSubscriptionModels ||
    left.usage.showResetTimes !== right.usage.showResetTimes
  );
}

export function isOpenAISubscriptionModel(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  isUsingOAuth?: boolean,
): boolean {
  const model = ctx.model;
  if (!model || (model.provider !== "openai" && model.provider !== "openai-codex")) return false;
  return (
    !cfg.usage.showOnlyOnSubscriptionModels ||
    (isUsingOAuth ?? isUsingOAuthAtHostBoundary(ctx.modelRegistry, model))
  );
}

export const HIDDEN_USAGE_STATUS_TEXT =
  "Usage hidden: current model is not an OpenAI subscription model.";

interface OpenAIUsageDecision {
  readonly eligible: boolean;
  readonly clear: boolean;
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
      clear: clearUsageRequested || !scopeMatches,
      statusTexts: { hiddenStatusText: HIDDEN_USAGE_STATUS_TEXT },
    };
  } catch {
    return {
      eligible: false,
      clear: true,
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
  return withUsageEligibility(state, decision.eligible, decision.clear, decision.statusTexts);
}

export function synchronizeProjectionContext(
  projection: MutableRef.MutableRef<OpenAIProjection>,
  ctx: ExtensionContext,
  options: { readonly clearUsage?: boolean } = {},
): void {
  synchronizeUsageProjectionContext(projection, (state) => {
    const decision = openAIUsageDecision(state, ctx, options.clearUsage === true);
    return {
      eligible: decision.eligible,
      clearUsage: decision.clear,
      statusTexts: decision.statusTexts,
    };
  });
}

export function visibleStatusLine(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  projection: MutableRef.MutableRef<OpenAIProjection>,
  isUsingOAuth?: boolean,
): string | undefined {
  if (!cfg.usage.enabled || !isOpenAISubscriptionModel(ctx, cfg, isUsingOAuth)) return undefined;
  const state = MutableRef.get(projection);
  return state.snapshot?.scope === usageScopeForModel(ctx.model?.id) ? state.statusLine : undefined;
}
