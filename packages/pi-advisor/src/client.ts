import { clampThinkingLevel, streamSimple } from "@earendil-works/pi-ai/compat";
import {
  ModelRuntime,
  type ExtensionContext,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { FAST_SERVICE_TIER, supportsFastModel } from "pi-better-openai/fast-models";
import type { ResolvedAdvisorConfig } from "./config.ts";

export class AdvisorModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisorModelError";
  }
}

export interface AdvisorUsageTelemetry {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AdvisorChildModel {
  modelRuntime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRegistry["find"]>>;
  thinkingLevel: ReturnType<typeof clampThinkingLevel>;
}

/**
 * Build an independent public model runtime. Provider registrations and a
 * transferable runtime API key are mirrored only through public APIs.
 */
export async function createAdvisorChildModel(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  config: ResolvedAdvisorConfig,
): Promise<AdvisorChildModel> {
  if (!config.provider || !config.model) {
    throw new AdvisorModelError("Advisor model is not configured.");
  }
  const parentModel = ctx.modelRegistry.find(config.provider, config.model);
  if (!parentModel) {
    throw new AdvisorModelError(
      `Configured advisor model ${config.provider}/${config.model} is unavailable.`,
    );
  }

  const parentAuth = await ctx.modelRegistry.getApiKeyAndHeaders(parentModel);
  if (!parentAuth.ok) {
    throw new AdvisorModelError("Advisor authentication failed; credentials were not transferred.");
  }

  const modelRuntime = await ModelRuntime.create();
  let selectedProviderRegistered = false;
  for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
    const provider = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
    if (!provider) continue;
    if (providerId === config.provider) selectedProviderRegistered = true;
    modelRuntime.registerProvider(
      providerId,
      providerId === config.provider && parentAuth.headers
        ? { ...provider, headers: { ...provider.headers, ...parentAuth.headers } }
        : provider,
    );
  }
  const selectedProvider = ctx.modelRegistry.getRegisteredProviderConfig(config.provider);
  if (config.fastMode && supportsFastModel(config.provider, config.model)) {
    modelRuntime.registerProvider(config.provider, {
      ...selectedProvider,
      headers: { ...selectedProvider?.headers, ...parentAuth.headers },
      streamSimple: (model, context, options) =>
        streamSimple(model, context, { ...options, onPayload: applyFastServiceTier }),
    });
  } else if (!selectedProviderRegistered && (selectedProvider || parentAuth.headers)) {
    modelRuntime.registerProvider(config.provider, {
      ...selectedProvider,
      headers: { ...selectedProvider?.headers, ...parentAuth.headers },
    });
  }
  if (parentAuth.apiKey) await modelRuntime.setRuntimeApiKey(config.provider, parentAuth.apiKey);

  const model = modelRuntime.getModel(config.provider, config.model);
  if (!model) {
    throw new AdvisorModelError(
      `Configured advisor model ${config.provider}/${config.model} is unavailable in the child runtime.`,
    );
  }

  const childAuth = await modelRuntime.getAuth(model);
  if (!childAuth) {
    const runtimeOnly = parentAuth.headers || parentAuth.env;
    throw new AdvisorModelError(
      runtimeOnly
        ? "Advisor authentication uses runtime-only headers or environment values that public Pi APIs cannot transfer to an AgentSession."
        : "Advisor authentication is unavailable in the child runtime.",
    );
  }

  return {
    modelRuntime,
    model,
    thinkingLevel: clampThinkingLevel(model, config.thinkingLevel),
  };
}

function applyFastServiceTier(payload: unknown): unknown | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  return { ...payload, service_tier: FAST_SERVICE_TIER };
}

export const _clientTest = { applyFastServiceTier };
