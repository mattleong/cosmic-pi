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
  CompactionResult,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { provideBuiltLayer, type JsonValue } from "pi-cosmic-core";
import { extensionContextFixture, jsonHttpTestLayer } from "pi-cosmic-core/testing";
import {
  OpenAICompactionBoundaryError,
  OpenAICompactionClient,
  type OpenAICompactRequest,
  type OpenAICompactResult,
  type OpenAICompactionClientContract,
} from "../src/boundary/openai-compaction.ts";
import { reconstructOpenAIContext } from "../src/compaction/context.ts";
import { projectOpenAIResponseInput } from "../src/compaction/projection.ts";
import { OpenAICompactionService } from "../src/compaction/service.ts";
import {
  decodeOpenAICompactionDetails,
  OPENAI_COMPACTION_SUMMARY,
} from "../src/compaction/protocol.ts";
import { initialFastSnapshot } from "../src/fast/controller.ts";
import { initialProjection } from "../src/usage/projection.ts";
import {
  appendAssistant,
  assistantMessage,
  makeResolvedConfig,
  serializedSnapshot,
  testModel,
  zeroUsage,
} from "./helpers.ts";

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
  readonly hostileBranch?: boolean;
  readonly manager?: SessionManager;
  readonly streamSimple?: ExtensionContext["modelRegistry"]["streamSimple"];
}) {
  const branch = options.branch ?? [];
  const ctxFixture = {
    modelRegistry: { streamSimple: options.streamSimple },
    thinkingLevel: "high" as const,
    model: options.currentModel ?? testModel(),
    getSystemPrompt: () =>
      options.manager
        ? getCurrentSystemPrompt(convertToLlm(options.manager.buildSessionContext().messages))
        : "system contract",
    sessionManager: options.manager ?? {
      getBranch: () => {
        if (options.hostileBranch) throw new Error("host-context-secret");
        return branch;
      },
    },
  };
  const context = MutableRef.make(extensionContextFixture(ctxFixture));
  const projection = MutableRef.make({
    ...initialProjection(),
    config: makeResolvedConfig({ compaction: { enabled: options.enabled } }),
  });
  const fastProjection = MutableRef.make(initialFastSnapshot());
  const setEnabled = (enabled: boolean) =>
    MutableRef.update(projection, (current) => ({
      ...current,
      config: makeResolvedConfig({ compaction: { enabled } }),
    }));
  const setModel = (model: Model<Api>) =>
    MutableRef.update(context, (current) => ({ ...current, model }));
  return { branch, context, projection, fastProjection, setEnabled, setModel };
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

const clientLayer = (body: JsonValue) =>
  OpenAICompactionClient.layer(() => ({
    getApiKeyAndHeaders: () => Promise.resolve({ ok: true as const, apiKey: "test-api-key" }),
  })).pipe(Layer.provide(jsonHttpTestLayer(() => Effect.succeed({ status: 200, body }))));

const recordingClient = (
  prefix: string,
  usage: OpenAICompactResult["usage"] = { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
) => {
  const requests: OpenAICompactRequest[] = [];
  const client: OpenAICompactionClientContract["compact"] = (request) =>
    Effect.sync(() => {
      requests.push(request);
      return {
        output: [{ type: "compaction", encrypted_content: `${prefix}-${requests.length}` }],
        usage,
      };
    });
  return { requests, client };
};

const responsesInput = (
  requestModel: Model<"openai-responses">,
  messages: Parameters<typeof convertToLlm>[0],
) =>
  convertResponsesMessages(
    requestModel,
    normalizeContext({ messages: convertToLlm(messages) }),
    new Set(["openai"]),
    requestModel.compat,
  );

const commit = (manager: SessionManager, result: CompactionResult | undefined) => {
  if (!result) throw new Error("Expected compaction");
  manager.appendCompaction(
    result.summary,
    result.firstKeptEntryId,
    result.tokensBefore,
    result.details,
    true,
    result.usage,
  );
  return result;
};

describe("OpenAICompactionClient", () => {
  it.effect("retains cached input details from decoded usage", () => {
    const layer = clientLayer({
      object: "response.compaction",
      output: [{ type: "compaction" }],
      usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens: 3,
        total_tokens: 15,
      },
    });
    return Effect.gen(function* () {
      const client = yield* OpenAICompactionClient;
      const result = yield* client.compact({ model: testModel(), input: [] });
      expect(result.usage).toEqual({
        inputTokens: 12,
        cachedInputTokens: 5,
        outputTokens: 3,
        totalTokens: 15,
      });
    }).pipe(provideBuiltLayer(layer));
  });
  it.effect("rejects fractional usage before returning a checkpoint", () => {
    const layer = clientLayer({
      object: "response.compaction",
      output: [{ type: "compaction" }],
      usage: { input_tokens: 1.5, output_tokens: 2, total_tokens: 3.5 },
    });

    return Effect.gen(function* () {
      const client = yield* OpenAICompactionClient;
      const failure = yield* client
        .compact({ model: testModel(), input: [{ type: "message" }] })
        .pipe(Effect.flip);

      expect(failure).toBeInstanceOf(OpenAICompactionBoundaryError);
      expect(failure.operation).toBe("decode");
    }).pipe(provideBuiltLayer(layer));
  });
});

describe("OpenAICompactionService", () => {
  for (const supportsMidConvoSystemMessages of [false, true]) {
    it.effect(
      `preserves native context across repeated compactions, mid-conversation=${supportsMidConvoSystemMessages}`,
      () => {
        const manager = SessionManager.inMemory("/virtual/compaction-test");
        const requestModel = {
          ...testModel(),
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
        const { requests, client } = recordingClient("checkpoint", {
          inputTokens: 12,
          cachedInputTokens: 5,
          outputTokens: 3,
          totalTokens: 15,
        });
        return Effect.gen(function* () {
          const service = yield* OpenAICompactionService;
          for (let round = 0; round < 4; round++) {
            const firstId = manager.getBranch()[0]!.id;
            const result = commit(manager, yield* service.compact(compactEvent(firstId)));
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
            const compactedInput = responsesInput(
              requestModel,
              filteredCompacted ?? compactedMessages,
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
            manager.appendMessage(
              assistantMessage(
                [
                  {
                    type: "toolCall",
                    id: `call_${round}|fc_${round}`,
                    name: "read",
                    arguments: { path: `tail-${round}` },
                  },
                ],
                { stopReason: "toolUse", timestamp: 20 + round },
              ),
            );
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
            const input = responsesInput(requestModel, filtered ?? messages);
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
          const requestModel = { ...testModel(), compat: { supportsMidConvoSystemMessages } };
          manager.appendMessage({ role: "system", content: "opaque anchor rules", timestamp: 0 });
          const target = fixture({ enabled: true, currentModel: requestModel, manager });
          const { requests, client } = recordingClient("anchor");
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
              if (anchor === "usage")
                manager.appendUsage("test", "openai", requestModel.id, zeroUsage);
              if (anchor === "assistant")
                manager.appendMessage(
                  assistantMessage([{ type: "text", text: `answer-${round}` }], {
                    timestamp: round + 10,
                  }),
                );
              const result = commit(manager, yield* service.compact(compactEvent()));
              expect(decodeOpenAICompactionDetails(result.details)?.checkpoint.rawInputCount).toBe(
                anchor === "assistant" ? 1 : 0,
              );
              const messages = manager.buildSessionContext().messages;
              const filtered = yield* service.filterContext(messages);
              const input = responsesInput(requestModel, filtered ?? messages);
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
    const { requests, client } = recordingClient("unused");
    const disabled = fixture({ enabled: false });
    const ineligible = fixture({
      enabled: true,
      currentModel: testModel("gpt-5.5", "openai-codex", "openai-codex-responses"),
    });

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* OpenAICompactionService;
        expect(yield* service.compact(compactEvent())).toBeUndefined();
        expect(yield* service.filterContext([])).toBeUndefined();
        expect(yield* service.inject({ input: [] })).toBeUndefined();
      }).pipe(provideBuiltLayer(serviceLayer(disabled, client)));

      yield* Effect.gen(function* () {
        const service = yield* OpenAICompactionService;
        expect(yield* service.compact(compactEvent())).toBeUndefined();
        expect(yield* service.inject({ input: [] })).toBeUndefined();
      }).pipe(provideBuiltLayer(serviceLayer(ineligible, client)));

      expect(requests).toHaveLength(0);
    });
  });

  for (const replacement of [null, { content: "revised covered dialogue" }])
    it.effect(
      `does not encrypt obsolete context after a persisted ${replacement ? "replacement" : "omission"}`,
      () => {
        const manager = SessionManager.inMemory("/virtual/edited-checkpoints");
        manager.appendMessage({ role: "system", content: "rules", timestamp: 0 });
        const covered = manager.appendMessage({
          role: "user",
          content: "raw original dialogue",
          timestamp: 1,
        });
        manager.appendContextEdit(covered, { content: "initial edited dialogue" });
        const target = fixture({ enabled: true, manager });
        const { requests, client } = recordingClient("edited-checkpoint");
        return Effect.gen(function* () {
          const service = yield* OpenAICompactionService;
          commit(manager, yield* service.compact(compactEvent()));
          expect(serializedSnapshot(requests[0]?.input)).toContain("initial edited dialogue");
          expect(serializedSnapshot(requests[0]?.input)).not.toContain("raw original dialogue");
          manager.appendContextEdit(covered, replacement);
          const messages = yield* service.filterContext(manager.buildSessionContext().messages);
          expect(serializedSnapshot(messages)).not.toContain("initial edited dialogue");
          const input = responsesInput(testModel(), messages!);
          expect(yield* service.inject({ input })).toBeUndefined();
          manager.appendMessage({ role: "user", content: "new tail", timestamp: 2 });
          commit(manager, yield* service.compact(compactEvent()));
          const text = serializedSnapshot(requests[1]?.input);
          expect(text).not.toContain("edited-checkpoint-1");
          expect(text).not.toContain("initial edited dialogue");
          expect(text).not.toContain("raw original dialogue");
          expect(text).toContain("new tail");
          if (replacement) expect(text).toContain(replacement.content);
          const repaired = yield* service.filterContext(manager.buildSessionContext().messages);
          const injected = yield* service.inject({ input: responsesInput(testModel(), repaired!) });
          expect(serializedSnapshot(injected?.input)).toContain("edited-checkpoint-2");
        }).pipe(provideBuiltLayer(serviceLayer(target, client)));
      },
    );

  it.effect("creates, reuses, filters, and injects native checkpoints", () => {
    const target = fixture({
      enabled: true,
      branch: [entry("one", "first turn"), { ...entry("two", "second turn"), parentId: "one" }],
    });
    const { requests, client } = recordingClient("owned");
    const output = (round: number) => [{ type: "compaction", encrypted_content: `owned-${round}` }];

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
      target.branch.push({ ...entry("three", "third turn"), parentId: "checkpoint-entry" });

      const second = yield* service.compact(compactEvent("kept-again"));
      const secondDetails = decodeOpenAICompactionDetails(second?.details);
      expect(secondDetails?.checkpoint.rawInputCount).toBe(1);
      expect(requests[1]?.input.slice(0, 1)).toEqual(output(1));
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
        testModel(),
        reconstructOpenAIContext(target.branch)!.entries,
      )!;
      const system = { role: "system", content: "system" };
      const tail = { type: "message", role: "user", content: "extension tail" };
      const injected = yield* service.inject({
        input: [system, ...input, tail],
        marker: "preserved",
      });
      expect(injected).toEqual({
        input: [system, ...output(2), tail],
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
            message: assistantMessage([{ type: "text", text: "native summary" }], {
              api: requestModel.api,
              provider: requestModel.provider,
              model: requestModel.id,
            }),
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
          commit(manager, yield* service.compact(compactEvent()));
          manager.appendMessage({ role: "user", content: `dialogue-${i}`, timestamp: 2 + i });
        }
        if (mode === "disabled") target.setEnabled(false);
        if (mode === "model") target.setModel(testModel("another-model"));
        if (mode === "provider")
          target.setModel(testModel("other", "anthropic", "anthropic-messages"));
        if (mode === "endpoint") failEndpoint = true;
        const repaired = yield* service.filterContext(manager.buildSessionContext().messages);
        expect(serializedSnapshot(repaired)).toContain("old dialogue");
        expect(serializedSnapshot(repaired)).toContain("dialogue-0");
        const result = commit(manager, yield* service.compact(compactEvent()));
        expect(decodeOpenAICompactionDetails(result.details)).toBeUndefined();
        expect(summaries).toHaveLength(1);
        expect(summaries[0]).toContain("old dialogue");
        expect(summaries[0]).toContain("dialogue-0");
        expect(summaries[0]).toContain("retain decisions");
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
        const requestModel = { ...testModel(), compat: { supportsMidConvoSystemMessages } };
        manager.appendMessage({ role: "system", content: "retry rules", timestamp: 0 });
        manager.appendMessage({ role: "user", content: "original question", timestamp: 1 });
        const target = fixture({ enabled: true, manager, currentModel: requestModel });
        const omitted = new Set<string>();
        const nativeMessages = () =>
          manager
            .buildContextEntries()
            .filter((entry) => !omitted.has(entry.id))
            .flatMap(sessionEntryToContextMessages);
        const { requests, client } = recordingClient("retry-checkpoint");
        return Effect.gen(function* () {
          const service = yield* OpenAICompactionService;
          commit(manager, yield* service.compact(compactEvent()));
          manager.appendMessage({ role: "user", content: "retry question", timestamp: 2 });
          const failedId = appendAssistant(manager, "error", "503 failed response", 3);
          omitted.add(failedId);
          const retryContext = yield* service.filterContext(nativeMessages());
          expect(serializedSnapshot(retryContext)).toContain("original question");
          expect(serializedSnapshot(retryContext)).not.toContain("503 failed response");
          appendAssistant(manager, "stop", "successful retry", 4);
          manager.appendMessage({ role: "user", content: "subsequent turn", timestamp: 5 });
          const subsequent = yield* service.filterContext(nativeMessages());
          expect(serializedSnapshot(subsequent)).toContain("successful retry");
          expect(serializedSnapshot(subsequent)).not.toContain("503 failed response");
          const second = commit(manager, yield* service.compact(compactEvent()));
          expect(
            decodeOpenAICompactionDetails(second.details)?.checkpoint.omittedEntryIds,
          ).toContain(failedId);
          manager.appendMessage({ role: "user", content: "overflow question", timestamp: 6 });
          const truncatedId = appendAssistant(manager, "length", "TRUNCATED MUST NOT RESURRECT", 7);
          const overflowEvent = { ...compactEvent(), reason: "overflow" as const, willRetry: true };
          const overflow = commit(manager, yield* service.compact(overflowEvent));
          expect(serializedSnapshot(requests.at(-1)?.input)).not.toContain(
            "TRUNCATED MUST NOT RESURRECT",
          );
          expect(
            decodeOpenAICompactionDetails(overflow.details)?.checkpoint.omittedEntryIds,
          ).toEqual([failedId, truncatedId]);
          omitted.add(truncatedId);
          const continued = yield* service.filterContext(nativeMessages());
          expect(serializedSnapshot(continued)).toContain("overflow question");
          expect(serializedSnapshot(continued)).not.toContain("TRUNCATED MUST NOT RESURRECT");
          const input = responsesInput(requestModel, continued!);
          const injected = yield* service.inject({ input });
          expect(injected?.input.filter((item) => item.type === "compaction")).toHaveLength(1);
          manager.appendMessage({ role: "user", content: "after overflow", timestamp: 8 });
          yield* service.filterContext(nativeMessages());
          commit(manager, yield* service.compact(compactEvent()));
          expect(serializedSnapshot(requests.at(-1)?.input)).not.toContain(
            "TRUNCATED MUST NOT RESURRECT",
          );
          const reloaded = fixture({ enabled: true, manager, currentModel: requestModel });
          yield* Effect.gen(function* () {
            const fresh = yield* OpenAICompactionService;
            const restored = yield* fresh.filterContext(manager.buildSessionContext().messages);
            expect(serializedSnapshot(restored)).toContain("successful retry");
            expect(serializedSnapshot(restored)).toContain("overflow question");
            expect(serializedSnapshot(restored)).not.toContain("TRUNCATED MUST NOT RESURRECT");
            expect(serializedSnapshot(restored)).not.toContain("503 failed response");
            const optimized = yield* fresh.inject({
              input: responsesInput(requestModel, restored!),
            });
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
      const { client } = recordingClient("checkpoint");
      return Effect.gen(function* () {
        const service = yield* OpenAICompactionService;
        commit(manager, yield* service.compact(compactEvent()));
        target.setEnabled(false);
        if (mode !== "no-cut")
          manager.appendMessage({ role: "user", content: "tail", timestamp: 2 });
        const before = serializedSnapshot(manager.getBranch());
        const failure =
          mode === "prefix-mismatch"
            ? yield* service.filterContext([]).pipe(Effect.flip)
            : yield* service.compact(event).pipe(Effect.flip);
        expect(serializedSnapshot(failure)).not.toContain("native-private-secret");
        expect(nativeCalls).toBe(mode === "failure" ? 1 : 0);
        expect(serializedSnapshot(manager.getBranch())).toBe(before);
      }).pipe(provideBuiltLayer(serviceLayer(target, client)));
    });
  }

  it.effect("maps hostile Pi session access to a typed context failure without disclosure", () => {
    const target = fixture({ enabled: true, hostileBranch: true });
    const { client } = recordingClient("unused");

    return Effect.gen(function* () {
      const service = yield* OpenAICompactionService;
      const failure = yield* service.compact(compactEvent()).pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "OpenAICompactionError", operation: "context" });
      expect(serializedSnapshot(failure)).not.toContain("host-context-secret");
    }).pipe(provideBuiltLayer(serviceLayer(target, client)));
  });
});
