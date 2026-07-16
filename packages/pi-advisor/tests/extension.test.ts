import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ResolvedCommand,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AdvisorClientDependencies } from "../src/client.ts";
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
      category: "intent",
      severity: "high",
      issue: "The answer changes behavior despite the user's constraint.",
      evidence: "The user required existing behavior to remain unchanged.",
      recommendation: "Preserve the existing behavior and revise the implementation advice.",
    },
  ],
};

const secondRevisionReview: AdvisorReview = {
  verdict: "revise",
  summary: "A different blocking problem remains.",
  findings: [
    {
      category: "correctness",
      severity: "high",
      issue: "The answer deletes required data.",
      evidence: "The request identifies the data as required.",
      recommendation: "Preserve the required data.",
    },
  ],
};

const advisoryReview: AdvisorReview = {
  verdict: "revise",
  summary: "The response has a material but non-blocking omission.",
  findings: [
    {
      category: "completeness",
      severity: "medium",
      issue: "The answer omits a relevant caveat.",
      evidence: "The caveat appears in the supplied context but not the answer.",
      recommendation: "Account for the caveat in subsequent work.",
    },
  ],
};

function resolvedConfig(overrides: Partial<ResolvedAdvisorConfig> = {}): ResolvedAdvisorConfig {
  return {
    configPath: "/tmp/pi-advisor.json",
    enabled: true,
    provider: "review-provider",
    model: "review-model",
    fastMode: false,
    thinkingLevel: "medium",
    reviewPolicy: "guardrail",
    revisionCooldownTurns: 0,
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
  const isIdle = vi.fn(() => true);
  const getAvailableModels = vi.fn((): Array<{ provider: string; id: string }> => []);
  const findModel = vi.fn(() => ({ provider: "review-provider", id: "review-model" }));
  const hasConfiguredAuth = vi.fn(() => true);
  const sendMessage = vi.fn();
  const registerMessageRenderer = vi.fn();
  const logFailure = vi.fn(() => "/tmp/logs/pi-advisor.jsonl");
  const requestReview = vi.fn(
    async (
      _ctx: unknown,
      _config: unknown,
      _transcript: unknown,
      _dependencies?: AdvisorClientDependencies,
    ) => {
      if (review instanceof Error) throw review;
      return await review;
    },
  );
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
    isIdle,
    isProjectTrusted: vi.fn(() => true),
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
    logFailure,
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
    isIdle,
    logFailure,
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
    expect(harness.notify).not.toHaveBeenCalled();
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

  test("returns from turn end while the advisor continues in the background", async () => {
    const pendingReview = deferred<AdvisorReview>();
    const harness = createHarness(resolvedConfig(), pendingReview.promise);

    await harness.emit("turn_end", assistantEvent("candidate"));

    expect(harness.requestReview).toHaveBeenCalledTimes(1);
    expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", "advisor: reviewing…");
    expect(harness.sendMessage).not.toHaveBeenCalled();

    pendingReview.resolve(passingReview);
    await vi.waitFor(() =>
      expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined),
    );
  });

  test("aborts an in-flight background review when newer user work starts", async () => {
    const pendingReview = deferred<AdvisorReview>();
    const harness = createHarness(resolvedConfig(), pendingReview.promise);

    await harness.emit("turn_end", assistantEvent("candidate"));
    const signal = harness.requestReview.mock.calls[0]?.[3]?.signal;
    expect(signal?.aborted).toBe(false);

    await harness.emit("message_end", { message: { role: "user", content: "new work" } });
    expect(signal?.aborted).toBe(true);

    pendingReview.resolve(passingReview);
    await vi.waitFor(() =>
      expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined),
    );
  });

  test("counts a started review invalidated by queued input as attempted and discarded", async () => {
    const pendingReview = deferred<AdvisorReview>();
    const harness = createHarness(resolvedConfig(), pendingReview.promise);
    const reviewRun = harness.emit("turn_end", assistantEvent("candidate"));
    await vi.waitFor(() => expect(harness.requestReview).toHaveBeenCalledTimes(1));

    harness.hasPendingMessages.mockReturnValue(true);
    pendingReview.resolve(revisionReview);
    await reviewRun;
    await vi.waitFor(() =>
      expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined),
    );

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
    expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined);

    await harness.commands.get("advisor-status")?.handler("--verbose", harness.ctx as never);
    const status = String(harness.notify.mock.lastCall?.[0]);
    expect(status).toContain("Session review attempts: 1");
    expect(status).toContain(
      "Session review outcomes: pass 0, revise 0, failure 0, discarded 1, in progress 0",
    );
  });

  test.each([
    {
      name: "automatic review is disabled",
      selections: ["Automatic review: on", "Apply changes"],
      models: [],
    },
    {
      name: "the advisor model is cleared",
      selections: [
        "Advisor model: review-provider/review-model",
        "Clear advisor model",
        "Apply changes",
      ],
      models: [],
    },
    {
      name: "the advisor model is switched",
      selections: [
        "Advisor model: review-provider/review-model",
        "new-provider/new-model",
        "Apply changes",
      ],
      models: [{ provider: "new-provider", id: "new-model" }],
    },
    {
      name: "another review setting changes",
      selections: ["Advanced settings", "Review timeout: 30s", "90s", "Back", "Apply changes"],
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
    await vi.waitFor(() =>
      expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined),
    );

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Advisor provider failure"),
      "warning",
    );
    expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined);
  });

  test("shows a full critique and queues exactly one steering revision", async () => {
    const harness = createHarness(resolvedConfig(), revisionReview);

    await harness.emit("turn_end", assistantEvent("candidate needing revision"));
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));

    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "advisor-review",
        display: true,
        content: expect.stringContaining("Preserve the existing behavior"),
        details: expect.objectContaining({ action: "revision", review: revisionReview }),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    await harness.emit("message_end", {
      message: { role: "custom", customType: "advisor-review" },
    });
    await harness.emit("turn_end", assistantEvent("revised candidate"));
    expect(harness.requestReview).toHaveBeenCalledTimes(1);
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("defers a high-severity revision until the primary agent settles", async () => {
    const harness = createHarness(resolvedConfig(), revisionReview);
    harness.isIdle.mockReturnValue(false);

    await harness.emit("turn_end", assistantEvent("candidate needing revision"));
    await vi.waitFor(() =>
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "pi-advisor",
        "advisor: revision pending…",
      ),
    );
    expect(harness.sendMessage).not.toHaveBeenCalled();

    harness.isIdle.mockReturnValue(true);
    await harness.emit("agent_settled", { type: "agent_settled" });

    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ action: "revision" }) }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  test("drops a deferred revision when newer user work starts", async () => {
    const harness = createHarness(resolvedConfig(), revisionReview);
    harness.isIdle.mockReturnValue(false);

    await harness.emit("turn_end", assistantEvent("candidate needing revision"));
    await vi.waitFor(() =>
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "pi-advisor",
        "advisor: revision pending…",
      ),
    );
    await harness.emit("message_end", { message: { role: "user", content: "new work" } });
    harness.isIdle.mockReturnValue(true);
    await harness.emit("agent_settled", { type: "agent_settled" });

    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  test("routes medium-only findings as advice in guardrail mode", async () => {
    const harness = createHarness(resolvedConfig(), advisoryReview);

    await harness.emit("turn_end", assistantEvent("candidate with a caveat"));
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));

    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("found issues"),
        details: expect.objectContaining({ action: "advice", review: advisoryReview }),
      }),
      { deliverAs: "steer" },
    );
  });

  test("strict mode revises medium findings while advice mode never revises", async () => {
    const strict = createHarness(resolvedConfig({ reviewPolicy: "strict" }), advisoryReview);
    await strict.emit("turn_end", assistantEvent("strict candidate"));
    await vi.waitFor(() => expect(strict.sendMessage).toHaveBeenCalledTimes(1));
    expect(strict.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ action: "revision" }) }),
      { deliverAs: "steer", triggerTurn: true },
    );

    const advice = createHarness(resolvedConfig({ reviewPolicy: "advice" }), revisionReview);
    await advice.emit("turn_end", assistantEvent("advice candidate"));
    await vi.waitFor(() => expect(advice.sendMessage).toHaveBeenCalledTimes(1));
    expect(advice.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ action: "advice" }) }),
      { deliverAs: "steer" },
    );
  });

  test("manual mode skips automatic work but /advisor once reviews the next response", async () => {
    const harness = createHarness(resolvedConfig({ reviewPolicy: "manual" }), passingReview);

    await harness.emit("turn_end", assistantEvent("automatic candidate"));
    expect(harness.requestReview).not.toHaveBeenCalled();

    await harness.commands.get("advisor")?.handler("once", harness.ctx as never);
    await harness.emit("message_end", { message: { role: "user", content: "next request" } });
    await harness.emit("turn_end", assistantEvent("explicit candidate"));
    await vi.waitFor(() => expect(harness.requestReview).toHaveBeenCalledTimes(1));

    harness.notify.mockClear();
    await harness.commands.get("advisor-status")?.handler("--verbose", harness.ctx as never);
    expect(String(harness.notify.mock.lastCall?.[0])).toContain("manual-policy 1");
  });

  test("/advisor cancel also clears a requested one-shot review", async () => {
    const harness = createHarness(resolvedConfig({ reviewPolicy: "manual" }), passingReview);

    await harness.commands.get("advisor")?.handler("once", harness.ctx as never);
    await harness.commands.get("advisor")?.handler("cancel", harness.ctx as never);
    await harness.emit("message_end", { message: { role: "user", content: "next request" } });
    await harness.emit("turn_end", assistantEvent("candidate"));

    expect(harness.requestReview).not.toHaveBeenCalled();
  });

  test("review-last and verify-last run on demand with the requested focus", async () => {
    const harness = createHarness(resolvedConfig({ reviewPolicy: "manual" }), passingReview);

    await harness.emit("turn_end", assistantEvent("candidate to inspect"));
    await harness.commands.get("advisor")?.handler("review-last", harness.ctx as never);
    await vi.waitFor(() => expect(harness.requestReview).toHaveBeenCalledTimes(1));
    expect(harness.requestReview.mock.calls[0]?.[3]?.focus).toBe("standard");

    await harness.commands.get("advisor")?.handler("verify-last", harness.ctx as never);
    await vi.waitFor(() => expect(harness.requestReview).toHaveBeenCalledTimes(2));
    expect(harness.requestReview.mock.calls[1]?.[3]?.focus).toBe("verification");
  });

  test("a newer user request does not inherit advisor-revision suppression", async () => {
    const harness = createHarness(resolvedConfig(), revisionReview);

    await harness.emit("turn_end", assistantEvent("candidate needing revision"));
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));
    await harness.emit("message_end", { message: { role: "user", content: "new request" } });
    await harness.emit("turn_end", assistantEvent("answer to new request"));

    await vi.waitFor(() => expect(harness.requestReview).toHaveBeenCalledTimes(2));
  });

  test("routes findings as advice during a configured revision cooldown", async () => {
    const harness = createHarness(resolvedConfig({ revisionCooldownTurns: 3 }));
    harness.requestReview
      .mockReset()
      .mockResolvedValueOnce(revisionReview)
      .mockResolvedValueOnce(secondRevisionReview);

    await harness.emit("turn_end", assistantEvent("first blocking candidate"));
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));
    await harness.emit("turn_end", assistantEvent("advisor revision"));
    await harness.emit("message_end", { message: { role: "user", content: "next request" } });
    await harness.emit("turn_end", assistantEvent("second blocking candidate"));
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(2));

    expect(harness.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ action: "advice", review: secondRevisionReview }),
      }),
      { deliverAs: "steer" },
    );
  });

  test("does not suppress recurring findings across independent user requests", async () => {
    const harness = createHarness(resolvedConfig(), advisoryReview);

    await harness.emit("turn_end", assistantEvent("first candidate"));
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));
    await harness.emit("turn_end", assistantEvent("advisor revision"));
    await harness.emit("message_end", { message: { role: "user", content: "next request" } });
    await harness.emit("turn_end", assistantEvent("second candidate"));
    await vi.waitFor(() =>
      expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined),
    );

    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    harness.notify.mockClear();
    await harness.commands.get("advisor-status")?.handler("--verbose", harness.ctx as never);
    expect(String(harness.notify.mock.lastCall?.[0])).toContain("Suppressed duplicate findings: 0");
  });

  test("deduplicates repeated findings across review commands for the same request", async () => {
    const harness = createHarness(resolvedConfig(), advisoryReview);

    await harness.emit("turn_end", assistantEvent("candidate"));
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));
    await harness.commands.get("advisor")?.handler("review-last", harness.ctx as never);
    await vi.waitFor(() => expect(harness.requestReview).toHaveBeenCalledTimes(2));

    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    harness.notify.mockClear();
    await harness.commands.get("advisor-status")?.handler("--verbose", harness.ctx as never);
    expect(String(harness.notify.mock.lastCall?.[0])).toContain("Suppressed duplicate findings: 1");
  });

  test("passes advisor guidance and records usage telemetry", async () => {
    const configPath = tempConfigPath();
    const agentDir = dirname(dirname(configPath));
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "ADVISOR.md"), "Watch durable queue invariants.", "utf8");
    const harness = createHarness(resolvedConfig({ configPath }));
    harness.requestReview.mockImplementation(async (_ctx, _config, _transcript, dependencies) => {
      dependencies?.onUsage?.({
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        cost: 0.125,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 22,
      });
      return passingReview;
    });

    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.emit("turn_end", assistantEvent("candidate"));
    await vi.waitFor(() =>
      expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined),
    );

    expect(harness.requestReview.mock.calls[0]?.[3]?.instructions).toContain(
      "Watch durable queue invariants.",
    );
    harness.notify.mockClear();
    await harness.commands.get("advisor-status")?.handler("--verbose", harness.ctx as never);
    const status = String(harness.notify.mock.lastCall?.[0]);
    expect(status).toContain(`Advisor guidance: ${join(agentDir, "ADVISOR.md")}`);
    expect(status).toContain(
      "Advisor tokens: input 10, output 5, cache read 3, cache write 4, total 22",
    );
    expect(status).toContain("Advisor cost: $0.125000");
    expect(status).toMatch(/Latest review duration: [\d,]+ ms/);
  });

  test("tracks review outcomes for the current session and resets them on session start", async () => {
    const harness = createHarness();
    harness.requestReview
      .mockReset()
      .mockResolvedValueOnce(passingReview)
      .mockResolvedValueOnce(revisionReview)
      .mockRejectedValueOnce(new Error("provider failure"));

    await harness.emit("turn_end", assistantEvent("passing candidate"));
    await vi.waitFor(() =>
      expect(harness.setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined),
    );
    await harness.emit("message_end", { message: { role: "user", content: "next" } });
    await harness.emit("turn_end", assistantEvent("revision candidate"));
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));
    await harness.emit("turn_end", assistantEvent("revised candidate"));
    await harness.emit("message_end", { message: { role: "user", content: "next" } });
    await harness.emit("turn_end", assistantEvent("failing candidate"));
    await vi.waitFor(() =>
      expect(harness.notify).toHaveBeenCalledWith(
        expect.stringContaining("Advisor provider failure"),
        "warning",
      ),
    );

    harness.notify.mockClear();
    await harness.commands.get("advisor-status")?.handler("--verbose", harness.ctx as never);
    const populatedStatus = String(harness.notify.mock.lastCall?.[0]);
    expect(populatedStatus).toContain("Session review attempts: 3");
    expect(populatedStatus).toContain(
      "Session review outcomes: pass 1, revise 1, failure 1, discarded 0, in progress 0",
    );

    await harness.emit("session_start", { type: "session_start", reason: "new" });
    harness.notify.mockClear();
    await harness.commands.get("advisor-status")?.handler("--verbose", harness.ctx as never);
    const resetStatus = String(harness.notify.mock.lastCall?.[0]);
    expect(resetStatus).toContain("Session review attempts: 0");
    expect(resetStatus).toContain(
      "Session review outcomes: pass 0, revise 0, failure 0, discarded 0, in progress 0",
    );
  });

  test.each([
    ["textless", assistantEvent("")],
    ["tool-calling", assistantEvent("working", { toolCall: true })],
    ["length-truncated", assistantEvent("incomplete", { stopReason: "length" })],
    ["errored", assistantEvent("failed", { stopReason: "error" })],
    ["aborted", assistantEvent("cancelled", { stopReason: "aborted" })],
  ])("skips %s turns", async (_name, event) => {
    const harness = createHarness();
    await harness.emit("turn_end", event);
    expect(harness.requestReview).not.toHaveBeenCalled();
  });

  test("reviews a completed final response even when the turn reports tool results", async () => {
    const harness = createHarness();

    await harness.emit("turn_end", assistantEvent("completed", { toolResults: [{}] }));

    expect(harness.requestReview).toHaveBeenCalledTimes(1);
  });

  test("fails open when advisor review throws", async () => {
    const harness = createHarness(resolvedConfig(), new Error("provider leaked details"));

    await harness.emit("turn_end", assistantEvent("original candidate"));
    await vi.waitFor(() =>
      expect(harness.notify).toHaveBeenCalledWith(
        expect.stringContaining("Advisor provider failure"),
        "warning",
      ),
    );

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.logFailure).toHaveBeenCalledWith(
      "/tmp/pi-advisor.json",
      expect.objectContaining({
        contextChars: expect.any(Number),
        durationMs: expect.any(Number),
        error: expect.objectContaining({ message: "provider leaked details" }),
        model: "review-model",
        provider: "review-provider",
        timeoutMs: 30_000,
      }),
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining("Advisor provider failure"),
      "warning",
    );
    expect(harness.notify.mock.calls.flat().join(" ")).not.toContain("provider leaked details");
  });

  test("rate-limits repeated failure warnings by failure class", async () => {
    const harness = createHarness(resolvedConfig(), new Error("provider outage"));

    await harness.emit("turn_end", assistantEvent("first candidate"));
    await vi.waitFor(() => expect(harness.requestReview).toHaveBeenCalledTimes(1));
    await harness.emit("message_end", { message: { role: "user", content: "next request" } });
    await harness.emit("turn_end", assistantEvent("second candidate"));
    await vi.waitFor(() => expect(harness.requestReview).toHaveBeenCalledTimes(2));

    expect(
      harness.notify.mock.calls.filter(([message]) =>
        String(message).includes("Advisor provider failure"),
      ),
    ).toHaveLength(1);
  });

  test("disabled review remains silent", async () => {
    const harness = createHarness(resolvedConfig({ enabled: false }));

    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.emit("turn_end", assistantEvent("candidate"));

    expect(harness.requestReview).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });
});
