import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { freezeSnapshot } from "pi-cosmic-core/projection";
import { serviceTierForFastMode, supportsFastModel, type OpenAIFastMode } from "./models.ts";

export interface FastSnapshot {
  readonly desiredActive: OpenAIFastMode;
  readonly active: boolean;
  readonly lastInjectedModel?: string;
  readonly lastInjectedTier?: string;
}

export const initialFastSnapshot = (): FastSnapshot =>
  freezeSnapshot({ desiredActive: false, active: false });
export const currentModelKey = (ctx: ExtensionContext): string =>
  ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
export const activeFastTier = (ctx: ExtensionContext, snapshot: FastSnapshot) =>
  serviceTierForFastMode(ctx.model?.provider, ctx.model?.id, snapshot.desiredActive);
export const isFastActive = (ctx: ExtensionContext, snapshot: FastSnapshot): boolean =>
  activeFastTier(ctx, snapshot) !== undefined;

export const fastModeValue = (mode: OpenAIFastMode): string =>
  mode === "ultrafast" ? mode : mode ? "on" : "off";

export function fastStateText(ctx: ExtensionContext, snapshot: FastSnapshot): string {
  const mode = snapshot.desiredActive;
  if (!mode) return "Fast mode is off";
  const name = mode === "ultrafast" ? "Ultrafast" : "Fast mode";
  if (isFastActive(ctx, snapshot)) return `${name} is on for ${currentModelKey(ctx)}`;
  const target = mode === "ultrafast" ? "openai-codex/gpt-6.2-sol" : "an OpenAI model";
  return `${name} is paused until you switch from ${currentModelKey(ctx)} to ${target}`;
}

export function settingsSummary(ctx: ExtensionContext, snapshot: FastSnapshot): string {
  const value = fastModeValue(snapshot.desiredActive);
  return snapshot.desiredActive && !isFastActive(ctx, snapshot)
    ? `${value} (paused for this model)`
    : value;
}

export const statusSegment = (ctx: ExtensionContext, snapshot: FastSnapshot): string | undefined =>
  isFastActive(ctx, snapshot)
    ? `${ctx.model?.id ?? "model"} ${snapshot.desiredActive === "ultrafast" ? "ultrafast" : "fast"}`
    : undefined;

export function injectProviderPayload(
  event: { payload?: unknown },
  ctx: ExtensionContext,
  snapshot: FastSnapshot,
  recordInjection: (event: { readonly model: string; readonly tier: string }) => void,
) {
  const tier = activeFastTier(ctx, snapshot);
  if (!tier || !Predicate.isObject(event.payload) || Arr.isArray(event.payload)) return undefined;
  recordInjection({ model: currentModelKey(ctx), tier });
  return { ...event.payload, service_tier: tier };
}

/** Fast-mode diagnostics as `Name: value` facts; the setting itself and the model show elsewhere. */
export function fastDiagnosticLines(
  ctx: ExtensionContext,
  snapshot: FastSnapshot,
  ownsFastMode: boolean,
): string[] {
  const mode = snapshot.desiredActive;
  const tier = activeFastTier(ctx, snapshot);
  const requested = mode === "ultrafast" ? mode : "priority";
  return [
    `Active: ${tier ? "yes" : "no"}`,
    `Model supported: ${supportsFastModel(ctx.model?.provider, ctx.model?.id, mode || undefined) ? "yes" : "no"}`,
    `Service tier: ${tier ?? (mode ? `none (${requested} paused)` : "none")}`,
    ownsFastMode
      ? `Last fast request: ${
          snapshot.lastInjectedModel
            ? Arr.join(
                Arr.filter(
                  [snapshot.lastInjectedModel, snapshot.lastInjectedTier],
                  (value) => value !== undefined,
                ),
                ", ",
              )
            : "never"
        }`
      : `Profile mode: ${fastModeValue(mode)}`,
  ];
}
