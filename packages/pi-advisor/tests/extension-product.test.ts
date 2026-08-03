// Pi callbacks and fake child sessions are Promise-shaped test boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { normalizeAdvisorConfig } from "../src/config/options.ts";
import { createAdvisorExtension } from "../src/extension.ts";
import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeDriver,
} from "../src/runtime/runtime.ts";
import { ADVISOR_REVIEW_ACTION_TYPE, ADVISOR_REVIEW_CARD_TYPE } from "../src/ui/renderer.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
  return {
    checkpointId: request.checkpointId,
    processedThrough: request.processedThrough,
    stateSummary: "state",
    verdict: "pass",
    summary: "Looks good",
    suggestions: [],
    findings: [],
  };
}
function finalTurn(text = "candidate") {
  return {
    type: "turn_end",
    turnIndex: 1,
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
    toolResults: [],
  };
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

function harness(
  options: {
    configured?: boolean;
    setupSelection?: string;
    failCardAppends?: number;
    failActionAppend?: boolean;
    failSend?: boolean;
  } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: never) => unknown }>();
  const requests: AdvisorCheckpointRequest[] = [];
  const pending: Array<ReturnType<typeof deferred<AdvisorCheckpoint>>> = [];
  const entries: Array<Record<string, unknown>> = [
    {
      id: "anchor",
      type: "message",
      parentId: null,
      message: { role: "user", content: "request" },
    },
  ];
  const sent: unknown[] = [];
  let remainingCardAppendFailures = options.failCardAppends ?? 0;
  const driver: AdvisorRuntimeDriver = {
    activeToolNames: ["read", "grep", "find", "ls"],
    start: vi.fn(async () => undefined),
    checkpoint: vi.fn((request) => {
      requests.push(request);
      const item = deferred<AdvisorCheckpoint>();
      pending.push(item);
      return item.promise;
    }),
    steer: vi.fn(async () => true),
    reprime: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  const pi = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: { handler: (args: string, ctx: never) => unknown }) =>
      commands.set(name, command),
    registerEntryRenderer: vi.fn(),
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      if (customType === ADVISOR_REVIEW_CARD_TYPE && remainingCardAppendFailures > 0) {
        remainingCardAppendFailures -= 1;
        throw new Error("card append failed");
      }
      if (customType === ADVISOR_REVIEW_ACTION_TYPE && options.failActionAppend)
        throw new Error("action append failed");
      entries.push({
        id: `e${entries.length}`,
        type: "custom",
        parentId: entries.at(-1)?.id,
        customType,
        data,
      });
    }),
    sendMessage: vi.fn((message: unknown) => {
      if (options.failSend) throw new Error("send failed");
      sent.push(message);
    }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/project",
    mode: "tui",
    hasUI: true,
    signal: undefined,
    abort: vi.fn(),
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    isProjectTrusted: vi.fn(() => true),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      select: vi.fn(async () => options.setupSelection),
    },
    modelRegistry: {
      getAvailable: vi.fn(() =>
        options.setupSelection && options.setupSelection !== "Not now"
          ? [{ provider: "setup-provider", id: "setup-model" }]
          : [],
      ),
      find: vi.fn((provider: string, model: string) => ({ provider, id: model })),
      hasConfiguredAuth: vi.fn(() => true),
    },
    sessionManager: {
      buildContextEntries: vi.fn(() => []),
      getBranch: vi.fn(() => entries),
      getLeafId: vi.fn(() => "anchor"),
      getSessionId: vi.fn(() => "session"),
    },
  } as unknown as ExtensionContext;
  createAdvisorExtension({
    loadConfig: () =>
      normalizeAdvisorConfig(
        options.configured === false
          ? { enabled: false, setupDismissed: false }
          : { enabled: true, provider: "p", model: "m", setupDismissed: true },
        "/config",
      ),
    createRuntime: () => driver,
    catchUpTimeoutMs: 25,
  })(pi);
  const emit = async (name: string, event: unknown) => {
    for (const handler of handlers.get(name) ?? []) await handler(event as never, ctx);
  };
  return { pi, ctx, commands, requests, pending, entries, sent, emit };
}

async function settleAutomatic(
  value: ReturnType<typeof harness>,
  result: (request: AdvisorCheckpointRequest) => AdvisorCheckpoint,
): Promise<void> {
  const turn = value.emit("turn_end", finalTurn());
  await tick();
  value.pending.at(-1)!.resolve(result(value.requests.at(-1)!));
  await turn;
  await tick();
}

async function createManualCard(
  value: ReturnType<typeof harness>,
  result: (request: AdvisorCheckpointRequest) => AdvisorCheckpoint,
): Promise<void> {
  await value.commands.get("advisor")!.handler("review", value.ctx as never);
  await tick();
  value.pending.at(-1)!.resolve(result(value.requests.at(-1)!));
  await tick();
}

