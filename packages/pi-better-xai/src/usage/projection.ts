import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import {
  initialUsageProjection,
  makeFrozenUsageProjection,
  resetFrozenUsageProjection,
  synchronizeUsageProjectionContext,
  type UsageProjectionBase,
} from "pi-cosmic-core";
import { isUsingOAuthAtHostBoundary } from "../boundary/model-registry-auth.ts";
import type { ResolvedConfig } from "../config/index.ts";
import type { UsageSnapshot } from "./format.ts";

export const HIDDEN_USAGE_STATUS_TEXT =
  "Usage hidden: current model is not an xAI subscription model.";

export interface XaiProjection extends UsageProjectionBase<ResolvedConfig, UsageSnapshot> {
  readonly teamId: string | undefined;
}

type XaiProjectionExtras = Pick<XaiProjection, "teamId">;

const initialExtras = (): XaiProjectionExtras => ({ teamId: undefined });

export const initialXaiProjection = (): XaiProjection => ({
  ...initialUsageProjection<ResolvedConfig, UsageSnapshot>(),
  ...initialExtras(),
});

export const makeProjection = (): MutableRef.MutableRef<XaiProjection> =>
  makeFrozenUsageProjection<ResolvedConfig, UsageSnapshot, XaiProjectionExtras>(initialExtras());

export function resetProjection(projection: MutableRef.MutableRef<XaiProjection>): void {
  resetFrozenUsageProjection(projection, initialExtras);
}

export function isXaiSubscriptionModel(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  isUsingOAuth = false,
): boolean {
  const model = ctx.model;
  if (!model || model.provider !== "xai") return false;
  return !cfg.usage.showOnlyOnSubscriptionModels || isUsingOAuth;
}

export function synchronizeProjectionContext(
  projection: MutableRef.MutableRef<XaiProjection>,
  ctx: ExtensionContext,
  options: { readonly clearUsage?: boolean } = {},
): void {
  synchronizeUsageProjectionContext(projection, (state) => {
    const model = ctx.model;
    const isUsingOAuth =
      model?.provider === "xai" && state.config?.usage.showOnlyOnSubscriptionModels
        ? isUsingOAuthAtHostBoundary(ctx.modelRegistry, model)
        : false;
    return {
      eligible: state.config ? isXaiSubscriptionModel(ctx, state.config, isUsingOAuth) : false,
      clearUsage: options.clearUsage ?? false,
      statusTexts: { hiddenStatusText: HIDDEN_USAGE_STATUS_TEXT },
    };
  });
}

export function visibleStatusLine(
  projection: MutableRef.MutableRef<XaiProjection>,
): string | undefined {
  const state = MutableRef.get(projection);
  if (!state.config?.usage.enabled || !state.eligible) return undefined;
  return state.statusLine;
}
