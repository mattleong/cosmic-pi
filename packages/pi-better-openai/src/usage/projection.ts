import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { freezeSnapshot, withUsageEligibility } from "pi-cosmic-core";
import { isModelUsingOAuth } from "../boundary/model-registry.ts";
import type { ResolvedConfig } from "../config/index.ts";
import { usageScopeForModel, type UsageSnapshot } from "./format.ts";

export interface OpenAIProjection {
  readonly config: ResolvedConfig | undefined;
  readonly eligible: boolean;
  readonly snapshot: UsageSnapshot | undefined;
  readonly statusLine: string | undefined;
  readonly statusText: string;
  readonly error: string | undefined;
  readonly lastFetchAt: number | undefined;
  readonly updatedAt: number | undefined;
  readonly authPath: string | undefined;
  readonly authFound: boolean;
  readonly authSource: "modelRegistry" | "authFile" | undefined;
  readonly accountId: string | undefined;
}

export const initialProjection = (): OpenAIProjection => ({
  config: undefined,
  eligible: false,
  snapshot: undefined,
  statusLine: undefined,
  statusText: "Usage unavailable.",
  error: undefined,
  lastFetchAt: undefined,
  updatedAt: undefined,
  authPath: undefined,
  authFound: false,
  authSource: undefined,
  accountId: undefined,
});

export const makeProjection = () => MutableRef.make(freezeSnapshot(initialProjection()));

export const resetProjection = (projection: MutableRef.MutableRef<OpenAIProjection>): void => {
  MutableRef.set(projection, freezeSnapshot(initialProjection()));
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
  return !cfg.usage.showOnlyOnSubscriptionModels || (isUsingOAuth ?? isModelUsingOAuth(ctx, model));
}

export function synchronizedProjection(
  state: OpenAIProjection,
  ctx: ExtensionContext,
  clearUsage: boolean,
): OpenAIProjection {
  try {
    const eligible = state.config ? isOpenAISubscriptionModel(ctx, state.config) : false;
    const scopeMatches = state.snapshot?.scope === usageScopeForModel(ctx.model?.id);
    return withUsageEligibility(state, eligible, clearUsage || !scopeMatches, {
      hiddenStatusText: "Usage hidden: current model is not an OpenAI subscription model.",
    });
  } catch {
    return withUsageEligibility(state, false, true, {
      hiddenStatusText: "Usage unavailable.",
      unavailableStatusText: "Usage unavailable.",
    });
  }
}

export function synchronizeProjectionContext(
  projection: MutableRef.MutableRef<OpenAIProjection>,
  ctx: ExtensionContext,
  options: { readonly clearUsage?: boolean } = {},
): void {
  MutableRef.set(
    projection,
    freezeSnapshot(
      synchronizedProjection(MutableRef.get(projection), ctx, options.clearUsage === true),
    ),
  );
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
