import * as Arr from "effect/Array";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyCodexRoutingHint,
  childOpenAIFastMode,
  serviceTierForFastMode,
} from "pi-better-openai/fast-models";
import { hasObjectRuntimeType } from "pi-cosmic-core/runtime-values";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
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

export const registerChildPiFastModeHook = (
  pi: ExtensionAPI,
  environment: NodeJS.ProcessEnv,
): void => {
  // A running parent may predate the tier environment and still launch with this switch.
  pi.registerFlag("pi-subagents-fast-mode", {
    description: "Private OpenAI priority request for this subagent",
    type: "boolean",
    default: false,
  });
  const routedMode =
    environment.PI_SUBAGENT_OPENAI_FAST_MODE === undefined
      ? undefined
      : childOpenAIFastMode(environment);
  // Pi applies flags after registration, and a Rex child can switch models between requests.
  const tierFor = (model: ExtensionContext["model"]) =>
    serviceTierForFastMode(
      model?.provider,
      model?.id,
      routedMode ?? pi.getFlag("pi-subagents-fast-mode") === true,
    );
  pi.on("before_provider_headers", (event, ctx) => {
    const tier = tierFor(ctx.model);
    if (tier === "ultrafast") applyCodexRoutingHint(event.headers, ctx.model, tier);
  });
  pi.on("before_provider_request", (event, ctx) => {
    const tier = tierFor(ctx.model);
    if (
      !tier ||
      !event.payload ||
      !hasObjectRuntimeType(event.payload) ||
      Arr.isArray(event.payload)
    )
      return undefined;
    return { ...event.payload, service_tier: tier };
  });
};
