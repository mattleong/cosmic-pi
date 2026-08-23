// Pi callbacks and fake child sessions are Promise-shaped test boundaries.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, test } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { normalizeAdvisorConfig } from "../src/config/options.ts";
import { createAdvisorExtension } from "../src/extension.ts";
import type { AdvisorCheckpoint, AdvisorCheckpointRequest } from "../src/runtime/runtime.ts";
import { ADVISOR_REVIEW_ACTION_TYPE, ADVISOR_REVIEW_CARD_TYPE } from "../src/ui/review-card.ts";
import { tick } from "./support/async.ts";
import { finalTurn, passCheckpoint } from "./support/checkpoints.ts";
import { configStoreLayerFromLoad } from "./support/layers.ts";
import {
  advisorExtensionApi,
  advisorExtensionContext,
  commandRegistry,
  handlerRegistry,
  type AdvisorHostEntry,
} from "./support/extension-host.ts";
import { controllableRuntimeService } from "./support/runtime-service.ts";

function finding(
  request: AdvisorCheckpointRequest,
  severity: "concern" | "blocker",
  fingerprint = `${severity}-finding`,
): AdvisorCheckpoint {
  return {
    checkpointId: request.checkpointId,
    processedThrough: request.processedThrough,
    stateSummary: "state",
    verdict: "revise",
    summary: `${severity} summary`,
    suggestions: [],
    findings: [
      {
        fingerprint,
        category: "correctness",
        severity,
        confidence: "high",
        evidenceBasis: "direct",
        issue: `${severity} issue`,
        evidence: "direct evidence",
        recommendation: "apply the fix",
      },
    ],
  };
}
function suggestion(request: AdvisorCheckpointRequest): AdvisorCheckpoint {
  return {
    checkpointId: request.checkpointId,
    processedThrough: request.processedThrough,
    stateSummary: "state",
    verdict: "suggest",
    summary: "Try another angle",
    suggestions: [
      {
        fingerprint: "alternative-angle",
        kind: "alternative",
        suggestion: "Try the smaller design",
        rationale: "It has fewer moving parts",
        relevance: "likely",
      },
    ],
    findings: [],
  };
}
function pass(request: AdvisorCheckpointRequest): AdvisorCheckpoint {
  return passCheckpoint(request, { stateSummary: "state", summary: "Looks good", suggestions: [] });
}
function progressTurn() {
  return {
    type: "turn_end",
    turnIndex: 1,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }],
      stopReason: "stop",
    },
    toolResults: [],
  };
}

const setupModel = (provider: string, id: string): NonNullable<ExtensionContext["model"]> => ({
  provider,
  id,
  name: id,
  api: "openai-completions",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
});

function harness(
  options: {
    configured?: boolean;
    enabled?: boolean;
    setupSelection?: string;
    failCardAppends?: number;
    failActionAppend?: boolean;
    failSend?: boolean;
  } = {},
) {
  const registry = handlerRegistry();
  const { commands, registerCommand } = commandRegistry();
  const { layer: runtimeServiceLayer, pending, requests } = controllableRuntimeService();
  const entries: AdvisorHostEntry[] = [
    {
      id: "anchor",
      type: "message",
      parentId: null,
      timestamp: "now",
      message: { role: "user", content: "request", timestamp: 1 },
    },
  ];
  const sent: unknown[] = [];
  let remainingCardAppendFailures = options.failCardAppends ?? 0;
  const pi = advisorExtensionApi({
    on: registry.on,
    registerCommand,
    appendEntry: (customType: string, data) => {
      if (customType === ADVISOR_REVIEW_CARD_TYPE && remainingCardAppendFailures > 0) {
        remainingCardAppendFailures -= 1;
        throw new Error("card append failed");
      }
      if (customType === ADVISOR_REVIEW_ACTION_TYPE && options.failActionAppend)
        throw new Error("action append failed");
      entries.push({
        id: `e${entries.length}`,
        type: "custom",
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "now",
        customType,
        data,
      });
    },
    sendMessage: vi.fn((message) => {
      if (options.failSend) throw new Error("send failed");
      sent.push(message);
    }),
  });
  const ctx = advisorExtensionContext({
    getBranch: () => entries,
    select: vi.fn(() => Promise.resolve(options.setupSelection)),
    modelRegistry: {
      getAvailable: vi.fn(() =>
        options.setupSelection && options.setupSelection !== "Not now"
          ? [setupModel("setup-provider", "setup-model")]
          : [],
      ),
      find: vi.fn((provider: string, model: string) => setupModel(provider, model)),
      hasConfiguredAuth: vi.fn(() => true),
    },
  });
  createAdvisorExtension({
    configStore: configStoreLayerFromLoad(() =>
      normalizeAdvisorConfig(
        options.configured === false
          ? { enabled: options.enabled ?? false, setupDismissed: false }
          : { enabled: true, provider: "p", model: "m", setupDismissed: true },
        "/config",
      ),
    ),
    runtimeService: runtimeServiceLayer,
  })(pi);
  const emit = <Event>(name: string, event: Event) => registry.emitWithContext(name, event, ctx);
  return { pi, ctx, commands, requests, pending, entries, sent, emit };
}

