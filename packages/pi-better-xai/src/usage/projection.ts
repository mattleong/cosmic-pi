import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as MutableRef from "effect/MutableRef";
import {
  initialUsageProjection,
  invokeHostCallback,
  makeFrozenUsageProjection,
  resetFrozenUsageProjection,
  synchronizeUsageProjectionContext,
  type UsageProjectionBase,
} from "pi-cosmic-core";
import type { ResolvedConfig } from "../config/schema.ts";
import type { UsageSnapshot } from "./format.ts";

export const HIDDEN_USAGE_STATUS_TEXT =
  "Usage hidden: current model is not an xAI subscription model.";

export interface XaiProjection extends UsageProjectionBase<ResolvedConfig, UsageSnapshot> {
  readonly teamId: string | undefined;
}

export const initialXaiProjection = (): XaiProjection => ({
  ...initialUsageProjection<ResolvedConfig, UsageSnapshot>(),
  teamId: undefined,
});

export const makeProjection = () => makeFrozenUsageProjection(initialXaiProjection);

export const resetProjection = (projection: MutableRef.MutableRef<XaiProjection>): void =>
  resetFrozenUsageProjection(projection, initialXaiProjection);

/** Total eligibility: a throwing host model, provider, or registry read hides usage. */
export function isXaiSubscriptionModel(ctx: ExtensionContext, cfg: ResolvedConfig): boolean {
  const model = invokeHostCallback(() => {
    const current = ctx.model;
    return current?.provider === "xai" ? current : undefined;
  }, undefined);
  if (!model) return false;
  return (
    !cfg.usage.showOnlyOnSubscriptionModels ||
    invokeHostCallback(() => ctx.modelRegistry.isUsingOAuth(model), false)
  );
}

export const synchronizeProjectionContext = (
  projection: MutableRef.MutableRef<XaiProjection>,
  ctx: ExtensionContext,
): void =>
  synchronizeUsageProjectionContext(projection, (state) => ({
    eligible: state.config ? isXaiSubscriptionModel(ctx, state.config) : false,
    clearUsage: true,
    statusTexts: { hiddenStatusText: HIDDEN_USAGE_STATUS_TEXT },
  }));
