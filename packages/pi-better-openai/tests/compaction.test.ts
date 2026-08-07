// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import type { Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  streamingHttpResponse,
  streamingHttpTestLayer,
  type StreamingHttpTestRequest,
} from "pi-cosmic-core/testing";
import { describe, expect, test, vi } from "vitest";
import { OpenAICompactionClient } from "../src/boundary/openai-compaction.ts";
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
    });
    expect(result).toEqual({
      output: [{ type: "compaction", id: "cmp_2", encrypted_content: "opaque-2" }],
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    });
  });
});
