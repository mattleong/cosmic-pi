import type { Api, AssistantMessage, AuthResult, Model } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { expect, vi } from "vitest";
import type { SharpAdapterContract } from "../src/boundary/sharp.ts";
import {
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_USAGE_CONFIG,
  type ResolvedConfig,
} from "../src/config/schema.ts";

export function makeResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    configPath: "",
    projectConfigPath: "",
    globalConfigPath: "",
    projectConfigExists: false,
    globalConfigExists: false,
    persistState: true,
    desiredActive: false,
    usage: DEFAULT_USAGE_CONFIG,

    compaction: DEFAULT_COMPACTION_CONFIG,
    image: DEFAULT_IMAGE_CONFIG,
    ...overrides,
  };
}

export function testModel(id?: string, provider?: string): Model<"openai-responses">;
export function testModel<TApi extends Api>(id: string, provider: string, api: TApi): Model<TApi>;
export function testModel(
  id = "gpt-5.5",
  provider = "openai",
  api: Api = "openai-responses",
): Model<Api> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

/**
 * A minimal Pi context. Its registry resolves `token` as openai-codex auth, or rejects with an
 * Error token; `model` is read through a getter on every access.
 */
export function testContext(
  options: {
    readonly model?: () => Pick<Model<Api>, "provider" | "id">;
    readonly token?: string | Error | undefined;
    readonly oauth?: boolean;
  } = {},
) {
  const { token } = options;
  return extensionContextFixture({
    cwd: "/project",
    hasUI: true as const,
    get model() {
      return options.model?.() ?? { provider: "openai", id: "gpt-5.5" };
    },
    modelRegistry: {
      isUsingOAuth: () => options.oauth ?? true,
      getProviderAuth: (): Promise<AuthResult | undefined> =>
        token instanceof Error
          ? Promise.reject(token)
          : Promise.resolve(token === undefined ? undefined : { auth: { apiKey: token } }),
    },
    ui: { notify() {} },
  });
}

export const zeroUsage: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const assistantMessage = (
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider: "openai",
  model: "gpt-5.5",
  usage: zeroUsage,
  stopReason: "stop",
  timestamp: 1,
  ...overrides,
});

// Pure leak-check serialization stays outside Effect code on purpose: it scans opaque
// runtime values (tagged failures, redacted credentials) for secret fragments.
export const serializedSnapshot = <Value>(value: Value): string => JSON.stringify(value) ?? "";

export const waitUntil = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.promise(() =>
    vi.waitFor(() => {
      expect(predicate()).toBe(true);
    }),
  );

const encoder = new TextEncoder();
export const bytes = (value: string) => encoder.encode(value);

export const pngSharp: SharpAdapterContract = {
  decode: () => Effect.succeed({ format: "png" }),
};
