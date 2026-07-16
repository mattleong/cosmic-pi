import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ResolvedCommand,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ResolvedAdvisorConfig, writeRawAdvisorConfig } from "../src/config.ts";
import { createAdvisorExtension } from "../src/extension.ts";
import type { AdvisorReview } from "../src/review.ts";

type EventHandler = (event: never, ctx: ExtensionContext) => unknown | Promise<unknown>;
const tempDirectories: string[] = [];

const passingReview: AdvisorReview = {
  verdict: "pass",
  summary: "The response is correct and complete.",
  findings: [],
};

const revisionReview: AdvisorReview = {
  verdict: "revise",
  summary: "The response misses an important constraint.",
  findings: [
    {
      severity: "high",
      issue: "The answer changes behavior despite the user's constraint.",
      recommendation: "Preserve the existing behavior and revise the implementation advice.",
    },
  ],
};

function resolvedConfig(overrides: Partial<ResolvedAdvisorConfig> = {}): ResolvedAdvisorConfig {
  return {
    configPath: "/tmp/pi-advisor.json",
    enabled: true,
    provider: "review-provider",
    model: "review-model",
    timeoutMs: 30_000,
    maxContextChars: 48_000,
    configured: true,
    ...overrides,
  };
}

function assistantEvent(
  text: string,
  options: { stopReason?: string; toolCall?: boolean; toolResults?: unknown[] } = {},
) {
  const content: Array<Record<string, unknown>> = text ? [{ type: "text", text }] : [];
  if (options.toolCall) content.push({ type: "toolCall", name: "read", arguments: {} });
  return {
    type: "turn_end",
    turnIndex: 0,
    message: {
      role: "assistant",
      content,
      stopReason: options.stopReason ?? "stop",
    },
    toolResults: options.toolResults ?? [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function tempConfigPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-advisor-extension-"));
  tempDirectories.push(directory);
  return join(directory, "extensions", "pi-advisor.json");
}

function createHarness(
  config = resolvedConfig(),
  review: AdvisorReview | Error | Promise<AdvisorReview> = passingReview,
) {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, Omit<ResolvedCommand, "name" | "sourceInfo">>();
  const notify = vi.fn();
  const setStatus = vi.fn();
  const select = vi.fn();
  const hasPendingMessages = vi.fn(() => false);
  const getAvailableModels = vi.fn((): Array<{ provider: string; id: string }> => []);
  const findModel = vi.fn(() => ({ provider: "review-provider", id: "review-model" }));
  const hasConfiguredAuth = vi.fn(() => true);
  const sendMessage = vi.fn();
  const registerMessageRenderer = vi.fn();
  const requestReview = vi.fn(async () => {
    if (review instanceof Error) throw review;
    return await review;
  });
  const pi = {
    on: (event: string, handler: EventHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string, command: Omit<ResolvedCommand, "name" | "sourceInfo">) =>
      commands.set(name, command),
    registerMessageRenderer,
    sendMessage,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/tmp/project",
    hasUI: true,
    mode: "tui",
    signal: undefined,
    hasPendingMessages,
    ui: { notify, select, setStatus },
    sessionManager: { buildContextEntries: vi.fn(() => []) },
    modelRegistry: {
      find: findModel,
      getAvailable: getAvailableModels,
      hasConfiguredAuth,
    },
  } as unknown as ExtensionContext;

  createAdvisorExtension({
    loadConfig: () => config,
    requestReview: requestReview as never,
  })(pi);

  async function emit(event: string, payload: unknown): Promise<void> {
    for (const handler of handlers.get(event) ?? []) await handler(payload as never, ctx);
  }

  return {
    commands,
    ctx,
    emit,
    getAvailableModels,
    hasPendingMessages,
    handlers,
    notify,
    registerMessageRenderer,
    requestReview,
    select,
    sendMessage,
    setStatus,
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("advisor extension lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("registers its commands and review renderer", () => {
    const harness = createHarness();

    expect(harness.commands.has("advisor-settings")).toBe(true);
    expect(harness.commands.has("advisor-status")).toBe(true);
    expect(harness.registerMessageRenderer).toHaveBeenCalledWith(
      "advisor-review",
      expect.any(Function),
    );
  });

  test("warns once in an unconfigured session and skips review", async () => {
    const harness = createHarness(
      resolvedConfig({ provider: undefined, model: undefined, configured: false }),
    );

    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.emit("turn_end", assistantEvent("candidate"));
    await harness.emit("turn_end", assistantEvent("another candidate"));

    expect(harness.notify).toHaveBeenCalledTimes(1);
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining("/advisor-settings"),
      "warning",
    );
    expect(harness.requestReview).not.toHaveBeenCalled();
  });

  test("passes one candidate and resets only for a genuine user message", async () => {
    const harness = createHarness();

    await harness.emit("before_agent_start", { type: "before_agent_start" });
    await harness.emit("turn_end", assistantEvent("first candidate"));
    await harness.emit("turn_end", assistantEvent("unprompted second candidate"));

    expect(harness.requestReview).toHaveBeenCalledTimes(1);
    expect(harness.notify).toHaveBeenCalledWith("Advisor approved this response.", "info");
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.setStatus).toHaveBeenNthCalledWith(1, "pi-advisor", "advisor: reviewing…");
    expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined);

    await harness.emit("message_end", { message: { role: "custom", customType: "other" } });
    await harness.emit("turn_end", assistantEvent("still not eligible"));
    expect(harness.requestReview).toHaveBeenCalledTimes(1);

    await harness.emit("message_end", { message: { role: "user", content: "queued follow-up" } });
    await harness.emit("turn_end", assistantEvent("follow-up candidate"));
    expect(harness.requestReview).toHaveBeenCalledTimes(2);
  });

  test("skips the review cycle when a user message is already queued", async () => {
    const harness = createHarness();
    harness.hasPendingMessages.mockReturnValue(true);

    await harness.emit("turn_end", assistantEvent("obsolete candidate"));

    expect(harness.requestReview).not.toHaveBeenCalled();
    expect(harness.setStatus).not.toHaveBeenCalled();

    harness.hasPendingMessages.mockReturnValue(false);
    await harness.emit("turn_end", assistantEvent("same cycle"));
    expect(harness.requestReview).not.toHaveBeenCalled();

    await harness.emit("message_end", { message: { role: "user", content: "queued follow-up" } });
    await harness.emit("turn_end", assistantEvent("follow-up candidate"));
    expect(harness.requestReview).toHaveBeenCalledTimes(1);
  });

  test("counts a started review invalidated by queued input as attempted and discarded", async () => {
    const pendingReview = deferred<AdvisorReview>();
    const harness = createHarness(resolvedConfig(), pendingReview.promise);
    const reviewRun = harness.emit("turn_end", assistantEvent("candidate"));
    await vi.waitFor(() => expect(harness.requestReview).toHaveBeenCalledTimes(1));

    harness.hasPendingMessages.mockReturnValue(true);
    pendingReview.resolve(revisionReview);
    await reviewRun;

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined);

    await harness.commands.get("advisor-status")?.handler("", harness.ctx as never);
    const status = String(harness.notify.mock.lastCall?.[0]);
    expect(status).toContain("Session review attempts: 1");
    expect(status).toContain(
      "Session review outcomes: pass 0, revise 0, failure 0, discarded 1, in progress 0",
    );
  });

  test.each([
    {
      name: "automatic review is disabled",
      selections: ["Automatic review: on", "Done"],
      models: [],
    },
    {
      name: "the advisor model is cleared",
      selections: ["Advisor model: review-provider/review-model", "Clear advisor model", "Done"],
      models: [],
    },
    {
      name: "the advisor model is switched",
      selections: ["Advisor model: review-provider/review-model", "new-provider/new-model", "Done"],
      models: [{ provider: "new-provider", id: "new-model" }],
    },
    {
      name: "another review setting changes",
      selections: ["Review timeout: 30s", "90s", "Done"],
      models: [],
    },
  ])("discards an in-flight review when $name", async ({ selections, models }) => {
    const configPath = tempConfigPath();
    writeRawAdvisorConfig(
      {
        enabled: true,
        provider: "review-provider",
        model: "review-model",
        timeoutMs: 30_000,
        maxContextChars: 48_000,
      },
      configPath,
    );
    const pendingReview = deferred<AdvisorReview>();
    const harness = createHarness(resolvedConfig({ configPath }), pendingReview.promise);
    harness.select.mockImplementation(async () => selections.shift());
    harness.getAvailableModels.mockReturnValue(models);
    const reviewRun = harness.emit("turn_end", assistantEvent("candidate"));
    await vi.waitFor(() => expect(harness.requestReview).toHaveBeenCalledTimes(1));

    await harness.commands.get("advisor-settings")?.handler("", harness.ctx as never);
    pendingReview.resolve(revisionReview);
    await reviewRun;

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalledWith("Advisor approved this response.", "info");
    expect(harness.notify).not.toHaveBeenCalledWith(
      "Advisor review failed; keeping the original response.",
      "warning",
    );
    expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined);
  });

  test("shows a full critique and queues exactly one steering revision", async () => {
    const harness = createHarness(resolvedConfig(), revisionReview);

    await harness.emit("turn_end", assistantEvent("candidate needing revision"));

    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "advisor-review",
        display: true,
        content: expect.stringContaining("Preserve the existing behavior"),
        details: expect.objectContaining({ review: revisionReview }),
      }),
      { deliverAs: "steer" },
    );

    await harness.emit("message_end", {
      message: { role: "custom", customType: "advisor-review" },
    });
    await harness.emit("turn_end", assistantEvent("revised candidate"));
    expect(harness.requestReview).toHaveBeenCalledTimes(1);
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("tracks review outcomes for the current session and resets them on session start", async () => {
    const harness = createHarness();
    harness.requestReview
      .mockReset()
      .mockResolvedValueOnce(passingReview)
      .mockResolvedValueOnce(revisionReview)
      .mockRejectedValueOnce(new Error("provider failure"));

    await harness.emit("turn_end", assistantEvent("passing candidate"));
    await harness.emit("message_end", { message: { role: "user", content: "next" } });
    await harness.emit("turn_end", assistantEvent("revision candidate"));
    await harness.emit("message_end", { message: { role: "user", content: "next" } });
    await harness.emit("turn_end", assistantEvent("failing candidate"));

    harness.notify.mockClear();
    await harness.commands.get("advisor-status")?.handler("", harness.ctx as never);
    const populatedStatus = String(harness.notify.mock.lastCall?.[0]);
    expect(populatedStatus).toContain("Session review attempts: 3");
    expect(populatedStatus).toContain(
      "Session review outcomes: pass 1, revise 1, failure 1, discarded 0, in progress 0",
    );

    await harness.emit("session_start", { type: "session_start", reason: "new" });
    harness.notify.mockClear();
    await harness.commands.get("advisor-status")?.handler("", harness.ctx as never);
    const resetStatus = String(harness.notify.mock.lastCall?.[0]);
    expect(resetStatus).toContain("Session review attempts: 0");
    expect(resetStatus).toContain(
      "Session review outcomes: pass 0, revise 0, failure 0, discarded 0, in progress 0",
    );
  });

  test.each([
    ["textless", assistantEvent("")],
    ["tool-calling", assistantEvent("working", { toolCall: true })],
    ["tool-result", assistantEvent("working", { toolResults: [{}] })],
    ["length-truncated", assistantEvent("incomplete", { stopReason: "length" })],
    ["errored", assistantEvent("failed", { stopReason: "error" })],
    ["aborted", assistantEvent("cancelled", { stopReason: "aborted" })],
  ])("skips %s turns", async (_name, event) => {
    const harness = createHarness();
    await harness.emit("turn_end", event);
    expect(harness.requestReview).not.toHaveBeenCalled();
  });

  test("fails open when advisor review throws", async () => {
    const harness = createHarness(resolvedConfig(), new Error("provider leaked details"));

    await harness.emit("turn_end", assistantEvent("original candidate"));

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledWith(
      "Advisor review failed; keeping the original response.",
      "warning",
    );
    expect(harness.notify.mock.calls.flat().join(" ")).not.toContain("provider leaked details");
  });

  test("disabled review remains silent", async () => {
    const harness = createHarness(resolvedConfig({ enabled: false }));

    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.emit("turn_end", assistantEvent("candidate"));

    expect(harness.requestReview).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });
});
