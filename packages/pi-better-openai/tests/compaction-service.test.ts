import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  type Api,
  type Model,
  type RetryPolicy,
} from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { convertResponsesMessages } from "#pi-ai-openai-responses-shared";
import {
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
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { extensionContextFixture, provideBuiltLayer } from "pi-cosmic-core/testing";
import {
  OpenAICompactionBoundaryError,
  OpenAICompactionClient,
  type OpenAICompactRequest,
  type OpenAICompactResult,
  type OpenAICompactionClientContract,
} from "../src/boundary/openai-compaction.ts";
import { piRetryPolicy } from "../src/boundary/host-compaction.ts";
import { OpenAICompactionError, OpenAICompactionService } from "../src/compaction/service.ts";
import {
  decodeOpenAICompactionDetails,
  OPENAI_COMPACTION_SUMMARY,
} from "../src/compaction/protocol.ts";
import { initialFastSnapshot } from "../src/fast/controller.ts";
import {
  appendAssistant,
  assistantMessage,
  makeResolvedConfig,
  serializedSnapshot,
  testModel,
  zeroUsage,
} from "./helpers.ts";

const customMessageEntry = (id: string, content: string): SessionEntry => ({
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
    branchEntries: [customMessageEntry(firstKeptEntryId, "kept")],
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
  const base = extensionContextFixture({
    modelRegistry: options.streamSimple ? { streamSimple: options.streamSimple } : {},
    thinkingLevel: "high",
    model: options.currentModel ?? testModel(),
    getSystemPrompt: () =>
      options.manager
        ? getCurrentSystemPrompt(convertToLlm(options.manager.buildSessionContext().messages))
        : "system contract",
    sessionManager: {
      getBranch: () => {
        if (options.hostileBranch) throw new Error("host-context-secret");
        return branch;
      },
    },
  });
  const context = MutableRef.make<ExtensionContext>(
    options.manager ? { ...base, sessionManager: options.manager } : base,
  );
  const config = MutableRef.make(makeResolvedConfig({ compaction: { enabled: options.enabled } }));
  const fastProjection = MutableRef.make(initialFastSnapshot());
  const setEnabled = (enabled: boolean) =>
    MutableRef.set(config, makeResolvedConfig({ compaction: { enabled } }));
  const setModel = (model: Model<Api>) =>
    MutableRef.update(context, (current) => ({ ...current, model }));
  return { branch, context, config, fastProjection, setEnabled, setModel };
}

function serviceLayer(
  target: ReturnType<typeof fixture>,
  compact: OpenAICompactionClientContract["compact"],
  options: {
    readonly createCheckpoints?: boolean;
    readonly retryPolicy?: RetryPolicy | undefined;
  } = {},
) {
  return OpenAICompactionService.layer({
    context: target.context,
    config: () => MutableRef.get(target.config),
    fastProjection: target.fastProjection,
    createCheckpoints: options.createCheckpoints ?? true,
    retryPolicy: () => options.retryPolicy,
  }).pipe(
    Layer.provide(Layer.succeed(OpenAICompactionClient, OpenAICompactionClient.of({ compact }))),
  );
}

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

const summaryStream = (requestModel: Model<Api>, message = "native summary") => {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "done",
    reason: "stop",
    message: assistantMessage([{ type: "text", text: message }], {
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
    }),
  });
  return stream;
};

const decodePayload = Schema.decodeUnknownSync(
  Schema.Struct({ input: Schema.Array(Schema.Unknown) }),
);
const decodeInputItem = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isConfigurationUpdate = Schema.is(
  Schema.Struct({ type: Schema.Literal("configuration_update") }),
);
const tailStart = (input: readonly unknown[]) =>
  Option.getOrElse(
    Arr.findFirstIndex(input, (item) =>
      Fn.pipe(serializedSnapshot(item), Str.includes("tail question")),
    ),
    () => -1,
  );

