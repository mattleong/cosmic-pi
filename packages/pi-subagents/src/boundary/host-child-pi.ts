// Shared Pi-child host policy for ephemeral credentials and OpenAI priority requests.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FAST_SERVICE_TIER, supportsFastModel } from "pi-better-openai/fast-models";
import { hasObjectRuntimeType } from "pi-cosmic-core";

interface RuntimeApiCredentials {
  readonly apiKey?: string | undefined;
  readonly provider?: string | undefined;
}

/** Reads and scrubs one-shot runtime API credentials at the caller-selected lifecycle point. */
export const consumeRuntimeApiCredentials = (
  environment: NodeJS.ProcessEnv,
): RuntimeApiCredentials => {
  const apiKey = environment.PI_SUBAGENT_RUNTIME_API_KEY;
  const provider = environment.PI_SUBAGENT_RUNTIME_API_PROVIDER;
  delete environment.PI_SUBAGENT_RUNTIME_API_KEY;
  delete environment.PI_SUBAGENT_RUNTIME_API_PROVIDER;
  return { apiKey, provider };
};

/** Registers the private priority tier hook, narrowed to eligible active OpenAI models. */
export const registerChildPiFastModeHook = (pi: ExtensionAPI, isEnabled: () => boolean): void => {
  pi.on("before_provider_request", (event, ctx) => {
    if (
      // Pi applies CLI flags after extension factories finish. Read at request time.
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
