import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "./config.ts";
import { isRecord } from "./config.ts";
import { fastModelKey, SUPPORTED_FAST_MODELS, supportsFastModel } from "./fast-models.ts";

export { SUPPORTED_FAST_MODELS } from "./fast-models.ts";
export const currentModelKey = (ctx: ExtensionContext): string =>
  ctx.model ? fastModelKey(ctx.model.provider, ctx.model.id) : "none";
export const supportsFast = (ctx: ExtensionContext): boolean =>
  supportsFastModel(ctx.model?.provider, ctx.model?.id);
export const modelList = (): string => SUPPORTED_FAST_MODELS.join(", ");

export function fastStateText(
  ctx: ExtensionContext,
  desiredActive: boolean,
  active: boolean,
): string {
  const model = currentModelKey(ctx);
  if (active) return `Fast mode is on for ${model}.`;
  if (desiredActive)
    return `Fast mode is requested, but inactive for unsupported model ${model}. Supported models: ${modelList()}.`;
  return `Fast mode is off. Current model: ${model}.`;
}

interface FastState {
  readonly desiredActive: boolean;
  readonly active: boolean;
  readonly lastInjectedModel?: string;
  readonly lastInjectedTier?: string;
}

export class FastController {
  private state: FastState = { desiredActive: false, active: false };
  private readonly serviceTier: string;
  constructor(serviceTier: string) {
    this.serviceTier = serviceTier;
  }
  get desiredActive() {
    return this.state.desiredActive;
  }
  get active() {
    return this.state.active;
  }
  applyDesiredState(ctx: ExtensionContext): void {
    this.state = { ...this.state, active: this.state.desiredActive && supportsFast(ctx) };
  }
  initializeForSession(ctx: ExtensionContext, cfg: ResolvedConfig, flagActive: boolean): void {
    const desiredActive = flagActive || (cfg.persistState ? cfg.desiredActive : false);
    this.state = { desiredActive, active: desiredActive && supportsFast(ctx) };
  }
  setDesired(ctx: ExtensionContext, desiredActive: boolean): void {
    this.state = { ...this.state, desiredActive, active: desiredActive && supportsFast(ctx) };
  }
  stateText(ctx: ExtensionContext): string {
    return fastStateText(ctx, this.desiredActive, this.active);
  }
  unsupportedRequestMessage(ctx: ExtensionContext): string {
    return `Fast mode requested, but ${currentModelKey(ctx)} is unsupported. It will activate automatically when you switch to a supported model: ${modelList()}.`;
  }
  inactiveForModelMessage(ctx: ExtensionContext): string {
    return `Fast mode inactive for unsupported model ${currentModelKey(ctx)}.`;
  }
  settingsSummary(ctx: ExtensionContext): string {
    if (this.active) return "on";
    if (this.desiredActive) return supportsFast(ctx) ? "requested" : "requested inactive";
    return "off";
  }
  statusSegment(ctx: ExtensionContext): string | undefined {
    return this.active && supportsFast(ctx) ? `${ctx.model?.id ?? "model"} fast` : undefined;
  }
  injectProviderPayload(event: { payload?: unknown }, ctx: ExtensionContext): unknown {
    if (!this.active || !supportsFast(ctx) || !isRecord(event.payload)) return undefined;
    this.state = {
      ...this.state,
      lastInjectedModel: currentModelKey(ctx),
      lastInjectedTier: this.serviceTier,
    };
    return { ...event.payload, service_tier: this.serviceTier };
  }
  debugLines(ctx: ExtensionContext): string[] {
    const state = this.state;
    return [
      `Fast desired: ${state.desiredActive}`,
      `Fast active: ${state.active}`,
      `Current model: ${currentModelKey(ctx)}`,
      `Supported model: ${supportsFast(ctx)}`,
      `Configured service_tier: ${this.serviceTier}`,
      `Last injected: ${state.lastInjectedModel ? `${state.lastInjectedModel}, ${state.lastInjectedTier}` : "never"}`,
    ];
  }
}
