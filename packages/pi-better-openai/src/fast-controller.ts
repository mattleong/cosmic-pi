import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig, SupportedModel } from "./config.ts";
import { isRecord } from "./config.ts";

export function currentModelKey(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

export function supportsFast(ctx: ExtensionContext, supportedModels: SupportedModel[]): boolean {
  const current = ctx.model;
  if (!current) return false;
  return supportedModels.some(
    (model) => model.provider === current.provider && model.id === current.id,
  );
}

export function modelList(supportedModels: SupportedModel[]): string {
  return supportedModels.length > 0
    ? supportedModels.map((model) => `${model.provider}/${model.id}`).join(", ")
    : "none configured";
}

export function fastStateText(
  ctx: ExtensionContext,
  desiredActive: boolean,
  active: boolean,
  supportedModels: SupportedModel[],
): string {
  const model = currentModelKey(ctx);
  if (active) return `Fast mode is on for ${model}.`;
  if (desiredActive) {
    return `Fast mode is requested, but inactive for unsupported model ${model}. Supported models: ${modelList(supportedModels)}.`;
  }
  return `Fast mode is off. Current model: ${model}.`;
}

export class FastController {
  desiredActive = false;
  active = false;
  private lastInjectedAt: number | undefined;
  private lastInjectedModel: string | undefined;
  private lastInjectedTier: string | undefined;
  private readonly serviceTier: string;

  constructor(serviceTier: string) {
    this.serviceTier = serviceTier;
  }

  applyDesiredState(ctx: ExtensionContext, cfg: ResolvedConfig): void {
    this.active = this.desiredActive && supportsFast(ctx, cfg.supportedModels);
  }

  initializeForSession(ctx: ExtensionContext, cfg: ResolvedConfig, flagActive: boolean): void {
    this.desiredActive = cfg.persistState ? cfg.desiredActive : false;
    if (flagActive) this.desiredActive = true;
    this.applyDesiredState(ctx, cfg);
  }

  setDesired(ctx: ExtensionContext, cfg: ResolvedConfig, next: boolean): void {
    this.desiredActive = next;
    this.applyDesiredState(ctx, cfg);
  }

  stateText(ctx: ExtensionContext, cfg: ResolvedConfig): string {
    return fastStateText(ctx, this.desiredActive, this.active, cfg.supportedModels);
  }

  unsupportedRequestMessage(ctx: ExtensionContext, cfg: ResolvedConfig): string {
    return `Fast mode requested, but ${currentModelKey(ctx)} is unsupported. It will activate automatically when you switch to a supported model: ${modelList(cfg.supportedModels)}.`;
  }

  inactiveForModelMessage(ctx: ExtensionContext): string {
    return `Fast mode inactive for unsupported model ${currentModelKey(ctx)}.`;
  }

  settingsSummary(ctx: ExtensionContext, cfg: ResolvedConfig): string {
    if (this.active) return "on";
    if (this.desiredActive)
      return supportsFast(ctx, cfg.supportedModels) ? "requested" : "requested inactive";
    return "off";
  }

  statusSegment(ctx: ExtensionContext, cfg: ResolvedConfig): string | undefined {
    return this.active && supportsFast(ctx, cfg.supportedModels)
      ? `${ctx.model?.id ?? "model"} fast`
      : undefined;
  }

  injectProviderPayload(
    event: { payload?: unknown },
    ctx: ExtensionContext,
    cfg: ResolvedConfig,
  ): unknown {
    if (!this.active || !supportsFast(ctx, cfg.supportedModels) || !isRecord(event.payload))
      return undefined;
    this.lastInjectedAt = Date.now();
    this.lastInjectedModel = currentModelKey(ctx);
    this.lastInjectedTier = this.serviceTier;
    return { ...event.payload, service_tier: this.serviceTier };
  }

  debugLines(ctx: ExtensionContext, cfg: ResolvedConfig): string[] {
    return [
      `Fast desired: ${this.desiredActive}`,
      `Fast active: ${this.active}`,
      `Current model: ${currentModelKey(ctx)}`,
      `Supported model: ${supportsFast(ctx, cfg.supportedModels)}`,
      `Configured service_tier: ${this.serviceTier}`,
      `Last injected: ${this.lastInjectedAt ? `${new Date(this.lastInjectedAt).toLocaleTimeString()} (${this.lastInjectedModel}, ${this.lastInjectedTier})` : "never"}`,
    ];
  }
}
