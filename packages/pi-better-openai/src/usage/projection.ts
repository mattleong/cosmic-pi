import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { freezeSnapshot, isUsingOAuthAtHostBoundary } from "pi-cosmic-core";
import type { ResolvedConfig } from "../config/schema.ts";
import type { UsageSnapshot } from "./format.ts";

export interface UsageProjectionBase<Resolved, Snapshot> {
  readonly config: Resolved | undefined;
  readonly eligible: boolean;
  readonly snapshot: Snapshot | undefined;
  readonly statusLine: string | undefined;
  readonly statusText: string;
  readonly error: string | undefined;
  readonly lastFetchAt: number | undefined;
  readonly updatedAt: number | undefined;
  readonly authPath: string | undefined;
  readonly authFound: boolean;
}

export const initialUsageProjection = <Resolved, Snapshot>(): UsageProjectionBase<
  Resolved,
  Snapshot
> => ({
  config: undefined,
  eligible: false,
  snapshot: undefined,
  statusLine: undefined,
  statusText: "Usage unavailable",
  error: undefined,
  lastFetchAt: undefined,
  updatedAt: undefined,
  authPath: undefined,
  authFound: false,
});

type UsageVisibilityFields = {
  readonly eligible: boolean;
  readonly snapshot: unknown;
  readonly statusLine: string | undefined;
  readonly error: string | undefined;
  readonly updatedAt: number | undefined;
  readonly statusText: string;
};

interface UsageEligibilityStatusTexts {
  readonly hiddenStatusText: string;
  readonly unavailableStatusText?: string;
}

export function withUsageEligibility<T extends UsageVisibilityFields>(
  current: T,
  eligible: boolean,
  clearUsage: boolean,
  options: UsageEligibilityStatusTexts,
): T {
  const unavailable = options.unavailableStatusText ?? "Usage unavailable";
  const statusText = eligible ? unavailable : options.hiddenStatusText;
  return {
    ...current,
    eligible,
    ...(clearUsage
      ? {
          snapshot: undefined,
          statusLine: undefined,
          error: undefined,
          updatedAt: undefined,
          statusText,
        }
      : eligible
        ? {}
        : { statusLine: undefined, error: undefined, statusText }),
  };
}

export interface OpenAIProjection extends UsageProjectionBase<ResolvedConfig, UsageSnapshot> {
  readonly accountId: string | undefined;
}

export const initialProjection = (): OpenAIProjection => ({
  ...initialUsageProjection<ResolvedConfig, UsageSnapshot>(),
  accountId: undefined,
});

export const usageProjectionRef = (): MutableRef.MutableRef<OpenAIProjection> =>
  MutableRef.make(freezeSnapshot(initialProjection()));

export const resetProjection = (projection: MutableRef.MutableRef<OpenAIProjection>): void => {
  MutableRef.set(projection, freezeSnapshot(initialProjection()));
};

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
    return {
      eligible,
      clearUsage: clearUsageRequested,
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

export function visibleStatusLine(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  projection: MutableRef.MutableRef<OpenAIProjection>,
): string | undefined {
  return isOpenAISubscriptionModel(ctx, cfg) ? MutableRef.get(projection).statusLine : undefined;
}