const invoke = <ValueInput>(value: ValueInput): Effect.Effect<void> =>
  Effect.promise(() => Promise.resolve(value).then(() => undefined));

/** Serialized snapshot for content-leak assertions at this Promise-shaped test boundary. */
const serializedSnapshot = <ValueInput>(value: ValueInput): string => JSON.stringify(value);

const settleAutomatic = (
  value: ReturnType<typeof harness>,
  result: (request: AdvisorCheckpointRequest) => AdvisorCheckpoint,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const turn = value.emit("turn_end", finalTurn());
    yield* Effect.promise(() => tick());
    value.pending.at(-1)!.resolve(result(value.requests.at(-1)!));
    yield* invoke(turn);
    yield* Effect.promise(() => tick());
  });

const createManualCard = (
  value: ReturnType<typeof harness>,
  result: (request: AdvisorCheckpointRequest) => AdvisorCheckpoint,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    yield* invoke(value.commands.get("advisor")!.handler("review", value.ctx as never));
    yield* Effect.promise(() => tick());
    value.pending.at(-1)!.resolve(result(value.requests.at(-1)!));
    yield* Effect.promise(() => tick());
  });

describe("Advisor extension product behavior", () => {
  it.effect("default disabled unconfigured sessions do not open onboarding", () =>
    Effect.gen(function* () {
      const value = harness({ configured: false, setupSelection: "Not now" });
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      expect(value.ctx.ui.select).not.toHaveBeenCalled();
      expect(value.ctx.ui.notify).not.toHaveBeenCalled();
    }),
  );

  it.effect("automatic onboarding opens only when unconfigured Advisor is explicitly enabled", () =>
    Effect.gen(function* () {
      const tui = harness({ configured: false, enabled: true, setupSelection: "Not now" });
      yield* invoke(tui.emit("session_start", { type: "session_start" }));
      expect(tui.ctx.ui.select).toHaveBeenCalledWith("Set up Advisor", ["Not now"]);
      expect(tui.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No authenticated models"),
        "warning",
      );

      const nonUi = harness({ configured: false, enabled: true });
      Object.assign(nonUi.ctx, { mode: "print", hasUI: false });
      yield* invoke(nonUi.emit("session_start", { type: "session_start" }));
      expect(nonUi.ctx.ui.select).not.toHaveBeenCalled();
    }),
  );

  it.effect("ordinary progress turns ingest and return immediately without a checkpoint", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", progressTurn()));
      expect(value.requests).toHaveLength(0);
    }),
  );

  test("trajectory evidence can request an asynchronous progress review", () => {
    vi.useFakeTimers();
    const value = harness();
    return value
      .emit("session_start", { type: "session_start" })
      .then(() => value.emit("turn_start", { type: "turn_start", turnIndex: 1 }))
      .then(() =>
        value.emit("message_update", {
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "repeat-this-unit".repeat(12),
          },
        }),
      )
      .then(() => vi.advanceTimersByTimeAsync(15_000))
      .then(() => {
        expect(value.requests).toHaveLength(1);
        value.pending[0]!.resolve(pass(value.requests[0]!));
        return vi.advanceTimersByTimeAsync(0);
      })
      .then(() => value.emit("session_shutdown", { type: "session_shutdown" }))
      .then(() => undefined)
      .finally(() => {
        vi.useRealTimers();
      });
  });

  it.effect("a material final concern creates a card and corrects the parent", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* settleAutomatic(value, (request) => finding(request, "concern"));
      expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_CARD_TYPE)).toBe(
        true,
      );
      expect(value.sent).toHaveLength(1);
      expect(value.sent[0]).toMatchObject({ customType: "pi-advisor-guidance-v1", display: false });
      expect(serializedSnapshot(value.sent[0])).not.toContain("direct evidence");
    }),
  );

  it.effect("a blocker is independently verified before correction", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      const turn = value.emit("turn_end", finalTurn());
      yield* Effect.promise(() => tick());
      value.pending[0]!.resolve(finding(value.requests[0]!, "blocker"));
      yield* Effect.promise(() => tick());
      expect(value.requests[1]?.focus).toBe("blocker-verification");
      value.pending[1]!.resolve(finding(value.requests[1]!, "blocker"));
      yield* invoke(turn);
      expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_CARD_TYPE)).toBe(
        true,
      );
      expect(value.sent).toHaveLength(1);
    }),
  );

  it.effect("Fix sends compact guidance and a tombstone; Dismiss sends no guidance", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* settleAutomatic(value, pass);
      yield* createManualCard(value, (request) => finding(request, "concern", "manual-one"));
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      yield* invoke(value.commands.get("advisor")!.handler("fix", value.ctx as never));
      expect(value.sent).toHaveLength(1);
      expect(value.entries.at(-1)).toMatchObject({
        customType: ADVISOR_REVIEW_ACTION_TYPE,
        data: { action: "fix" },
      });

      yield* createManualCard(value, suggestion);
      const before = value.sent.length;
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      yield* invoke(value.commands.get("advisor")!.handler("dismiss", value.ctx as never));
      expect(value.sent).toHaveLength(before);
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect(
        [...value.entries]
          .reverse()
          .find(
            (entry) =>
              entry.customType === ADVISOR_REVIEW_ACTION_TYPE &&
              (entry.data as { action?: string } | undefined)?.action === "dismiss",
          ),
      ).toMatchObject({
        customType: ADVISOR_REVIEW_ACTION_TYPE,
        data: { action: "dismiss" },
      });
    }),
  );

  it.effect("cancel with observations but no active review does not mutate lifecycle state", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", progressTurn()));
      const before = value.entries.length;
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      yield* invoke(value.commands.get("advisor")!.handler("cancel", value.ctx as never));
      expect(value.entries).toHaveLength(before);
    }),
  );

  it.effect("automatic final suggestions are suppressed", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* settleAutomatic(value, suggestion);
      expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_CARD_TYPE)).toBe(
        false,
      );
      expect(value.sent).toHaveLength(0);
    }),
  );

  it.effect("a pass produces no card or context message", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* settleAutomatic(value, pass);
      expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_CARD_TYPE)).toBe(
        false,
      );
      expect(value.sent).toHaveLength(0);
    }),
  );

  it.effect("a failed manual card append does not consume delivery state", () =>
    Effect.gen(function* () {
      const value = harness({ failCardAppends: 1 });
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* settleAutomatic(value, pass);
      yield* createManualCard(value, (request) => finding(request, "concern", "manual-retry"));
      expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_CARD_TYPE)).toBe(
        false,
      );
      yield* createManualCard(value, (request) => finding(request, "concern", "manual-retry"));
      expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_CARD_TYPE)).toBe(
        true,
      );
    }),
  );

  it.effect("keeps a card open when Fix cannot send guidance", () =>
    Effect.gen(function* () {
      const value = harness({ failSend: true });
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* settleAutomatic(value, pass);
      yield* createManualCard(value, (request) => finding(request, "concern"));
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      yield* invoke(value.commands.get("advisor")!.handler("fix", value.ctx as never));
      expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_ACTION_TYPE)).toBe(
        false,
      );
      expect(value.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("card remains open"),
        "error",
      );
    }),
  );

  it.effect("reports when Fix sends guidance but cannot persist its tombstone", () =>
    Effect.gen(function* () {
      const value = harness({ failActionAppend: true });
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* settleAutomatic(value, pass);
      yield* createManualCard(value, (request) => finding(request, "concern"));
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      yield* invoke(value.commands.get("advisor")!.handler("fix", value.ctx as never));
      expect(value.sent).toHaveLength(1);
      expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_ACTION_TYPE)).toBe(
        false,
      );
      expect(value.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("could not mark the card fixed"),
        "error",
      );
    }),
  );

  it.effect("manual suggestions create a local card without steering", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* settleAutomatic(value, pass);
      yield* createManualCard(value, suggestion);
      expect(value.entries).toContainEqual(
        expect.objectContaining({
          customType: ADVISOR_REVIEW_CARD_TYPE,
          data: expect.objectContaining({ kind: "suggestion" }),
        }),
      );
      expect(value.sent).toHaveLength(0);
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      yield* invoke(value.commands.get("advisor")!.handler("", value.ctx as never));
      expect(value.ctx.ui.select).toHaveBeenLastCalledWith(
        expect.stringContaining("issue shown"),
        expect.any(Array),
      );
    }),
  );

  it.effect("reports a clean result when a manual review passes", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* settleAutomatic(value, pass);
      yield* createManualCard(value, pass);
      expect(value.ctx.ui.notify).toHaveBeenCalledWith("Advisor found no issues.", "info");
    }),
  );
});
