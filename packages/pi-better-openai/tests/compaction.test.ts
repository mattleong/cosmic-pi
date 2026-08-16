// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Stream from "effect/Stream";
import {
  streamingHttpResponse,
  streamingHttpTestLayer,
  type StreamingHttpTestRequest,
} from "pi-cosmic-core/testing";
import { describe, expect, test, vi } from "vitest";
import {
  OpenAICompactionClient,
  type OpenAICompactRequest,
} from "../src/boundary/openai-compaction.ts";
import { OpenAICompactionService } from "../src/compaction/service.ts";
import {
  findActiveOpenAICompactionCheckpoint,
  injectOpenAICompactionCheckpoint,
  isEligibleOpenAICompactionModel,
  projectOpenAIResponseInput,
} from "../src/compaction/projection.ts";
import {
  OPENAI_COMPACTION_DETAILS_TYPE,
  OPENAI_COMPACTION_SUMMARY,
  type OpenAICompactionCheckpoint,
} from "../src/compaction/protocol.ts";
import type { ResolvedConfig } from "../src/config/schema.ts";
import type { FastSnapshot } from "../src/fast/controller.ts";
import { initialProjection, type OpenAIProjection } from "../src/usage/projection.ts";

const model = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 400_000,
  maxTokens: 32_000,
} satisfies Model<"openai-responses">;

