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

export function isXaiSubscriptionModel(ctx: ExtensionContext, cfg: ResolvedConfig): boolean {
  const model = ctx.model;
  if (!model || model.provider !== "xai") return false;
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
