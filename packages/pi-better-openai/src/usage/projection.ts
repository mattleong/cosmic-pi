import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { freezeSnapshot } from "pi-cosmic-core/projection";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import type { ResolvedConfig } from "../config/schema.ts";
import type { UsageSnapshot } from "./format.ts";

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
  readonly accountId: string | undefined;
}

export const initialProjection = (): OpenAIProjection => ({
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
  accountId: undefined,
});

function withUsageEligibility(
  current: OpenAIProjection,
  eligible: boolean,
  clearUsage: boolean,
  hiddenStatusText: string,
): OpenAIProjection {
  const statusText = eligible ? "Usage unavailable" : hiddenStatusText;
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
  const model: Model<Api> | undefined = ctx.model;
  if (!model || (model.provider !== "openai" && model.provider !== "openai-codex")) return false;
  return (
    !cfg.usage.showOnlyOnSubscriptionModels ||
    invokeHostCallback(() => ctx.modelRegistry.isUsingOAuth(model), false)
  );
}

export const HIDDEN_USAGE_STATUS_TEXT = "Switch to an OpenAI subscription model to see usage";

export function synchronizedProjection(
  state: OpenAIProjection,
  ctx: ExtensionContext,
  clearUsage: boolean,
): OpenAIProjection {
  try {
    const eligible = state.config ? isOpenAISubscriptionModel(ctx, state.config) : false;
    return withUsageEligibility(state, eligible, clearUsage, HIDDEN_USAGE_STATUS_TEXT);
  } catch {
    return withUsageEligibility(state, false, true, "Usage unavailable");
  }
}

export function visibleStatusLine(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  projection: MutableRef.MutableRef<OpenAIProjection>,
): string | undefined {
  return isOpenAISubscriptionModel(ctx, cfg) ? MutableRef.get(projection).statusLine : undefined;
}
