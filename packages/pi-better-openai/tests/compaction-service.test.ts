import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "#pi-ai-openai-responses-shared";
import {
  buildSessionContext,
  convertToLlm,
  sessionEntryToContextMessages,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { provideBuiltLayer } from "pi-cosmic-core";
import { jsonHttpTestLayer } from "pi-cosmic-core/testing";
import {
  OpenAICompactionBoundaryError,
  OpenAICompactionClient,
  type OpenAICompactRequest,
  type OpenAICompactionClientContract,
} from "../src/boundary/openai-compaction.ts";
import { reconstructOpenAIContext } from "../src/compaction/context.ts";
import { projectOpenAIResponseInput } from "../src/compaction/projection.ts";
import { OpenAICompactionService } from "../src/compaction/service.ts";
import {
  decodeOpenAICompactionDetails,
  OPENAI_COMPACTION_SUMMARY,
  type OpenAICompactionJsonObject,
} from "../src/compaction/protocol.ts";
import { initialFastSnapshot } from "../src/fast/controller.ts";
import { initialProjection } from "../src/usage/projection.ts";
import { makeResolvedConfig } from "./helpers.ts";

const model = (
  id = "gpt-5.5",
  provider: Model<Api>["provider"] = "openai",
  api: Api = "openai-responses",
): Model<Api> => ({
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
});

// Pure leak-check serialization stays outside Effect code on purpose: it scans opaque
// runtime failure values for secret fragments.
const serializedSnapshot = <Value>(value: Value): string => JSON.stringify(value) ?? "";

const entry = (id: string, content: string): SessionEntry => ({
  type: "custom_message",
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  customType: "test",
  content,
  display: false,
});

const compactEvent = (firstKeptEntryId = "kept"): SessionBeforeCompactEvent => {
  return {
    type: "session_before_compact",
    branchEntries: [entry(firstKeptEntryId, "kept")],
    customInstructions: "retain decisions",
    reason: "manual",
    signal: new AbortController().signal,
    willRetry: false,
    preparation: {
      firstKeptEntryId,
      tokensBefore: 321,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1000 },
    },
  };
};

function fixture(options: {
  readonly enabled: boolean;
  readonly currentModel?: Model<Api>;
  readonly branch?: SessionEntry[];
  readonly contextEntries?: SessionEntry[];
  readonly hostileBranch?: boolean;
  readonly manager?: SessionManager;
  readonly streamSimple?: ExtensionContext["modelRegistry"]["streamSimple"];
}) {
  const branch = options.branch ?? [];
  const contextEntries = options.contextEntries ?? [];
  const ctxFixture = {
    modelRegistry: { streamSimple: options.streamSimple },
    thinkingLevel: "high" as const,
    model: options.currentModel ?? model(),
    getSystemPrompt: () =>
      options.manager
        ? getCurrentSystemPrompt(convertToLlm(options.manager.buildSessionContext().messages))
        : "system contract",
    sessionManager: options.manager ?? {
      getBranch: () => {
        if (options.hostileBranch) throw new Error("host-context-secret");
        return branch;
      },
      buildContextEntries: () => contextEntries,
    },
  };
  const context = MutableRef.make(
    // SAFETY: Service tests exercise only the context members implemented by this fixture.
    ctxFixture as typeof ctxFixture & ExtensionContext,
  );
  const projection = MutableRef.make({
    ...initialProjection(),
    config: makeResolvedConfig({ compaction: { enabled: options.enabled } }),
  });
  const fastProjection = MutableRef.make(initialFastSnapshot());
  return { branch, contextEntries, context, projection, fastProjection };
}

function serviceLayer(
  target: ReturnType<typeof fixture>,
  compact: OpenAICompactionClientContract["compact"],
) {
  return OpenAICompactionService.layer({
    context: target.context,
    projection: target.projection,
    fastProjection: target.fastProjection,
  }).pipe(
    Layer.provide(Layer.succeed(OpenAICompactionClient, OpenAICompactionClient.of({ compact }))),
  );
}

