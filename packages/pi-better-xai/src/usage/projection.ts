import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { freezeSnapshot, withUsageEligibility } from "pi-cosmic-core";
import { isUsingOAuthAtHostBoundary } from "../boundary/model-registry-auth.ts";
import type { ResolvedConfig } from "../config/index.ts";
import type { UsageSnapshot } from "./format.ts";

export interface XaiProjection {
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
  readonly teamId: string | undefined;
}

export const initialXaiProjection = (): XaiProjection => ({
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
  teamId: undefined,
});

export const makeProjection = (): MutableRef.MutableRef<XaiProjection> =>
  MutableRef.make(freezeSnapshot(initialXaiProjection()));

export function resetProjection(projection: MutableRef.MutableRef<XaiProjection>): void {
  MutableRef.set(projection, freezeSnapshot(initialXaiProjection()));
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
  const state = MutableRef.get(projection);
  const model = ctx.model;
  const isUsingOAuth =
    model?.provider === "xai" && state.config?.usage.showOnlyOnSubscriptionModels
      ? isUsingOAuthAtHostBoundary(ctx.modelRegistry, model)
      : false;
  const eligible = state.config ? isXaiSubscriptionModel(ctx, state.config, isUsingOAuth) : false;
  MutableRef.set(
    projection,
    freezeSnapshot(
      withUsageEligibility(state, eligible, options.clearUsage ?? false, {
        hiddenStatusText: "Usage hidden: current model is not an xAI subscription model.",
      }),
    ),
  );
}

export function visibleStatusLine(
  projection: MutableRef.MutableRef<XaiProjection>,
): string | undefined {
  const state = MutableRef.get(projection);
  if (!state.config?.usage.enabled || !state.eligible) return undefined;
  return state.statusLine;
}
