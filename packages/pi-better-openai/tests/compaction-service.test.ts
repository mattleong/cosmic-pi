import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ContextEvent,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { provideBuiltLayer } from "pi-cosmic-core";
import {
  OpenAICompactionClient,
  type OpenAICompactRequest,
  type OpenAICompactionClientContract,
} from "../src/boundary/openai-compaction.ts";
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
  // SAFETY: The service reads only tokensBefore and the branch/custom-instruction fields supplied here.
  return {
    type: "session_before_compact",
    branchEntries: [entry(firstKeptEntryId, "kept")],
    customInstructions: "retain decisions",
    reason: "manual",
    preparation: { tokensBefore: 321 },
  } as SessionBeforeCompactEvent;
};

function fixture(options: {
  readonly enabled: boolean;
  readonly currentModel?: Model<Api>;
  readonly branch?: SessionEntry[];
  readonly contextEntries?: SessionEntry[];
  readonly hostileBranch?: boolean;
}) {
  const branch = options.branch ?? [];
  const contextEntries = options.contextEntries ?? [];
  const ctxFixture = {
    model: options.currentModel ?? model(),
    getSystemPrompt: () => "system contract",
    sessionManager: {
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

describe("OpenAICompactionService", () => {
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
    const disabled = fixture({ enabled: false, hostileBranch: true });
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
      expect(first?.firstKeptEntryId).toBe("kept");
      expect(first?.tokensBefore).toBe(321);
      const firstDetails = decodeOpenAICompactionDetails(first?.details);
      expect(firstDetails).toBeDefined();
      expect(firstDetails?.checkpoint.rawInputCount).toBe(requests[0]?.input.length);

      target.branch.push({
        type: "compaction",
        id: "checkpoint-entry",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        summary: first?.summary ?? "",
        firstKeptEntryId: first?.firstKeptEntryId ?? "kept",
        tokensBefore: first?.tokensBefore ?? 0,
        details: first?.details,
      });
      target.contextEntries.push(entry("three", "third turn"));

      const second = yield* service.compact(compactEvent("kept-again"));
      const secondDetails = decodeOpenAICompactionDetails(second?.details);
      expect(secondDetails?.checkpoint.rawInputCount).toBeGreaterThan(
        firstDetails?.checkpoint.rawInputCount ?? 0,
      );
      expect(requests[1]?.input.slice(0, outputs[0]?.length)).toEqual(outputs[0]);
      expect(requests[1]?.input.length).toBe(
        (outputs[0]?.length ?? 0) +
          (secondDetails?.checkpoint.rawInputCount ?? 0) -
          (firstDetails?.checkpoint.rawInputCount ?? 0),
      );

      target.branch.push({
        type: "compaction",
        id: "checkpoint-entry-2",
        parentId: "checkpoint-entry",
        timestamp: "2026-01-01T00:00:02.000Z",
        summary: second?.summary ?? "",
        firstKeptEntryId: second?.firstKeptEntryId ?? "kept-again",
        tokensBefore: second?.tokensBefore ?? 0,
        details: second?.details,
      });
      // SAFETY: Each fixture contains the role-specific fields read by the filtering behavior.
      const messages = [
        { role: "user", content: "keep" },
        { role: "compactionSummary", summary: OPENAI_COMPACTION_SUMMARY },
        { role: "assistant", content: [] },
      ] as ContextEvent["messages"];
      expect(yield* service.filterContext(messages)).toEqual([messages[0], messages[2]]);

      const rawCount = secondDetails?.checkpoint.rawInputCount ?? 0;
      const rawInput = Array.from({ length: rawCount + 1 }, (_value, index) => ({
        type: "message",
        id: `raw-${index}`,
      }));
      const system = { role: "system", content: "system" };
      const injected = yield* service.inject({ input: [system, ...rawInput], marker: "preserved" });
      expect(injected).toEqual({
        input: [system, ...(outputs[1] ?? []), rawInput.at(-1)],
        marker: "preserved",
      });
    }).pipe(provideBuiltLayer(serviceLayer(target, client)));
  });

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
        expect(result.failure.operation).toBe("context");
        expect(serializedSnapshot(result.failure)).not.toContain("host-context-secret");
      }
    }).pipe(provideBuiltLayer(serviceLayer(target, client)));
  });
});
