import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { freezeSnapshot } from "pi-cosmic-core";
import { fastModelKey, SUPPORTED_FAST_MODELS, supportsFastModel } from "./models.ts";

export interface FastSnapshot {
  readonly desiredActive: boolean;
  readonly active: boolean;
  readonly lastInjectedModel?: string;
  readonly lastInjectedTier?: string;
}

export const initialFastSnapshot = (): FastSnapshot =>
  freezeSnapshot({ desiredActive: false, active: false });
export const currentModelKey = (ctx: ExtensionContext): string =>
  ctx.model ? fastModelKey(ctx.model.provider, ctx.model.id) : "none";
export const supportsFast = (ctx: ExtensionContext): boolean =>
  supportsFastModel(ctx.model?.provider, ctx.model?.id);
export const modelList = (): string => SUPPORTED_FAST_MODELS.join(", ");
export const isFastActive = (ctx: ExtensionContext, snapshot: FastSnapshot): boolean =>
  snapshot.desiredActive && supportsFast(ctx);

export function fastStateText(ctx: ExtensionContext, snapshot: FastSnapshot): string {
  const model = currentModelKey(ctx);
  if (isFastActive(ctx, snapshot)) return `Fast mode is on for ${model}.`;
  if (snapshot.desiredActive)
    return `Fast mode is requested, but inactive for unsupported model ${model}. Supported models: ${modelList()}.`;
  return `Fast mode is off. Current model: ${model}.`;
}

export const unsupportedRequestMessage = (ctx: ExtensionContext): string =>
  `Fast mode requested, but ${currentModelKey(ctx)} is unsupported. It will activate automatically when you switch to a supported model: ${modelList()}.`;

export const inactiveForModelMessage = (ctx: ExtensionContext): string =>
  `Fast mode inactive for unsupported model ${currentModelKey(ctx)}.`;

export function settingsSummary(ctx: ExtensionContext, snapshot: FastSnapshot): string {
  if (isFastActive(ctx, snapshot)) return "on";
  if (snapshot.desiredActive) return supportsFast(ctx) ? "requested" : "requested inactive";
  return "off";
}

export const statusSegment = (ctx: ExtensionContext, snapshot: FastSnapshot): string | undefined =>
  isFastActive(ctx, snapshot) ? `${ctx.model?.id ?? "model"} fast` : undefined;

export function injectProviderPayload(
  event: { payload?: unknown },
  ctx: ExtensionContext,
  snapshot: FastSnapshot,
  serviceTier: string,
  recordInjection: (event: { readonly model: string; readonly tier: string }) => void,
): unknown {
  if (!isFastActive(ctx, snapshot) || !Predicate.isObject(event.payload)) return undefined;
  recordInjection({ model: currentModelKey(ctx), tier: serviceTier });
  return { ...event.payload, service_tier: serviceTier };
}

export function fastDebugLines(
  ctx: ExtensionContext,
  snapshot: FastSnapshot,
  serviceTier: string,
): string[] {
  return [
    `Fast desired: ${snapshot.desiredActive}`,
    `Fast active: ${isFastActive(ctx, snapshot)}`,
    `Current model: ${currentModelKey(ctx)}`,
    `Supported model: ${supportsFast(ctx)}`,
    `Configured service_tier: ${serviceTier}`,
    `Last injected: ${snapshot.lastInjectedModel ? `${snapshot.lastInjectedModel}, ${snapshot.lastInjectedTier}` : "never"}`,
  ];
}