describe("Advisor extension product behavior", () => {
  test("registers only /advisor and a custom-entry renderer", () => {
    const value = harness();
    expect([...value.commands.keys()]).toEqual(["advisor"]);
    expect(value.pi.registerEntryRenderer).toHaveBeenCalledWith(
      ADVISOR_REVIEW_CARD_TYPE,
      expect.any(Function),
    );
    expect(value.pi.registerMessageRenderer).not.toHaveBeenCalled();
  });

  test("automatic onboarding opens only for unconfigured TUI sessions", async () => {
    const tui = harness({ configured: false, setupSelection: "Not now" });
    await tui.emit("session_start", { type: "session_start" });
    expect(tui.ctx.ui.select).toHaveBeenCalledWith("Set up Advisor", ["Not now"]);
    expect(tui.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No authenticated models"),
      "warning",
    );

    const nonUi = harness({ configured: false });
    Object.assign(nonUi.ctx, { mode: "print", hasUI: false });
    await nonUi.emit("session_start", { type: "session_start" });
    expect(nonUi.ctx.ui.select).not.toHaveBeenCalled();
  });

  test("ordinary progress turns ingest and return immediately without a checkpoint", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", progressTurn());
    expect(value.requests).toHaveLength(0);
  });

  test("trajectory evidence can request an asynchronous progress review", async () => {
    vi.useFakeTimers();
    try {
      const value = harness();
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_start", { type: "turn_start", turnIndex: 1 });
      await value.emit("message_update", {
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "repeat-this-unit".repeat(12),
        },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(value.requests).toHaveLength(1);
      value.pending[0]!.resolve(pass(value.requests[0]!));
      await vi.advanceTimersByTimeAsync(0);
      await value.emit("session_shutdown", { type: "session_shutdown" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a material final concern creates a card and corrects the parent", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await settleAutomatic(value, (request) => finding(request, "concern"));
    expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_CARD_TYPE)).toBe(true);
    expect(value.sent).toHaveLength(1);
    expect(value.sent[0]).toMatchObject({ customType: "pi-advisor-guidance-v1", display: false });
    expect(JSON.stringify(value.sent[0])).not.toContain("direct evidence");
  });

  test("a blocker is independently verified before correction", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    const turn = value.emit("turn_end", finalTurn());
    await tick();
    value.pending[0]!.resolve(finding(value.requests[0]!, "blocker"));
    await tick();
    expect(value.requests[1]?.focus).toBe("blocker-verification");
    value.pending[1]!.resolve(finding(value.requests[1]!, "blocker"));
    await turn;
    expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_CARD_TYPE)).toBe(true);
    expect(value.sent).toHaveLength(1);
  });

  test("Fix sends compact guidance and a tombstone; Dismiss sends no guidance", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await settleAutomatic(value, pass);
    await createManualCard(value, (request) => finding(request, "concern", "manual-one"));
    await value.commands.get("advisor")!.handler("fix", value.ctx as never);
    expect(value.sent).toHaveLength(1);
    expect(value.entries.at(-1)).toMatchObject({
      customType: ADVISOR_REVIEW_ACTION_TYPE,
      data: { action: "fix" },
    });

    await createManualCard(value, suggestion);
    const before = value.sent.length;
    await value.commands.get("advisor")!.handler("dismiss", value.ctx as never);
    expect(value.sent).toHaveLength(before);
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
  });

  test("cancel with observations but no active review does not mutate lifecycle state", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", progressTurn());
    const before = value.entries.length;
    await value.commands.get("advisor")!.handler("cancel", value.ctx as never);
    expect(value.entries).toHaveLength(before);
  });

  test("automatic final suggestions are suppressed", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await settleAutomatic(value, suggestion);
    expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_CARD_TYPE)).toBe(
      false,
    );
    expect(value.sent).toHaveLength(0);
  });

  test("a pass produces no card or context message", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await settleAutomatic(value, pass);
    expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_CARD_TYPE)).toBe(
      false,
    );
    expect(value.sent).toHaveLength(0);
  });

  test("a failed manual card append does not consume delivery state", async () => {
    const value = harness({ failCardAppends: 1 });
    await value.emit("session_start", { type: "session_start" });
    await settleAutomatic(value, pass);
    await createManualCard(value, (request) => finding(request, "concern", "manual-retry"));
    expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_CARD_TYPE)).toBe(
      false,
    );
    await createManualCard(value, (request) => finding(request, "concern", "manual-retry"));
    expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_CARD_TYPE)).toBe(true);
  });

  test("keeps a card open when Fix cannot send guidance", async () => {
    const value = harness({ failSend: true });
    await value.emit("session_start", { type: "session_start" });
    await settleAutomatic(value, pass);
    await createManualCard(value, (request) => finding(request, "concern"));
    await value.commands.get("advisor")!.handler("fix", value.ctx as never);
    expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_ACTION_TYPE)).toBe(
      false,
    );
    expect(value.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("card remains open"),
      "error",
    );
  });

  test("reports when Fix sends guidance but cannot persist its tombstone", async () => {
    const value = harness({ failActionAppend: true });
    await value.emit("session_start", { type: "session_start" });
    await settleAutomatic(value, pass);
    await createManualCard(value, (request) => finding(request, "concern"));
    await value.commands.get("advisor")!.handler("fix", value.ctx as never);
    expect(value.sent).toHaveLength(1);
    expect(value.entries.some((entry) => entry.customType === ADVISOR_REVIEW_ACTION_TYPE)).toBe(
      false,
    );
    expect(value.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("could not mark the card fixed"),
      "error",
    );
  });

  test("manual suggestions create a local card without steering", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await settleAutomatic(value, pass);
    await createManualCard(value, suggestion);
    expect(value.entries).toContainEqual(
      expect.objectContaining({
        customType: ADVISOR_REVIEW_CARD_TYPE,
        data: expect.objectContaining({ kind: "suggestion" }),
      }),
    );
    expect(value.sent).toHaveLength(0);
    await value.commands.get("advisor")!.handler("", value.ctx as never);
    expect(value.ctx.ui.select).toHaveBeenLastCalledWith(
      expect.stringContaining("issue shown"),
      expect.any(Array),
    );
  });

  test("reports a clean result when a manual review passes", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await settleAutomatic(value, pass);
    await createManualCard(value, pass);
    expect(value.ctx.ui.notify).toHaveBeenCalledWith("Advisor found no issues.", "info");
  });
});
