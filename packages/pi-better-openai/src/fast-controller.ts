import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "./config.ts";
import { isRecord } from "./config.ts";

export const SUPPORTED_FAST_MODELS = [
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
] as const;

const SUPPORTED_FAST_MODEL_SET = new Set<string>(SUPPORTED_FAST_MODELS);

export function currentModelKey(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

export function supportsFast(ctx: ExtensionContext): boolean {
  return SUPPORTED_FAST_MODEL_SET.has(currentModelKey(ctx));
}

export function modelList(): string {
  return SUPPORTED_FAST_MODELS.join(", ");
}

export function fastStateText(
  ctx: ExtensionContext,
  desiredActive: boolean,
  active: boolean,
): string {
  const model = currentModelKey(ctx);
  if (active) return `Fast mode is on for ${model}.`;
  if (desiredActive) {
    return `Fast mode is requested, but inactive for unsupported model ${model}. Supported models: ${modelList()}.`;
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

  applyDesiredState(ctx: ExtensionContext): void {
    this.active = this.desiredActive && supportsFast(ctx);
  }

  initializeForSession(ctx: ExtensionContext, cfg: ResolvedConfig, flagActive: boolean): void {
    this.desiredActive = cfg.persistState ? cfg.desiredActive : false;
    if (flagActive) this.desiredActive = true;
    this.applyDesiredState(ctx);
  }

  setDesired(ctx: ExtensionContext, next: boolean): void {
    this.desiredActive = next;
    this.applyDesiredState(ctx);
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
    this.lastInjectedAt = Date.now();
    this.lastInjectedModel = currentModelKey(ctx);
    this.lastInjectedTier = this.serviceTier;
    return { ...event.payload, service_tier: this.serviceTier };
  }

  debugLines(ctx: ExtensionContext): string[] {
    return [
      `Fast desired: ${this.desiredActive}`,
      `Fast active: ${this.active}`,
      `Current model: ${currentModelKey(ctx)}`,
      `Supported model: ${supportsFast(ctx)}`,
      `Configured service_tier: ${this.serviceTier}`,
      `Last injected: ${this.lastInjectedAt ? `${new Date(this.lastInjectedAt).toLocaleTimeString()} (${this.lastInjectedModel}, ${this.lastInjectedTier})` : "never"}`,
    ];
  }
}
