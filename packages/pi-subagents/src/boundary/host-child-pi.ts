import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FAST_SERVICE_TIER, supportsFastModel } from "pi-better-openai/fast-models";
import { hasObjectRuntimeType, invokeHostCallback } from "pi-cosmic-core";
import { decodeSubagentEffort } from "../domain/routing.ts";
import type { SubagentParentContext } from "../run/model.ts";

/** Read at invocation, not session activation: model, effort and branch can change in place. */
export const capturePiParentContext = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): SubagentParentContext => {
  const model = ctx.model;
  const leaf = ctx.sessionManager.getLeafEntry();
  const leafId =
    leaf?.type === "message" && leaf.message.role === "assistant"
      ? (leaf.parentId ?? undefined)
      : leaf?.id;
  const contextTokens = invokeHostCallback(
    () => ctx.getContextUsage()?.tokens ?? undefined,
    undefined,
  );
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    leafId,
    ...(model && { model: `${model.provider}/${model.id}` }),
    effort: decodeSubagentEffort(pi.getThinkingLevel()) ?? "high",
    ...(contextTokens !== undefined && { contextTokens }),
  };
};

interface RuntimeApiCredentials {
  readonly apiKey?: string | undefined;
  readonly provider?: string | undefined;
}

export const consumeRuntimeApiCredentials = (
  environment: NodeJS.ProcessEnv,
): RuntimeApiCredentials => {
  const apiKey = environment.PI_SUBAGENT_RUNTIME_API_KEY;
  const provider = environment.PI_SUBAGENT_RUNTIME_API_PROVIDER;
  delete environment.PI_SUBAGENT_RUNTIME_API_KEY;
  delete environment.PI_SUBAGENT_RUNTIME_API_PROVIDER;
  return { apiKey, provider };
};

export const registerChildPiFastModeHook = (pi: ExtensionAPI, isEnabled: () => boolean): void => {
  pi.on("before_provider_request", (event, ctx) => {
    if (
      !isEnabled() ||
      !ctx.model ||
      !supportsFastModel(ctx.model.provider, ctx.model.id) ||
      !event.payload ||
      !hasObjectRuntimeType(event.payload) ||
      Array.isArray(event.payload)
    )
      return undefined;
    return { ...event.payload, service_tier: FAST_SERVICE_TIER };
  });
};
