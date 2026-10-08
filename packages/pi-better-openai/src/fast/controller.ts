import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { freezeSnapshot } from "pi-cosmic-core";
import { FAST_SERVICE_TIER, supportsFastModel } from "./models.ts";

export interface FastSnapshot {
  readonly desiredActive: boolean;
  readonly active: boolean;
  readonly lastInjectedModel?: string;
  readonly lastInjectedTier?: string;
}

export const initialFastSnapshot = (): FastSnapshot =>
  freezeSnapshot({ desiredActive: false, active: false });
export const currentModelKey = (ctx: ExtensionContext): string =>
  ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
export const supportsFast = (ctx: ExtensionContext): boolean =>
  supportsFastModel(ctx.model?.provider, ctx.model?.id);
export const isFastActive = (ctx: ExtensionContext, snapshot: FastSnapshot): boolean =>
  snapshot.desiredActive && supportsFast(ctx);

export function fastStateText(ctx: ExtensionContext, snapshot: FastSnapshot): string {
  if (isFastActive(ctx, snapshot)) return `Fast mode is on for ${currentModelKey(ctx)}`;
  if (snapshot.desiredActive)
    return `Fast mode turns on when you switch from ${currentModelKey(ctx)} to an OpenAI model`;
  return "Fast mode is off";
}

export const inactiveForModelMessage = (ctx: ExtensionContext): string =>
  `Fast mode is paused: ${currentModelKey(ctx)} doesn't support it`;

export function settingsSummary(ctx: ExtensionContext, snapshot: FastSnapshot): string {
  if (isFastActive(ctx, snapshot)) return "on";
  return snapshot.desiredActive ? "requested inactive" : "off";
}

export const statusSegment = (ctx: ExtensionContext, snapshot: FastSnapshot): string | undefined =>
  isFastActive(ctx, snapshot) ? `${ctx.model?.id ?? "model"} fast` : undefined;

export function injectProviderPayload(
  event: { payload?: unknown },
  ctx: ExtensionContext,
  snapshot: FastSnapshot,
  recordInjection: (event: { readonly model: string; readonly tier: string }) => void,
) {
  if (!isFastActive(ctx, snapshot) || !Predicate.isObject(event.payload)) return undefined;
  recordInjection({ model: currentModelKey(ctx), tier: FAST_SERVICE_TIER });
  return { ...event.payload, service_tier: FAST_SERVICE_TIER };
}

export function fastDebugLines(ctx: ExtensionContext, snapshot: FastSnapshot): string[] {
  return [
    `Fast desired: ${snapshot.desiredActive}`,
    `Fast active: ${isFastActive(ctx, snapshot)}`,
    `Current model: ${currentModelKey(ctx)}`,
    `Supported model: ${supportsFast(ctx)}`,
    `Configured service_tier: ${FAST_SERVICE_TIER}`,
    `Last injected: ${snapshot.lastInjectedModel ? `${snapshot.lastInjectedModel}, ${snapshot.lastInjectedTier}` : "never"}`,
  ];
}
