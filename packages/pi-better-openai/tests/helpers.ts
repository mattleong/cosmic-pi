import type { Api, AssistantMessage, AuthResult, Model } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { JsonHttpClient } from "pi-cosmic-core";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { expect, vi } from "vitest";
import type { SharpAdapterContract } from "../src/boundary/sharp.ts";
import { OPENAI_COMPACTION_DETAILS_TYPE } from "../src/compaction/protocol.ts";
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

/** Details of a compaction this extension owns, freshly allocated for each entry. */
export const ownedCheckpointDetails = () => ({
  type: OPENAI_COMPACTION_DETAILS_TYPE,
  checkpoint: {
    version: 1,
    provider: "openai",
    api: "openai-responses",
    model: "gpt-5.5",
    output: [{ type: "compaction", encrypted_content: "encrypted" }],
    omittedEntryIds: [],
    createdAt: 0,
  },
});

export const beforeCompactEvent = (
  signal: AbortSignal = new AbortController().signal,
): SessionBeforeCompactEvent => ({
  type: "session_before_compact",
  preparation: {
    firstKeptEntryId: "retained",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 100,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  },
  branchEntries: [],
  reason: "manual",
  willRetry: false,
  signal,
});

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

export function testContext(
  options: {
    readonly model?: () => Model<Api>;
    readonly token?: string | Error | undefined;
    readonly oauth?: boolean;
  } = {},
) {
  const { token } = options;
  return extensionContextFixture({
    cwd: "/project",
    hasUI: true,
    get model() {
      return options.model?.() ?? testModel();
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

export const appendAssistant = (
  manager: SessionManager,
  stopReason: AssistantMessage["stopReason"],
  text: string,
  timestamp = 10,
) => manager.appendMessage(assistantMessage([{ type: "text", text }], { stopReason, timestamp }));

export const serializedSnapshot = Fn.flow(
  Schema.encodeOption(Schema.fromJsonString(Schema.Unknown)),
  Option.getOrElse(() => ""),
);

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

export const unusedHttpLayer = Layer.succeed(
  JsonHttpClient,
  JsonHttpClient.of({
    request: () => Effect.die("unexpected HTTP"),
    requestJson: () => Effect.die("unexpected HTTP"),
  }),
);