/** Runs pi-ai's real OpenAI Responses provider and stops it at the payload hook, before any request. */
const nativeProviderPayload = (
  requestModel: Model<"openai-responses">,
  messages: Parameters<typeof convertToLlm>[0],
  reasoning: "high" | undefined,
) =>
  Effect.promise(() => {
    let payload: unknown;
    return streamOpenAIResponses(
      requestModel,
      normalizeContext({ messages: convertToLlm(messages) }),
      {
        apiKey: "sk-test",
        ...(reasoning && { reasoning }),
        onPayload: (params) => {
          payload = params;
          throw new Error("payload captured");
        },
      },
    )
      .result()
      .then(() => payload);
  });

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

const previousTool = (round: number) => (round === 0 ? "old" : `tool-${round - 1}`);

const appendRoundTail = (manager: SessionManager, round: number) => {
  manager.appendMessage({
    role: "system",
    content: "",
    sections: { rules: `updated rules ${round}` },
    toolsRemoved: [{ name: previousTool(round) }],
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
};

describe("OpenAICompactionService", () => {
  for (const supportsMidConvoSystemMessages of [true]) {
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
          const compactRound = (round: number) =>
            Effect.gen(function* () {
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
              const compactedMessages = manager.buildSessionContext().messages;
              const compactedPrompt = getCurrentSystemPrompt(convertToLlm(compactedMessages));
              expect(Str.split(compactedPrompt, "opaque initial content")).toHaveLength(2);
              expect(
                Arr.map(getCurrentTools(convertToLlm(compactedMessages)), (tool) => tool.name),
              ).toEqual([previousTool(round)]);
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
                Arr.filter(manager.buildContextEntries(), (item) => item.type === "compaction"),
              ).toHaveLength(1);
              expect((yield* service.compact(compactEvent()).pipe(Effect.result))._tag).toBe(
                "Failure",
              );
            });
          const injectTail = (round: number) =>
            Effect.gen(function* () {
              const messages = manager.buildSessionContext().messages;
              const filtered = yield* service.filterContext(messages);
              const input = responsesInput(requestModel, filtered ?? messages);
              const injected = yield* service.inject({ input });
              expect(injected?.input).toHaveLength(supportsMidConvoSystemMessages ? 6 : 5);
              expect(
                Str.split(serializedSnapshot(injected?.input), `new question ${round}`),
              ).toHaveLength(2);
              expect(injected?.input.slice(-2)).toEqual(input.slice(-2));
              expect(injected?.input[1]).toMatchObject({
                encrypted_content: `checkpoint-${round + 1}`,
              });
            });
          for (let round = 0; round < 4; round++) {
            yield* compactRound(round);
            appendRoundTail(manager, round);
            yield* injectTail(round);
          }
          expect(requests[1]?.instructions).toContain("updated rules 0");
          expect(requests[1]?.input).toHaveLength(supportsMidConvoSystemMessages ? 5 : 4);
          expect(serializedSnapshot(requests[2]?.input)).not.toContain("new question 0");
          expect(serializedSnapshot(requests[2]?.input)).not.toContain("updated rules 0");
          expect(Arr.filter(manager.getEntries(), (entry) => entry.type === "usage")).toHaveLength(
            0,
          );
          expect(
            Arr.map(
              Arr.filter(manager.getEntries(), (entry) => entry.type === "compaction"),
              (entry) => entry.usage?.totalTokens,
            ),
          ).toEqual([15, 15, 15, 15]);
          manager.appendCompaction("ordinary summary", manager.getLeafId(), 10);
          expect(yield* service.inject({ input: [] })).toBeUndefined();
          expect(
            yield* service.filterContext(manager.buildSessionContext().messages),
          ).toBeUndefined();
        }).pipe(provideBuiltLayer(serviceLayer(target, client)));
      },
    );
  }
  for (const supportsMidConvoSystemMessages of [false]) {
    for (const anchor of ["system", "custom", "usage", "assistant"] as const) {
      it.effect(
        `reuses checkpoints with a retained ${anchor} anchor, mid-conversation=${supportsMidConvoSystemMessages}`,
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
              commit(manager, yield* service.compact(compactEvent()));
              const messages = manager.buildSessionContext().messages;
              const filtered = yield* service.filterContext(messages);
              const input = responsesInput(requestModel, filtered ?? messages);
              const injected = yield* service.inject({ input });
              expect(injected?.input).toHaveLength(2);
              expect(injected?.input[1]).toMatchObject({
                encrypted_content: `anchor-${round + 1}`,
              });
              expect(
                Str.split(serializedSnapshot(injected?.input), "opaque anchor rules"),
              ).toHaveLength(2);
              const requestText = serializedSnapshot(requests[round]?.input);
              expect(Str.split(requestText, `question-${round}`)).toHaveLength(2);
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

  for (const { supportsMidConvoEffort, reasoning, configurationUpdates } of [
    { supportsMidConvoEffort: true, reasoning: "high", configurationUpdates: true },
    { supportsMidConvoEffort: true, reasoning: undefined, configurationUpdates: false },
    { supportsMidConvoEffort: false, reasoning: "high", configurationUpdates: false },
  ] as const)
    it.effect(
      `injects into the native provider payload, mid-conversation effort=${supportsMidConvoEffort}, reasoning=${reasoning ?? "off"}`,
      () => {
        const requestModel = { ...testModel(), compat: { supportsMidConvoEffort } };
        const manager = SessionManager.inMemory("/virtual/native-payload");
        const reply = (text: string, timestamp: number) =>
          assistantMessage([{ type: "text", text }], {
            model: requestModel.id,
            providerThinkingLevel: "high",
            timestamp,
          });
        manager.appendMessage({ role: "system", content: "native rules", timestamp: 0 });
        manager.appendMessage({ role: "user", content: "covered question", timestamp: 1 });
        manager.appendMessage(reply("covered answer", 2));
        const target = fixture({ enabled: true, currentModel: requestModel, manager });
        const { client } = recordingClient("native");
        return Effect.gen(function* () {
          const service = yield* OpenAICompactionService;
          commit(manager, yield* service.compact(compactEvent()));
          manager.appendMessage({ role: "user", content: "tail question", timestamp: 3 });
          manager.appendMessage(reply("tail answer", 4));
          manager.appendMessage({ role: "user", content: "next question", timestamp: 5 });
          const messages = manager.buildSessionContext().messages;
          const repaired = yield* service.filterContext(messages);
          const payload = yield* nativeProviderPayload(
            requestModel,
            repaired ?? messages,
            reasoning,
          );
          const providerInput = decodePayload(payload).input;
          // Precondition: pi-ai emits per-reply configuration_update items exactly when expected.
          expect(Arr.some(providerInput, isConfigurationUpdate)).toBe(configurationUpdates);
          const injected = decodePayload(yield* service.inject(payload)).input;
          expect(injected.slice(tailStart(injected))).toEqual(
            providerInput.slice(tailStart(providerInput)),
          );
          expect(injected[tailStart(injected) - 1]).toMatchObject({
            type: "compaction",
            encrypted_content: "native-1",
          });
          expect(serializedSnapshot(injected)).not.toContain("covered question");
          expect(serializedSnapshot(injected)).not.toContain("covered answer");
        }).pipe(provideBuiltLayer(serviceLayer(target, client)));
      },
    );

  it.effect(
    "injects identically from cached, key-reordered, and fresh projections with covered retry omissions",
    () => {
      const requestModel = { ...testModel(), compat: { supportsMidConvoEffort: true } };
      const manager = SessionManager.inMemory("/virtual/injection-comparison");
      const reply = (text: string, timestamp: number, stopReason: "stop" | "error" = "stop") =>
        assistantMessage([{ type: "text", text }], {
          model: requestModel.id,
          providerThinkingLevel: "high",
          stopReason,
          timestamp,
        });
      manager.appendMessage({ role: "system", content: "native rules", timestamp: 0 });
      manager.appendMessage({ role: "user", content: "covered question", timestamp: 1 });
      const failedId = manager.appendMessage(reply("503 failed response", 2, "error"));
      const target = fixture({ enabled: true, currentModel: requestModel, manager });
      const { client } = recordingClient("comparison");
      const freshInject = (input: readonly unknown[]) =>
        OpenAICompactionService.use((fresh) => fresh.inject({ input })).pipe(
          provideBuiltLayer(
            serviceLayer(fixture({ enabled: true, currentModel: requestModel, manager }), client),
          ),
        );
      return Effect.gen(function* () {
        const service = yield* OpenAICompactionService;
        yield* service.filterContext(
          Arr.flatMap(
            Arr.filter(manager.buildContextEntries(), (entry) => entry.id !== failedId),
            sessionEntryToContextMessages,
          ),
        );
        manager.appendMessage(reply("covered answer", 3));
        const checkpoint = commit(manager, yield* service.compact(compactEvent()));
        expect(
          decodeOpenAICompactionDetails(checkpoint.details)?.checkpoint.omittedEntryIds,
        ).toEqual([failedId]);
        manager.appendMessage({ role: "user", content: "tail question", timestamp: 4 });
        const messages = manager.buildSessionContext().messages;
        const repaired = (yield* service.filterContext(messages)) ?? messages;
        expect(serializedSnapshot(repaired)).not.toContain("503 failed response");
        const inputs = yield* Effect.forEach(["high", undefined] as const, (reasoning) =>
          nativeProviderPayload(requestModel, repaired, reasoning).pipe(
            Effect.map((payload) => decodePayload(payload).input),
          ),
        );
        // Precondition: only the first payload carries per-reply configuration updates.
        expect(Arr.map(inputs, (input) => Arr.some(input, isConfigurationUpdate))).toEqual([
          true,
          false,
        ]);
        // Alternating configuration updates must replace the cached projection each time.
        for (const input of [...inputs, ...inputs]) {
          const expected = decodePayload(yield* freshInject(input)).input;
          expect(expected).toContainEqual(
            expect.objectContaining({ encrypted_content: "comparison-1" }),
          );
          expect(serializedSnapshot(expected)).not.toContain("covered question");
          expect(decodePayload(yield* service.inject({ input })).input).toEqual(expected);
          const reordered = Arr.map(input, (item) =>
            Rec.fromEntries(Arr.reverse(Rec.toEntries(decodeInputItem(item)))),
          );
          for (const [index, item] of input.entries())
            expect(serializedSnapshot(reordered[index])).not.toBe(serializedSnapshot(item));
          expect(decodePayload(yield* service.inject({ input: reordered })).input).toEqual(
            expected,
          );
          const forged = Arr.map(input, (item) =>
            decodeJsonText(
              Str.replace("covered question", "forged question")(serializedSnapshot(item)),
            ),
          );
          expect(serializedSnapshot(forged)).toContain("forged question");
          expect(yield* service.inject({ input: forged })).toBeUndefined();
        }
      }).pipe(provideBuiltLayer(serviceLayer(target, client)));
    },
  );

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

  for (const replacement of [{ content: "revised covered dialogue" }])
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
              OpenAICompactionBoundaryError.make({ operation: "request", message: "unavailable" }),
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

  for (const supportsMidConvoSystemMessages of [false]) {
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
          Arr.flatMap(
            Arr.filter(manager.buildContextEntries(), (entry) => !omitted.has(entry.id)),
            sessionEntryToContextMessages,
          );
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
          expect(
            injected &&
              Arr.filter(
                injected.input,
                (item: ReturnType<typeof responsesInput>[number]) => item.type === "compaction",
              ),
          ).toHaveLength(1);
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
            expect(
              optimized &&
                Arr.filter(
                  optimized.input,
                  (item: ReturnType<typeof responsesInput>[number]) => item.type === "compaction",
                ),
            ).toHaveLength(1);
          }).pipe(provideBuiltLayer(serviceLayer(reloaded, client)));
        }).pipe(provideBuiltLayer(serviceLayer(target, client)));
      },
    );
  }

  it.effect("injects existing checkpoints while Pi creates new compactions", () => {
    const manager = SessionManager.inMemory("/virtual/version-mismatch");
    manager.appendMessage({ role: "system", content: "rules", timestamp: 0 });
    manager.appendMessage({ role: "user", content: "covered dialogue", timestamp: 1 });
    let summaries = 0;
    const target = fixture({
      enabled: true,
      manager,
      streamSimple: (requestModel) => {
        summaries++;
        return summaryStream(requestModel);
      },
    });
    const { requests, client } = recordingClient("checkpoint");
    const tailInput = (service: OpenAICompactionService["Service"]) =>
      service
        .filterContext(manager.buildSessionContext().messages)
        .pipe(Effect.map((messages) => ({ input: responsesInput(testModel(), messages ?? []) })));
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* OpenAICompactionService;
        commit(manager, yield* service.compact(compactEvent()));
        manager.appendMessage({ role: "user", content: "tail dialogue", timestamp: 2 });
      }).pipe(provideBuiltLayer(serviceLayer(target, client)));
      yield* Effect.gen(function* () {
        const service = yield* OpenAICompactionService;
        const payload = yield* tailInput(service);
        expect(serializedSnapshot(payload)).toContain("covered dialogue");
        const injected = serializedSnapshot(yield* service.inject(payload));
        expect(injected).toContain("checkpoint-1");
        expect(injected).toContain("tail dialogue");
        expect(injected).not.toContain("covered dialogue");
        const result = commit(manager, yield* service.compact(compactEvent()));
        expect(decodeOpenAICompactionDetails(result.details)).toBeUndefined();
        expect(summaries).toBe(1);
        expect(yield* service.compact(compactEvent())).toBeUndefined();
        expect(requests).toHaveLength(1);
      }).pipe(provideBuiltLayer(serviceLayer(target, client, { createCheckpoints: false })));
    });
  });

  for (const enabled of [true, false])
    it.effect(`native fallback follows Pi's retry settings, retry=${enabled}`, () => {
      const manager = SessionManager.inMemory("/virtual/fallback-retry");
      manager.appendMessage({ role: "user", content: "old dialogue", timestamp: 1 });
      let attempts = 0;
      const target = fixture({
        enabled: true,
        manager,
        streamSimple: (requestModel) => {
          attempts++;
          if (attempts > 1) return summaryStream(requestModel, "retried summary");
          const stream = createAssistantMessageEventStream();
          stream.push({
            type: "error",
            reason: "error",
            error: assistantMessage([], { stopReason: "error", errorMessage: "overloaded" }),
          });
          return stream;
        },
      });
      const { client } = recordingClient("checkpoint");
      const retryPolicy = piRetryPolicy({
        getSettings: () => ({ retry: { enabled, maxRetries: 1, baseDelayMs: 1 } }),
      });
      return Effect.gen(function* () {
        const service = yield* OpenAICompactionService;
        commit(manager, yield* service.compact(compactEvent()));
        manager.appendMessage({ role: "user", content: "new dialogue", timestamp: 2 });
        target.setEnabled(false);
        const result = yield* service.compact(compactEvent()).pipe(Effect.result);
        expect(attempts).toBe(enabled ? 2 : 1);
        expect(result._tag).toBe(enabled ? "Success" : "Failure");
        if (enabled) expect(serializedSnapshot(result)).toContain("retried summary");
      }).pipe(provideBuiltLayer(serviceLayer(target, client, { retryPolicy })));
    });

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
      expect(failure).toBeInstanceOf(OpenAICompactionError);
      expect(failure).toMatchObject({ operation: "context" });
      expect(serializedSnapshot(failure)).not.toContain("host-context-secret");
    }).pipe(provideBuiltLayer(serviceLayer(target, client)));
  });
});