describe("OpenAICompactionClient", () => {
  it.effect("retains cached input details from decoded usage", () => {
    const layer = OpenAICompactionClient.layer(() => ({
      getApiKeyAndHeaders: () => Promise.resolve({ ok: true as const, apiKey: "test-api-key" }),
    })).pipe(
      Layer.provide(
        jsonHttpTestLayer(() =>
          Effect.succeed({
            status: 200,
            body: {
              object: "response.compaction",
              output: [{ type: "compaction" }],
              usage: {
                input_tokens: 12,
                input_tokens_details: { cached_tokens: 5 },
                output_tokens: 3,
                total_tokens: 15,
              },
            },
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const client = yield* OpenAICompactionClient;
      const result = yield* client.compact({
        model: { ...model(), api: "openai-responses" },
        input: [],
      });
      expect(result.usage).toEqual({
        inputTokens: 12,
        cachedInputTokens: 5,
        outputTokens: 3,
        totalTokens: 15,
      });
    }).pipe(provideBuiltLayer(layer));
  });
  it.effect("rejects fractional usage before returning a checkpoint", () => {
    const layer = OpenAICompactionClient.layer(() => ({
      getApiKeyAndHeaders: () => Promise.resolve({ ok: true as const, apiKey: "test-api-key" }),
    })).pipe(
      Layer.provide(
        jsonHttpTestLayer(() =>
          Effect.succeed({
            status: 200,
            body: {
              object: "response.compaction",
              output: [{ type: "compaction" }],
              usage: { input_tokens: 1.5, output_tokens: 2, total_tokens: 3.5 },
            },
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const client = yield* OpenAICompactionClient;
      // SAFETY: The fixture fixes the API discriminator to the boundary's supported API.
      const requestModel = model() as Model<"openai-responses">;
      const result = yield* client
        .compact({ model: requestModel, input: [{ type: "message" }] })
        .pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(OpenAICompactionBoundaryError);
        expect(result.failure.operation).toBe("decode");
      }
    }).pipe(provideBuiltLayer(layer));
  });
});

describe("OpenAICompactionService", () => {
  for (const supportsMidConvoSystemMessages of [false, true]) {
    it.effect(
      `preserves native context across repeated compactions, mid-conversation=${supportsMidConvoSystemMessages}`,
      () => {
        const manager = SessionManager.inMemory("/virtual/compaction-test");
        const requestModel: Model<"openai-responses"> = {
          ...model(),
          api: "openai-responses",
          compat: { supportsMidConvoSystemMessages },
          cost: {
            input: 1,
            output: 2,
            cacheRead: 0.5,
            cacheWrite: 0,
            tiers: [{ inputTokensAbove: 10, input: 4, output: 8, cacheRead: 2, cacheWrite: 0 }],
          },
        };
        manager.appendMessage({
          role: "system",
          content: "opaque initial content",
          sections: { rules: "initial rules" },
          toolsAdded: [{ name: "old", description: "old tool", parameters: { type: "object" } }],
          timestamp: 1,
        });
        manager.appendMessage({ role: "user", content: "first question", timestamp: 2 });
        const target = fixture({ enabled: true, currentModel: requestModel, manager });
        const requests: OpenAICompactRequest[] = [];
        const client: OpenAICompactionClientContract["compact"] = (request) =>
          Effect.sync(() => {
            requests.push(request);
            return {
              output: [{ type: "compaction", encrypted_content: `checkpoint-${requests.length}` }],
              usage: { inputTokens: 12, cachedInputTokens: 5, outputTokens: 3, totalTokens: 15 },
            };
          });
        return Effect.gen(function* () {
          const service = yield* OpenAICompactionService;
          for (let round = 0; round < 4; round++) {
            const firstId = manager.getBranch()[0]!.id;
            const result = yield* service.compact(compactEvent(firstId));
            expect(result).toBeDefined();
            if (!result) throw new Error("Expected compaction");
            expect(result.usage).toMatchObject({
              input: 7,
              output: 3,
              cacheRead: 5,
              cacheWrite: 0,
              totalTokens: 15,
            });
            expect(result.usage?.cost.total).toBeCloseTo(0.000062);
            expect(decodeOpenAICompactionDetails(result.details)?.checkpoint.usage).toEqual({
              inputTokens: 12,
              cachedInputTokens: 5,
              outputTokens: 3,
              totalTokens: 15,
            });
            manager.appendCompaction(
              result.summary,
              result.firstKeptEntryId,
              result.tokensBefore,
              result.details,
              true,
              result.usage,
            );
            // Inspect before any fresh update can hide stale snapshot replay.
            const compactedMessages = manager.buildSessionContext().messages;
            const compactedPrompt = getCurrentSystemPrompt(convertToLlm(compactedMessages));
            expect(compactedPrompt.split("opaque initial content")).toHaveLength(2);
            expect(
              getCurrentTools(convertToLlm(compactedMessages)).map((tool) => tool.name),
            ).toEqual([round === 0 ? "old" : `tool-${round - 1}`]);
            expect(compactedPrompt).toContain(
              round === 0 ? "initial rules" : `updated rules ${round - 1}`,
            );
            const filteredCompacted = yield* service.filterContext(compactedMessages);
            const compactedInput = convertResponsesMessages(
              requestModel,
              normalizeContext({ messages: convertToLlm(filteredCompacted ?? compactedMessages) }),
              new Set(["openai"]),
              { supportsMidConvoSystemMessages },
            );
            const compactedPayload = yield* service.inject({ input: compactedInput });
            expect(compactedPayload?.input).toHaveLength(2);
            expect(compactedPayload?.input[1]).toMatchObject({
              encrypted_content: `checkpoint-${round + 1}`,
            });
            expect(
              manager.buildContextEntries().filter((item) => item.type === "compaction"),
            ).toHaveLength(1);
            expect((yield* service.compact(compactEvent()).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            manager.appendMessage({
              role: "system",
              content: "",
              sections: { rules: `updated rules ${round}` },
              toolsRemoved: [{ name: round === 0 ? "old" : `tool-${round - 1}` }],
              toolsAdded: [
                { name: `tool-${round}`, description: "new tool", parameters: { type: "object" } },
              ],
              timestamp: 10 + round,
            });
            manager.appendMessage({
              role: "user",
              content: `new question ${round}`,
              timestamp: 15 + round,
            });
            manager.appendMessage({
              role: "assistant",
              api: requestModel.api,
              provider: requestModel.provider,
              model: requestModel.id,
              content: [
                {
                  type: "toolCall",
                  id: `call_${round}|fc_${round}`,
                  name: "read",
                  arguments: { path: `tail-${round}` },
                },
              ],
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 20 + round,
            });
            manager.appendMessage({
              role: "toolResult",
              toolCallId: `call_${round}|fc_${round}`,
              toolName: "read",
              content: [{ type: "text", text: `result-${round}` }],
              isError: false,
              timestamp: 30 + round,
            });
            const messages = manager.buildSessionContext().messages;
            const filtered = yield* service.filterContext(messages);
            const input = convertResponsesMessages(
              requestModel,
              normalizeContext({ messages: convertToLlm(filtered ?? messages) }),
              new Set(["openai"]),
              { supportsMidConvoSystemMessages },
            );
            const injected = yield* service.inject({ input });
            expect(injected?.input).toHaveLength(supportsMidConvoSystemMessages ? 6 : 5);
            expect(serializedSnapshot(injected?.input).split(`new question ${round}`)).toHaveLength(
              2,
            );
            expect(injected?.input.slice(-2)).toEqual(input.slice(-2));
            expect(injected?.input[1]).toMatchObject({
              encrypted_content: `checkpoint-${round + 1}`,
            });
          }
          expect(requests[1]?.instructions).toContain("updated rules 0");
          expect(requests[1]?.input).toHaveLength(supportsMidConvoSystemMessages ? 5 : 4);
          expect(serializedSnapshot(requests[2]?.input)).not.toContain("new question 0");
          expect(serializedSnapshot(requests[2]?.input)).not.toContain("updated rules 0");
          expect(manager.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(0);
          expect(
            manager
              .getEntries()
              .filter((entry) => entry.type === "compaction")
              .map((entry) => entry.usage?.totalTokens),
          ).toEqual([15, 15, 15, 15]);
          for (const state of ["disabled", "model", "provider"] as const) {
            MutableRef.set(target.projection, {
              ...MutableRef.get(target.projection),
              config: makeResolvedConfig({ compaction: { enabled: state !== "disabled" } }),
            });
            MutableRef.set(target.context, {
              ...MutableRef.get(target.context),
              model:
                state === "disabled"
                  ? requestModel
                  : state === "model"
                    ? model("changed")
                    : model("changed", "anthropic", "anthropic-messages"),
            });
            const repaired = yield* service.filterContext(manager.buildSessionContext().messages);
            expect(serializedSnapshot(repaired)).toContain("first question");
            for (let round = 0; round < 4; round++) {
              expect(serializedSnapshot(repaired)).toContain(`new question ${round}`);
              expect(serializedSnapshot(repaired)).toContain(`result-${round}`);
            }
            expect(getCurrentSystemPrompt(convertToLlm(repaired!))).toContain("updated rules 3");
            expect(getCurrentTools(convertToLlm(repaired!)).map((tool) => tool.name)).toEqual([
              "tool-3",
            ]);
            expect(yield* service.inject({ input: [] })).toBeUndefined();
          }
          manager.appendCompaction("ordinary summary", manager.getLeafId()!, 10);
          expect(yield* service.inject({ input: [] })).toBeUndefined();
          expect(
            yield* service.filterContext(manager.buildSessionContext().messages),
          ).toBeUndefined();
        }).pipe(provideBuiltLayer(serviceLayer(target, client)));
      },
    );
  }
  for (const supportsMidConvoSystemMessages of [false, true]) {
    for (const anchor of ["system", "custom", "usage", "assistant"] as const) {
      it.effect(
        `counts the retained ${anchor} anchor, mid-conversation=${supportsMidConvoSystemMessages}`,
        () => {
          const manager = SessionManager.inMemory("/virtual/anchors");
          const requestModel: Model<"openai-responses"> = {
            ...model(),
            api: "openai-responses",
            compat: { supportsMidConvoSystemMessages },
          };
          const usage = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          manager.appendMessage({ role: "system", content: "opaque anchor rules", timestamp: 0 });
          const target = fixture({ enabled: true, currentModel: requestModel, manager });
          const requests: OpenAICompactRequest[] = [];
          const client: OpenAICompactionClientContract["compact"] = (request) =>
            Effect.sync(() => {
              requests.push(request);
              return {
                output: [{ type: "compaction", encrypted_content: `anchor-${requests.length}` }],
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              };
            });
          return Effect.gen(function* () {
            const service = yield* OpenAICompactionService;
            for (let round = 0; round < 3; round++) {
              manager.appendMessage({
                role: "user",
                content: `question-${round}`,
                timestamp: round + 1,
              });
              if (anchor === "system")
                manager.appendMessage({
                  role: "system",
                  content: "",
                  sections: { rules: `rule-${round}` },
                  timestamp: round + 10,
                });
              if (anchor === "custom") manager.appendCustomEntry("anchor", { round });
              if (anchor === "usage") manager.appendUsage("test", "openai", requestModel.id, usage);
              if (anchor === "assistant")
                manager.appendMessage({
                  role: "assistant",
                  api: requestModel.api,
                  provider: requestModel.provider,
                  model: requestModel.id,
                  content: [{ type: "text", text: `answer-${round}` }],
                  usage,
                  stopReason: "stop",
                  timestamp: round + 10,
                });
              const result = yield* service.compact(compactEvent());
              if (!result) throw new Error("Expected compaction");
              expect(decodeOpenAICompactionDetails(result.details)?.checkpoint.rawInputCount).toBe(
                anchor === "assistant" ? 1 : 0,
              );
              manager.appendCompaction(
                result.summary,
                result.firstKeptEntryId,
                result.tokensBefore,
                result.details,
                true,
                result.usage,
              );
              const messages = manager.buildSessionContext().messages;
              const filtered = yield* service.filterContext(messages);
              const input = convertResponsesMessages(
                requestModel,
                normalizeContext({ messages: convertToLlm(filtered ?? messages) }),
                new Set(["openai"]),
                { supportsMidConvoSystemMessages },
              );
              const injected = yield* service.inject({ input });
              expect(injected?.input).toHaveLength(2);
              expect(injected?.input[1]).toMatchObject({
                encrypted_content: `anchor-${round + 1}`,
              });
              expect(serializedSnapshot(injected?.input).split("opaque anchor rules")).toHaveLength(
                2,
              );
              const requestText = serializedSnapshot(requests[round]?.input);
              expect(requestText.split(`question-${round}`)).toHaveLength(2);
              if (round > 0) {
                expect(requestText).toContain(`anchor-${round}`);
                expect(requestText).not.toContain(`question-${round - 1}`);
                expect(requestText).not.toContain(`answer-${round - 1}`);
              }
            }
          }).pipe(provideBuiltLayer(serviceLayer(target, client)));
        },
      );
    }
  }

  it.effect("is a no-op when disabled or the current model is ineligible", () => {
    let requests = 0;
    const client = (_request: OpenAICompactRequest) =>
      Effect.sync(() => {
        requests++;
        return {
          output: [{ ownedCheckpoint: true }],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      });
    const disabled = fixture({ enabled: false });
    const ineligible = fixture({
      enabled: true,
      currentModel: model("gpt-5.5", "openai-codex", "openai-codex-responses"),
    });

    return Effect.gen(function* () {
      const disabledResult = yield* Effect.gen(function* () {
        const service = yield* OpenAICompactionService;
        expect(yield* service.compact(compactEvent())).toBeUndefined();
        expect(yield* service.filterContext([])).toBeUndefined();
        expect(yield* service.inject({ input: [] })).toBeUndefined();
      }).pipe(provideBuiltLayer(serviceLayer(disabled, client)));

      const ineligibleResult = yield* Effect.gen(function* () {
        const service = yield* OpenAICompactionService;
        expect(yield* service.compact(compactEvent())).toBeUndefined();
        expect(yield* service.inject({ input: [] })).toBeUndefined();
      }).pipe(provideBuiltLayer(serviceLayer(ineligible, client)));

      expect(disabledResult).toBeUndefined();
      expect(ineligibleResult).toBeUndefined();
      expect(requests).toBe(0);
    });
  });

  it.effect("creates, reuses, filters, and injects native checkpoints", () => {
    const target = fixture({
      enabled: true,
      branch: [entry("one", "first turn"), { ...entry("two", "second turn"), parentId: "one" }],
      contextEntries: [entry("one", "first turn"), entry("two", "second turn")],
    });
    const requests: OpenAICompactRequest[] = [];
    const outputs: Array<readonly OpenAICompactionJsonObject[]> = [];
    const client = (request: OpenAICompactRequest) =>
      Effect.sync(() => {
        requests.push(request);
        const output = [{ ownedCheckpoint: requests.length }] as const;
        outputs.push(output);
        return {
          output,
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        };
      });

    return Effect.gen(function* () {
      const service = yield* OpenAICompactionService;
      const first = yield* service.compact(compactEvent());
      expect(first?.firstKeptEntryId).toBe("two");
      expect(first?.tokensBefore).toBe(321);
      const firstDetails = decodeOpenAICompactionDetails(first?.details);
      expect(firstDetails).toBeDefined();
      expect(firstDetails?.checkpoint.rawInputCount).toBe(1);

      target.branch.push({
        type: "compaction",
        id: "checkpoint-entry",
        parentId: "two",
        timestamp: "2026-01-01T00:00:01.000Z",
        summary: first?.summary ?? "",
        firstKeptEntryId: first?.firstKeptEntryId ?? "kept",
        tokensBefore: first?.tokensBefore ?? 0,
        details: first?.details,
      });
      target.contextEntries.splice(0, 1);
      target.contextEntries.push(entry("three", "third turn"));
      target.branch.push({ ...entry("three", "third turn"), parentId: "checkpoint-entry" });

      const second = yield* service.compact(compactEvent("kept-again"));
      const secondDetails = decodeOpenAICompactionDetails(second?.details);
      expect(secondDetails?.checkpoint.rawInputCount).toBe(1);
      expect(requests[1]?.input.slice(0, outputs[0]?.length)).toEqual(outputs[0]);
      expect(requests[1]?.input.length).toBe(2);

      target.branch.push({
        type: "compaction",
        id: "checkpoint-entry-2",
        parentId: "three",
        timestamp: "2026-01-01T00:00:02.000Z",
        summary: second?.summary ?? "",
        firstKeptEntryId: second?.firstKeptEntryId ?? "kept-again",
        tokensBefore: second?.tokensBefore ?? 0,
        details: second?.details,
      });
      const messages = buildSessionContext(target.branch).messages;
      const repaired = yield* service.filterContext(messages);
      expect(serializedSnapshot(repaired)).toContain("first turn");
      expect(serializedSnapshot(repaired)).toContain("second turn");
      expect(serializedSnapshot(repaired)).toContain("third turn");
      expect(serializedSnapshot(repaired)).not.toContain(OPENAI_COMPACTION_SUMMARY);
      const input = projectOpenAIResponseInput(
        { ...model(), api: "openai-responses" },
        reconstructOpenAIContext(target.branch)!.entries,
      )!;
      const system = { role: "system", content: "system" };
      const tail = { type: "message", role: "user", content: "extension tail" };
      const injected = yield* service.inject({
        input: [system, ...input, tail],
        marker: "preserved",
      });
      expect(injected).toEqual({
        input: [system, ...(outputs[1] ?? []), tail],
        marker: "preserved",
      });
      expect(yield* service.inject({ input: [system, tail, ...input] })).toBeUndefined();
    }).pipe(provideBuiltLayer(serviceLayer(target, client)));
  });

  for (const mode of ["disabled", "model", "provider", "endpoint"] as const) {
    it.effect(`native fallback restores complete dialogue after ${mode}`, () => {
      const manager = SessionManager.inMemory("/virtual/native-fallback");
      manager.appendMessage({ role: "system", content: "rules", timestamp: 0 });
      manager.appendMessage({ role: "user", content: "old dialogue", timestamp: 1 });
      const summaries: string[] = [];
      let failEndpoint = false;
      const target = fixture({
        enabled: true,
        manager,
        streamSimple: (requestModel, context, options) => {
          summaries.push(serializedSnapshot(context));
          expect(options?.reasoning).toBe("high");
          expect(options?.sessionId).toBe(manager.getSessionId());
          expect(options?.signal?.aborted).toBe(false);
          const stream = createAssistantMessageEventStream();
          stream.push({
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              api: requestModel.api,
              provider: requestModel.provider,
              model: requestModel.id,
              content: [{ type: "text", text: "native summary" }],
              stopReason: "stop",
              timestamp: 1,
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          });
          return stream;
        },
      });
      const client: OpenAICompactionClientContract["compact"] = () =>
        failEndpoint
          ? Effect.fail(
              new OpenAICompactionBoundaryError({ operation: "request", message: "unavailable" }),
            )
          : Effect.succeed({
              output: [{ type: "compaction", encrypted_content: "checkpoint" }],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
      return Effect.gen(function* () {
        const service = yield* OpenAICompactionService;
        for (let i = 0; i < 2; i++) {
          const result = yield* service.compact(compactEvent());
          if (!result) throw new Error("Expected checkpoint");
          manager.appendCompaction(
            result.summary,
            result.firstKeptEntryId,
            result.tokensBefore,
            result.details,
            true,
          );
          manager.appendMessage({ role: "user", content: `dialogue-${i}`, timestamp: 2 + i });
        }
        if (mode === "disabled")
          MutableRef.set(target.projection, {
            ...MutableRef.get(target.projection),
            config: makeResolvedConfig({ compaction: { enabled: false } }),
          });
        if (mode === "model" || mode === "provider")
          MutableRef.set(target.context, {
            ...MutableRef.get(target.context),
            model:
              mode === "model"
                ? model("another-model")
                : model("other", "anthropic", "anthropic-messages"),
          });
        if (mode === "endpoint") failEndpoint = true;
        const repaired = yield* service.filterContext(manager.buildSessionContext().messages);
        expect(serializedSnapshot(repaired)).toContain("old dialogue");
        expect(serializedSnapshot(repaired)).toContain("dialogue-0");
        const result = yield* service.compact(compactEvent());
        if (!result) throw new Error("Expected native fallback");
        expect(decodeOpenAICompactionDetails(result.details)).toBeUndefined();
        expect(summaries).toHaveLength(1);
        expect(summaries[0]).toContain("old dialogue");
        expect(summaries[0]).toContain("dialogue-0");
        expect(summaries[0]).toContain("retain decisions");
        manager.appendCompaction(
          result.summary,
          result.firstKeptEntryId,
          result.tokensBefore,
          result.details,
          true,
        );
        expect(
          yield* service.filterContext(manager.buildSessionContext().messages),
        ).toBeUndefined();
        expect(serializedSnapshot(manager.buildSessionContext().messages)).not.toContain(
          OPENAI_COMPACTION_SUMMARY,
        );
      }).pipe(provideBuiltLayer(serviceLayer(target, client)));
    });
  }

  for (const supportsMidConvoSystemMessages of [false, true]) {
    it.effect(
      `preserves native retry omissions across turns, compactions, and reload, mid-conversation=${supportsMidConvoSystemMessages}`,
      () => {
        const manager = SessionManager.inMemory("/virtual/retry-omissions");
        const requestModel: Model<"openai-responses"> = {
          ...model(),
          api: "openai-responses",
          compat: { supportsMidConvoSystemMessages },
        };
        manager.appendMessage({ role: "system", content: "retry rules", timestamp: 0 });
        manager.appendMessage({ role: "user", content: "original question", timestamp: 1 });
        const target = fixture({ enabled: true, manager, currentModel: requestModel });
        const omitted = new Set<string>();
        const nativeMessages = () =>
          manager
            .buildContextEntries()
            .filter((entry) => !omitted.has(entry.id))
            .flatMap(sessionEntryToContextMessages);
        const assistant = (
          stopReason: "error" | "length" | "stop",
          text: string,
          timestamp: number,
        ) =>
          manager.appendMessage({
            role: "assistant",
            api: requestModel.api,
            provider: requestModel.provider,
            model: requestModel.id,
            content: [{ type: "text", text }],
            stopReason,
            timestamp,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          });
        const requests: OpenAICompactRequest[] = [];
        const client: OpenAICompactionClientContract["compact"] = (request) =>
          Effect.sync(() => {
            requests.push(request);
            return {
              output: [
                { type: "compaction", encrypted_content: `retry-checkpoint-${requests.length}` },
              ],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          });
        return Effect.gen(function* () {
          const service = yield* OpenAICompactionService;
          const first = yield* service.compact(compactEvent());
          if (!first) throw new Error("Expected checkpoint");
          manager.appendCompaction(
            first.summary,
            first.firstKeptEntryId,
            first.tokensBefore,
            first.details,
            true,
          );
          manager.appendMessage({ role: "user", content: "retry question", timestamp: 2 });
          const failedId = assistant("error", "503 failed response", 3);
          omitted.add(failedId);
          const retryContext = yield* service.filterContext(nativeMessages());
          expect(serializedSnapshot(retryContext)).toContain("original question");
          expect(serializedSnapshot(retryContext)).not.toContain("503 failed response");
          assistant("stop", "successful retry", 4);
          manager.appendMessage({ role: "user", content: "subsequent turn", timestamp: 5 });
          const subsequent = yield* service.filterContext(nativeMessages());
          expect(serializedSnapshot(subsequent)).toContain("successful retry");
          expect(serializedSnapshot(subsequent)).not.toContain("503 failed response");
          const second = yield* service.compact(compactEvent());
          if (!second) throw new Error("Expected checkpoint");
          expect(
            decodeOpenAICompactionDetails(second.details)?.checkpoint.omittedEntryIds,
          ).toContain(failedId);
          manager.appendCompaction(
            second.summary,
            second.firstKeptEntryId,
            second.tokensBefore,
            second.details,
            true,
          );
          manager.appendMessage({ role: "user", content: "overflow question", timestamp: 6 });
          const truncatedId = assistant("length", "TRUNCATED MUST NOT RESURRECT", 7);
          const overflowEvent = { ...compactEvent(), reason: "overflow" as const, willRetry: true };
          const overflow = yield* service.compact(overflowEvent);
          if (!overflow) throw new Error("Expected overflow checkpoint");
          expect(serializedSnapshot(requests.at(-1)?.input)).not.toContain(
            "TRUNCATED MUST NOT RESURRECT",
          );
          expect(
            decodeOpenAICompactionDetails(overflow.details)?.checkpoint.omittedEntryIds,
          ).toEqual([failedId, truncatedId]);
          manager.appendCompaction(
            overflow.summary,
            overflow.firstKeptEntryId,
            overflow.tokensBefore,
            overflow.details,
            true,
          );
          omitted.add(truncatedId);
          const continued = yield* service.filterContext(nativeMessages());
          expect(serializedSnapshot(continued)).toContain("overflow question");
          expect(serializedSnapshot(continued)).not.toContain("TRUNCATED MUST NOT RESURRECT");
          const input = convertResponsesMessages(
            requestModel,
            normalizeContext({ messages: convertToLlm(continued!) }),
            new Set(["openai"]),
            { supportsMidConvoSystemMessages },
          );
          const injected = yield* service.inject({ input });
          expect(injected?.input.filter((item) => item.type === "compaction")).toHaveLength(1);
          manager.appendMessage({ role: "user", content: "after overflow", timestamp: 8 });
          yield* service.filterContext(nativeMessages());
          const next = yield* service.compact(compactEvent());
          if (!next) throw new Error("Expected next checkpoint");
          expect(serializedSnapshot(requests.at(-1)?.input)).not.toContain(
            "TRUNCATED MUST NOT RESURRECT",
          );
          manager.appendCompaction(
            next.summary,
            next.firstKeptEntryId,
            next.tokensBefore,
            next.details,
            true,
          );
          const reloaded = fixture({ enabled: true, manager, currentModel: requestModel });
          yield* Effect.gen(function* () {
            const fresh = yield* OpenAICompactionService;
            const restored = yield* fresh.filterContext(manager.buildSessionContext().messages);
            expect(serializedSnapshot(restored)).toContain("successful retry");
            expect(serializedSnapshot(restored)).toContain("overflow question");
            expect(serializedSnapshot(restored)).not.toContain("TRUNCATED MUST NOT RESURRECT");
            expect(serializedSnapshot(restored)).not.toContain("503 failed response");
            const providerInput = convertResponsesMessages(
              requestModel,
              normalizeContext({ messages: convertToLlm(restored!) }),
              new Set(["openai"]),
              { supportsMidConvoSystemMessages },
            );
            const optimized = yield* fresh.inject({ input: providerInput });
            expect(optimized?.input.filter((item) => item.type === "compaction")).toHaveLength(1);
          }).pipe(provideBuiltLayer(serviceLayer(reloaded, client)));
        }).pipe(provideBuiltLayer(serviceLayer(target, client)));
      },
    );
  }

  for (const mode of ["abort", "failure", "no-cut", "prefix-mismatch"] as const) {
    it.effect(`fails closed on ${mode} with an owned checkpoint`, () => {
      const manager = SessionManager.inMemory("/virtual/fail-closed");
      const event = compactEvent();
      if (mode === "abort") {
        const controller = new AbortController();
        controller.abort();
        event.signal = controller.signal;
      }
      manager.appendMessage({ role: "user", content: "must survive", timestamp: 1 });
      let nativeCalls = 0;
      const target = fixture({
        enabled: true,
        manager,
        streamSimple: () => {
          nativeCalls++;
          throw new Error("native-private-secret");
        },
      });
      const client: OpenAICompactionClientContract["compact"] = () =>
        Effect.succeed({
          output: [{ type: "compaction", encrypted_content: "checkpoint" }],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
      return Effect.gen(function* () {
        const service = yield* OpenAICompactionService;
        const checkpoint = yield* service.compact(compactEvent());
        if (!checkpoint) throw new Error("Expected checkpoint");
        manager.appendCompaction(
          checkpoint.summary,
          checkpoint.firstKeptEntryId,
          checkpoint.tokensBefore,
          checkpoint.details,
          true,
        );
        MutableRef.set(target.projection, {
          ...MutableRef.get(target.projection),
          config: makeResolvedConfig({ compaction: { enabled: false } }),
        });
        if (mode !== "no-cut")
          manager.appendMessage({ role: "user", content: "tail", timestamp: 2 });
        const before = serializedSnapshot(manager.getBranch());
        const result =
          mode === "prefix-mismatch"
            ? yield* service.filterContext([]).pipe(Effect.result)
            : yield* service.compact(event).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(serializedSnapshot(result)).not.toContain("native-private-secret");
        expect(nativeCalls).toBe(mode === "failure" ? 1 : 0);
        expect(serializedSnapshot(manager.getBranch())).toBe(before);
      }).pipe(provideBuiltLayer(serviceLayer(target, client)));
    });
  }

  it.effect("maps hostile Pi session access to a typed context failure without disclosure", () => {
    const target = fixture({ enabled: true, hostileBranch: true });
    const client = (_request: OpenAICompactRequest) =>
      Effect.succeed({
        output: [{ ownedCheckpoint: true }],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });

    return Effect.gen(function* () {
      const service = yield* OpenAICompactionService;
      const result = yield* service.compact(compactEvent()).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("OpenAICompactionError");
        if (result.failure._tag === "OpenAICompactionError")
          expect(result.failure.operation).toBe("context");
        expect(serializedSnapshot(result.failure)).not.toContain("host-context-secret");
      }
    }).pipe(provideBuiltLayer(serviceLayer(target, client)));
  });
});