const checkpoint: OpenAICompactionCheckpoint = {
  version: 1,
  provider: "openai",
  api: "openai-responses",
  model: model.id,
  output: [{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" }],
  rawInputCount: 2,
  createdAt: 10,
  tokensBefore: 100_000,
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
};

const base = (id: string, parentId: string | null) => ({
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
});

const resolvedConfig = {
  configPath: "config.json",
  projectConfigPath: "project.json",
  globalConfigPath: "global.json",
  projectConfigExists: false,
  globalConfigExists: false,
  persistState: true,
  active: true,
  desiredActive: true,
  usage: {
    enabled: false,
    refreshIntervalMs: 60_000,
    showOnlyOnSubscriptionModels: true,
    showResetTimes: true,
  },
  footer: { mode: "off" },
  compaction: { enabled: true },
  image: {
    enabled: false,
    defaultModel: "gpt-5.5",
    defaultSave: "project",
    outputFormat: "png",
    timeoutMs: 180_000,
  },
} satisfies ResolvedConfig;

describe("OpenAI compaction projection", () => {
  test("only enables native compaction for the OpenAI Responses provider", () => {
    expect(isEligibleOpenAICompactionModel(model)).toBe(true);
    expect(isEligibleOpenAICompactionModel({ ...model, provider: "openai-codex" })).toBe(false);
    expect(isEligibleOpenAICompactionModel({ ...model, api: "openai-completions" })).toBe(false);
  });

  test("selects a branch-local checkpoint and lets a later Pi compaction supersede it", () => {
    const entry: SessionEntry = {
      ...base("checkpoint", "message"),
      type: "compaction",
      summary: OPENAI_COMPACTION_SUMMARY,
      firstKeptEntryId: "message",
      tokensBefore: checkpoint.tokensBefore,
      details: { type: OPENAI_COMPACTION_DETAILS_TYPE, checkpoint },
    };
    expect(findActiveOpenAICompactionCheckpoint([entry], model)?.checkpoint).toEqual(checkpoint);

    const piCompaction: SessionEntry = {
      ...base("pi-compaction", "checkpoint"),
      type: "compaction",
      summary: "fallback",
      firstKeptEntryId: "message",
      tokensBefore: 120_000,
    };
    expect(findActiveOpenAICompactionCheckpoint([entry, piCompaction], model)).toBeUndefined();
  });

  test("replaces the compacted raw prefix while preserving instructions and later input", () => {
    const payload = {
      model: model.id,
      service_tier: "priority",
      input: [
        { role: "developer", content: "system" },
        { role: "user", content: "old one" },
        { role: "assistant", content: "old two" },
        { role: "user", content: "new work" },
      ],
    };
    expect(injectOpenAICompactionCheckpoint(payload, checkpoint)).toEqual({
      model: model.id,
      service_tier: "priority",
      input: [
        { role: "developer", content: "system" },
        ...checkpoint.output,
        { role: "user", content: "new work" },
      ],
    });
  });

  test("uses pi-ai's converter and omits the native Pi compaction marker", () => {
    const entries: SessionEntry[] = [
      {
        ...base("checkpoint", null),
        type: "compaction",
        summary: OPENAI_COMPACTION_SUMMARY,
        firstKeptEntryId: "user",
        tokensBefore: checkpoint.tokensBefore,
        details: { type: OPENAI_COMPACTION_DETAILS_TYPE, checkpoint },
      },
      {
        ...base("user", "checkpoint"),
        type: "message",
        message: { role: "user", content: "hello", timestamp: 1 },
      },
    ];
    expect(projectOpenAIResponseInput(model, entries)).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);
  });

  test("calls the standalone endpoint with resolved auth and decodes its checkpoint", async () => {
    let captured: StreamingHttpTestRequest | undefined;
    const requestModel = {
      ...model,
      headers: { "x-provider-default": "remove", "x-model-header": "keep" },
    } satisfies Model<"openai-responses">;
    const responseBody = new TextEncoder().encode(
      JSON.stringify({
        object: "response.compaction",
        output: [{ type: "compaction", id: "cmp_2", encrypted_content: "opaque-2" }],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      }),
    );
    const http = streamingHttpTestLayer((request) =>
      Effect.sync(() => {
        captured = request;
        return streamingHttpResponse(200, Stream.make(responseBody));
      }),
    );
    const getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true as const,
      apiKey: "secret",
      headers: { "X-Provider-Default": null, "x-runtime-header": "runtime" },
    }));
    const layer = OpenAICompactionClient.layer(() => ({ getApiKeyAndHeaders })).pipe(
      Layer.provide(http),
    );

    const result = await Effect.runPromise(
      OpenAICompactionClient.use((client) =>
        client.compact({
          model: requestModel,
          input: [{ role: "user", content: "hello" }],
          instructions: "system",
          serviceTier: "priority",
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(captured?.url).toBe("https://api.openai.com/v1/responses/compact");
    expect(captured?.headers?.authorization).toBe("Bearer secret");
    expect(captured?.headers?.["x-provider-default"]).toBeUndefined();
    expect(captured?.headers?.["x-model-header"]).toBe("keep");
    expect(captured?.headers?.["x-runtime-header"]).toBe("runtime");
    expect(captured?.encodedJsonBody).toEqual({
      model: model.id,
      input: [{ role: "user", content: "hello" }],
      instructions: "system",
      service_tier: "priority",
    });
    expect(result).toEqual({
      output: [{ type: "compaction", id: "cmp_2", encrypted_content: "opaque-2" }],
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    });

    await Effect.runPromise(
      OpenAICompactionClient.use((client) =>
        client.compact({
          model: requestModel,
          input: [{ role: "user", content: "hello" }],
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(captured?.encodedJsonBody).toEqual({
      model: model.id,
      input: [{ role: "user", content: "hello" }],
    });
  });

  test("propagates fast mode to compaction and omits the tier when fast mode is inactive", async () => {
    const contextEntry: SessionEntry = {
      ...base("user", null),
      type: "message",
      message: { role: "user", content: "hello", timestamp: 1 },
    };
    const contextFixture = {
      model,
      sessionManager: {
        getBranch: () => [contextEntry],
        buildContextEntries: () => [contextEntry],
      },
      getSystemPrompt: () => "system",
    };
    // SAFETY: The compaction service only reads the context members supplied by this fixture.
    const context = MutableRef.make(contextFixture as ExtensionContext);
    const projection = MutableRef.make<OpenAIProjection>({
      ...initialProjection(),
      config: resolvedConfig,
    });
    const fastProjection = MutableRef.make<FastSnapshot>({
      desiredActive: true,
      active: true,
    });
    const requests: OpenAICompactRequest[] = [];
    const client = Layer.succeed(
      OpenAICompactionClient,
      OpenAICompactionClient.of({
        compact: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return {
              output: [{ type: "compaction", id: "cmp_fast", encrypted_content: "opaque" }],
              usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
            };
          }),
      }),
    );
    const layer = OpenAICompactionService.layer({
      context,
      projection,
      fastProjection,
    }).pipe(Layer.provide(client));
    const event: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      branchEntries: [contextEntry],
      preparation: {
        firstKeptEntryId: "user",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 100,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 20_000 },
      },
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    };
    const runCompaction = () =>
      Effect.runPromise(
        OpenAICompactionService.use((service) => service.compact(event)).pipe(
          Effect.provide(layer),
        ),
      );

    await runCompaction();
    expect(requests[0]).toMatchObject({ serviceTier: "priority" });

    MutableRef.set(fastProjection, { desiredActive: false, active: false });
    await runCompaction();
    expect(requests[1]).not.toHaveProperty("serviceTier");
  });
});
