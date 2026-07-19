import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ResolvedCommand,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeDriver,
  AdvisorRuntimeStartOptions,
} from "../src/advisor-runtime.ts";
import type { ResolvedAdvisorConfig } from "../src/config.ts";
import { createAdvisorExtension } from "../src/extension.ts";

function config(overrides: Partial<ResolvedAdvisorConfig> = {}): ResolvedAdvisorConfig {
  return {
    configPath: "/tmp/pi-advisor.json",
    enabled: true,
    provider: "p",
    model: "m",
    fastMode: false,
    thinkingLevel: "medium",
    reviewPolicy: "guardrail",
    timeoutMs: 30_000,
    maxContextChars: 48_000,
    configured: true,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function harness(
  overrides: Partial<ResolvedAdvisorConfig> = {},
  options: {
    runtimeStartError?: Error;
    runtimeStartPromises?: Array<Promise<void> | undefined>;
    catchUpTimeoutMs?: number;
    branch?: Array<Record<string, unknown>>;
    withoutSessionId?: boolean;
  } = {},
) {
  type Handler = (event: never, ctx: ExtensionContext) => unknown | Promise<unknown>;
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Omit<ResolvedCommand, "name" | "sourceInfo">>();
  const sendMessage = vi.fn();
  const appended: unknown[] = [];
  const runtimes: Array<{
    driver: AdvisorRuntimeDriver;
    requests: AdvisorCheckpointRequest[];
    pending: Array<ReturnType<typeof deferred<AdvisorCheckpoint>>>;
  }> = [];
  const createRuntime = () => {
    const runtimeIndex = runtimes.length;
    const requests: AdvisorCheckpointRequest[] = [];
    const pending: Array<ReturnType<typeof deferred<AdvisorCheckpoint>>> = [];
    const driver: AdvisorRuntimeDriver = {
      activeToolNames: ["read", "grep", "find", "ls"],
      start: vi.fn(async () => {
        if (options.runtimeStartError) throw options.runtimeStartError;
        await options.runtimeStartPromises?.[runtimeIndex];
      }),
      checkpoint: vi.fn((request: AdvisorCheckpointRequest) => {
        requests.push(request);
        const wait = deferred<AdvisorCheckpoint>();
        pending.push(wait);
        return wait.promise;
      }),
      steer: vi.fn(async () => true),
      reprime: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    runtimes.push({ driver, requests, pending });
    return driver;
  };
  const branch = options.branch ?? [
    {
      id: "anchor",
      type: "message",
      parentId: null,
      timestamp: "now",
      message: { role: "user", content: "request" },
    },
  ];
  const pi = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: Omit<ResolvedCommand, "name" | "sourceInfo">) =>
      commands.set(name, command),
    registerMessageRenderer: vi.fn(),
    sendMessage,
    appendEntry: vi.fn((customType: string, data: unknown) => {
      appended.push(data);
      branch.push({
        id: `ledger-${branch.length}`,
        type: "custom",
        parentId: branch.at(-1)?.id ?? null,
        timestamp: "now",
        customType,
        data,
      });
    }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/project",
    mode: "tui",
    hasUI: true,
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn(() => false),
    isIdle: vi.fn(() => true),
    isProjectTrusted: vi.fn(() => true),
    ui: { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn() },
    modelRegistry: { getAvailable: vi.fn(() => []), find: vi.fn(), hasConfiguredAuth: vi.fn() },
    sessionManager: {
      buildContextEntries: vi.fn(() => []),
      getBranch: vi.fn(() => branch),
      getLeafId: vi.fn(() => "anchor"),
      ...(options.withoutSessionId ? {} : { getSessionId: vi.fn(() => "session") }),
    },
  } as unknown as ExtensionContext;
  const logFailure = vi.fn();
  createAdvisorExtension({
    loadConfig: () => config(overrides),
    createRuntime,
    logFailure,
    catchUpTimeoutMs: options.catchUpTimeoutMs,
  })(pi);
  const emitAwait = async (name: string, event: unknown) => {
    for (const handler of handlers.get(name) ?? []) await handler(event as never, ctx);
  };
  const emit = async (name: string, event: unknown) => {
    if (name !== "turn_end") return emitAwait(name, event);
    for (const handler of handlers.get(name) ?? []) {
      Promise.resolve(handler(event as never, ctx)).catch(() => undefined);
    }
  };
  return { appended, branch, commands, ctx, emit, emitAwait, logFailure, runtimes, sendMessage };
}

function finalTurn(text: string) {
  return {
    type: "turn_end",
    turnIndex: 1,
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
    toolResults: [],
  };
}

function pass(request: AdvisorCheckpointRequest): AdvisorCheckpoint {
  return {
    checkpointId: request.checkpointId,
    processedThrough: request.processedThrough,
    stateSummary: "compact",
    verdict: "pass",
    summary: "No issue.",
    findings: [],
  };
}

function revise(
  request: AdvisorCheckpointRequest,
  severity: "blocker" | "concern" = "blocker",
  issue = "The answer is wrong.",
): AdvisorCheckpoint {
  return {
    ...pass(request),
    verdict: "revise",
    summary: "An issue remains.",
    findings: [
      {
        fingerprint:
          issue
            .normalize("NFKC")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 160) || "finding",
        category: "correctness",
        severity,
        confidence: "high",
        evidenceBasis: "direct",
        issue,
        evidence: "The transcript contradicts it.",
        recommendation: "Correct the answer.",
      },
    ],
  };
}

function confidentBlocker(
  request: AdvisorCheckpointRequest,
  fingerprint = "verified-blocker",
): AdvisorCheckpoint {
  const checkpoint = revise(request, "blocker", "A verified blocker remains.");
  return {
    ...checkpoint,
    findings: checkpoint.findings.map((finding) => ({
      ...finding,
      fingerprint,
      confidence: "high",
      evidenceBasis: "direct",
    })),
  };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function resolveVerifiedBlocker(
  runtime: ReturnType<typeof harness>["runtimes"][number],
  initialIndex: number,
  issue = "The answer is wrong.",
): Promise<number> {
  const initial = revise(runtime.requests[initialIndex]!, "blocker", issue);
  runtime.pending[initialIndex]!.resolve(initial);
  await tick();
  const verificationIndex = runtime.requests.length - 1;
  expect(runtime.requests[verificationIndex]?.focus).toBe("blocker-verification");
  expect(runtime.requests[verificationIndex]?.verificationReview?.findings).toEqual(
    initial.findings,
  );
  runtime.pending[verificationIndex]!.resolve(
    revise(runtime.requests[verificationIndex]!, "blocker", issue),
  );
  await tick();
  return verificationIndex;
}

async function emitToolLoop(value: ReturnType<typeof harness>, prefix: string): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await value.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: `${prefix}-${index}`,
      toolName: "read",
      args: { path: "src/a.ts" },
    });
    await value.emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: `${prefix}-${index}`,
      toolName: "read",
      result: "same",
      isError: false,
    });
  }
}

describe("persistent extension cutover", () => {
  test("completed turns await only their correlated Advisor settlement", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    let settled = false;
    const turn = value.emitAwait("turn_end", finalTurn("held until review"));
    void turn.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    const current = value.runtimes[0]!;
    expect(current.requests).toHaveLength(1);
    current.pending[0]!.resolve(pass(current.requests[0]!));
    await turn;
    expect(settled).toBe(true);
    expect((value.ctx as unknown as { waitForIdle?: unknown }).waitForIdle).toBeUndefined();
  });

  test("cursor rewrite restart and checkpoint both remain inside the same catch-up barrier", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    (value.ctx.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: "replacement",
        type: "message",
        parentId: null,
        timestamp: "now",
        message: { role: "user", content: "replacement" },
      },
    ]);
    let settled = false;
    const turn = value.emitAwait("turn_end", finalTurn("must be reviewed after reseed"));
    void turn.then(() => {
      settled = true;
    });
    await tick();

    expect(value.runtimes).toHaveLength(2);
    expect(value.runtimes[1]!.requests).toHaveLength(1);
    expect(settled).toBe(false);
    value.runtimes[1]!.pending[0]!.resolve(pass(value.runtimes[1]!.requests[0]!));
    await turn;
    expect(settled).toBe(true);
  });

  test("a completed tool-progress turn cannot advance before its catch-up barrier", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    const progress = {
      ...finalTurn(""),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }],
        stopReason: "stop",
      },
    };
    let settled = false;
    const turn = value.emitAwait("turn_end", progress);
    void turn.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    const current = value.runtimes[0]!;
    expect(current.requests[0]?.focus).toBe("observation");
    current.pending[0]!.resolve(pass(current.requests[0]!));
    await turn;
    expect(settled).toBe(true);
  });

  test("tool-boundary catch-up is observation-only while a final blocker still delivers", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    const progress = {
      ...finalTurn(""),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }],
        stopReason: "stop",
      },
    };

    const progressTurn = value.emitAwait("turn_end", progress);
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(
      revise(current.requests[0]!, "blocker", "The response is not finished yet."),
    );
    await progressTurn;
    expect(value.sendMessage).not.toHaveBeenCalled();

    const final = value.emitAwait("turn_end", finalTurn("finished answer"));
    await tick();
    await resolveVerifiedBlocker(current, 1, "The finished answer has a material error.");
    await final;
    expect(value.sendMessage).toHaveBeenCalledOnce();
    expect(value.sendMessage.mock.lastCall?.[1]).toEqual({
      deliverAs: "steer",
      triggerTurn: true,
    });
  });

  test("catch-up timeout fails open and permanently stales the late result", async () => {
    const value = harness({}, { catchUpTimeoutMs: 10 });
    await value.emit("session_start", { type: "session_start" });
    await value.emitAwait("turn_end", finalTurn("timeout candidate"));
    const current = value.runtimes[0]!;
    expect(current.requests).toHaveLength(1);
    current.pending[0]!.resolve(revise(current.requests[0]!, "blocker", "late blocker"));
    await tick();
    expect(value.sendMessage).not.toHaveBeenCalled();
    await value.commands.get("advisor-status")!.handler("--verbose", value.ctx as never);
    expect(String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0])).toContain(
      "timeouts 1",
    );
  });

  test("provider failure, runtime reset, and parent cancellation release catch-up early", async () => {
    const provider = harness();
    await provider.emit("session_start", { type: "session_start" });
    const providerTurn = provider.emitAwait("turn_end", finalTurn("provider failure"));
    await tick();
    provider.runtimes[0]!.pending[0]!.reject(new Error("provider unavailable"));
    await providerTurn;

    const reset = harness();
    await reset.emit("session_start", { type: "session_start" });
    const resetTurn = reset.emitAwait("turn_end", finalTurn("reset"));
    await tick();
    await reset.emit("session_tree", { type: "session_tree" });
    await resetTurn;

    const cancelled = harness();
    const controller = new AbortController();
    (cancelled.ctx as unknown as { signal: AbortSignal }).signal = controller.signal;
    await cancelled.emit("session_start", { type: "session_start" });
    const cancelledTurn = cancelled.emitAwait("turn_end", finalTurn("cancelled"));
    await tick();
    controller.abort();
    await cancelledTurn;
    const current = cancelled.runtimes[0]!;
    current.pending[0]!.resolve(
      revise(current.requests[0]!, "blocker", "must not surprise-resume"),
    );
    await tick();
    expect(cancelled.sendMessage).not.toHaveBeenCalled();
  });

  test("abort dispatch synchronously defeats a same-tick provider completion", async () => {
    const value = harness();
    const controller = new AbortController();
    (value.ctx as unknown as { signal: AbortSignal }).signal = controller.signal;
    await value.emit("session_start", { type: "session_start" });
    const turn = value.emitAwait("turn_end", finalTurn("racy candidate"));
    await tick();
    const current = value.runtimes[0]!;

    current.pending[0]!.resolve(revise(current.requests[0]!, "blocker", "racy blocker"));
    controller.abort();
    await turn;
    await tick();

    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(value.appended.at(-1)).toMatchObject({
      routing: { cancellationLatched: true },
    });
  });

  test("counts cancellation at the final delivery boundary as a calibration discard", async () => {
    const value = harness({ reviewPolicy: "guardrail" });
    const controller = new AbortController();
    (value.ctx as unknown as { signal: AbortSignal }).signal = controller.signal;
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockImplementation(() => {
      controller.abort();
      return true;
    });
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("delivery-boundary candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(revise(current.requests[0]!, "concern", "delivery-boundary issue"));
    await tick();

    expect(value.sendMessage).not.toHaveBeenCalled();
    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    expect(String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0])).toContain(
      "Discarded: 1 · failures 0",
    );
  });

  test("ingests thinking synchronously and serializes checkpoints without cancellation", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_start", { type: "turn_start", turnIndex: 1 });
    for (let index = 0; index < 1_000; index += 1) {
      await value.emit("message_update", {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: `chunk-${index};` },
      });
    }
    await value.emit("turn_end", finalTurn("first"));
    await value.emit("turn_end", finalTurn("second"));
    await tick();

    const current = value.runtimes[0];
    if (!current) throw new Error("runtime not created");
    expect(current.requests).toHaveLength(1);
    expect(current.requests[0]?.observations).toContain("assistant_thinking_delta");
    expect(current.driver.abort).not.toHaveBeenCalled();
    current.pending[0]?.resolve(pass(current.requests[0]!));
    await tick();
    expect(current.requests).toHaveLength(2);
    current.pending[1]?.resolve(pass(current.requests[1]!));
    await tick();
    await tick();
    expect(value.appended).toHaveLength(2);
  });

  test("starts once per parent session and disposes on shutdown", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    const current = value.runtimes[0];
    expect(current?.driver.start).toHaveBeenCalledOnce();
    await value.emit("session_shutdown", { type: "session_shutdown" });
    expect(current?.driver.dispose).toHaveBeenCalledOnce();
  });

  test.each(["session_tree", "session_compact"])(
    "%s invalidation discards an old-epoch completion and re-primes",
    async (eventName) => {
      const value = harness();
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", finalTurn("old branch"));
      await tick();
      const old = value.runtimes[0];
      if (!old?.requests[0]) throw new Error("missing checkpoint");
      await value.emit(eventName, { type: eventName });
      old.pending[0]?.resolve(pass(old.requests[0]));
      await tick();

      expect(value.runtimes).toHaveLength(2);
      expect(old.driver.dispose).toHaveBeenCalled();
      expect(value.sendMessage).not.toHaveBeenCalled();
      expect(value.appended).toHaveLength(0);
      if (eventName === "session_tree") {
        await value.commands.get("advisor")!.handler("review-last", value.ctx as never);
        await tick();
        expect(value.runtimes[1]?.requests).toHaveLength(0);
      }
    },
  );

  test("detects an unannounced parent-prefix replacement at a checkpoint boundary", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    (value.ctx.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: "replacement",
        type: "message",
        parentId: null,
        timestamp: "now",
        message: { role: "user", content: "replacement" },
      },
    ]);
    await value.emit("turn_end", finalTurn("new prefix"));
    await tick();
    expect(value.runtimes).toHaveLength(2);
    expect(value.runtimes[0]?.driver.dispose).toHaveBeenCalled();
    expect(value.runtimes[0]?.requests).toHaveLength(0);
    expect(value.runtimes[1]?.requests).toHaveLength(1);
    value.runtimes[1]!.pending[0]!.resolve(pass(value.runtimes[1]!.requests[0]!));
    await tick();
    expect(value.sendMessage).not.toHaveBeenCalled();
  });

  test("advances the processed anchor and detects a shared-prefix sibling rewrite", async () => {
    const value = harness();
    const root = {
      id: "root",
      type: "message",
      parentId: null,
      timestamp: "now",
      message: { role: "user", content: "root" },
    };
    const firstLeaf = {
      id: "first-leaf",
      type: "message",
      parentId: "root",
      timestamp: "now",
      message: { role: "assistant", content: "first" },
    };
    (value.ctx.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      root,
      firstLeaf,
    ]);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("checkpoint on first sibling"));
    await tick();
    const firstRuntime = value.runtimes[0]!;
    firstRuntime.pending[0]!.resolve(pass(firstRuntime.requests[0]!));
    await tick();

    (value.ctx.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      root,
      { ...firstLeaf, id: "second-leaf", message: { role: "assistant", content: "second" } },
    ]);
    await value.emit("turn_end", finalTurn("checkpoint on sibling"));
    await tick();

    expect(value.runtimes).toHaveLength(2);
    expect(firstRuntime.driver.dispose).toHaveBeenCalledOnce();
    expect(value.runtimes[1]!.requests).toHaveLength(1);
    value.runtimes[1]!.pending[0]!.resolve(pass(value.runtimes[1]!.requests[0]!));
    await tick();
  });

  test("discards a checkpoint completed after newer genuine user work", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("old answer"));
    await tick();
    const current = value.runtimes[0];
    if (!current?.requests[0]) throw new Error("missing checkpoint");
    await value.emit("message_end", {
      type: "message_end",
      message: { role: "user", content: "new request" },
    });
    current.pending[0]?.resolve(revise(current.requests[0]));
    await tick();
    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(value.ctx.abort).not.toHaveBeenCalled();
  });

  test("suppresses delivery when user input is queued", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0];
    if (!current?.requests[0]) throw new Error("missing checkpoint");
    (value.ctx.hasPendingMessages as ReturnType<typeof vi.fn>).mockReturnValue(true);
    current.pending[0]?.resolve(revise(current.requests[0]));
    await tick();
    expect(value.sendMessage).not.toHaveBeenCalled();
  });

  test("fails open when a persistent checkpoint rejects", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("primary answer remains"));
    await tick();
    const current = value.runtimes[0];
    current?.pending[0]?.reject(new Error("provider unavailable"));
    await tick();

    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(value.ctx.abort).not.toHaveBeenCalled();
    expect(value.appended).toHaveLength(0);
    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    const usage = String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0]);
    expect(usage).toContain("Reviews: 1 attempted · 1 settled · 0 in progress");
    expect(usage).toContain("Discarded: 0 · failures 1");
  });

  test("suppresses duplicate findings within one parent-turn scope", async () => {
    const value = harness();
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("first checkpoint"));
    await value.emit("turn_end", finalTurn("second checkpoint"));
    await tick();
    const current = value.runtimes[0];
    if (!current?.requests[0]) throw new Error("missing first checkpoint");
    current.pending[0]!.resolve(revise(current.requests[0]!, "concern"));
    await tick();
    if (!current.requests[1]) throw new Error("missing second checkpoint");
    current.pending[1]!.resolve(revise(current.requests[1]!, "concern"));
    await tick();
    expect(value.sendMessage).toHaveBeenCalledTimes(1);
    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    expect(String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0])).toContain(
      "Reviews: 2 attempted · 2 settled · 0 in progress",
    );
  });

  test("manual once, review-last, pause, resume and cancel commands remain registered", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    expect([...value.commands.keys()].sort()).toEqual([
      "advisor",
      "advisor-settings",
      "advisor-status",
      "advisor-usage",
    ]);
    const command = value.commands.get("advisor");
    if (!command) throw new Error("advisor command missing");

    await command.handler("pause", value.ctx as never);
    await command.handler("resume", value.ctx as never);
    await tick();
    await command.handler("once", value.ctx as never);
    await value.emit("turn_end", finalTurn("manual next response"));
    await tick();
    expect(value.runtimes.at(-1)?.requests).toHaveLength(1);
    await command.handler("cancel", value.ctx as never);
  });

  test("review-last warns only when no completed response exists", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });

    await value.commands.get("advisor")!.handler("review-last", value.ctx as never);

    expect(value.ctx.ui.notify).toHaveBeenLastCalledWith(
      "No completed response is available to review.",
      "warning",
    );
  });

  test("does not recursively observe an advisor review custom message as genuine user work", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("message_end", {
      type: "message_end",
      message: { role: "custom", customType: "advisor-review", content: "critique" },
    });
    await value.emit("turn_end", finalTurn("answer"));
    await tick();
    const request = value.runtimes[0]?.requests[0];
    expect(request?.observations).not.toContain("critique");
  });

  test("steers an active parent without triggering a synthetic turn", async () => {
    const value = harness();
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    await resolveVerifiedBlocker(current, 0);
    expect(value.sendMessage).toHaveBeenCalledWith(expect.anything(), { deliverAs: "steer" });
    expect(value.ctx.abort).not.toHaveBeenCalled();
  });

  test("confirmed trajectory aborts, settles, and delivers recovery guidance", async () => {
    vi.useFakeTimers();
    try {
      const value = harness();
      (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_start", { type: "turn_start", turnIndex: 1 });
      await value.emit("message_update", {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "repeat-this-unit".repeat(12),
        },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const current = value.runtimes[0]!;
      expect(current.requests[0]?.focus).toBe("trajectory");
      const initial = revise(current.requests[0]!);
      current.pending[0]!.resolve(initial);
      await vi.advanceTimersByTimeAsync(0);
      expect(current.requests[1]?.focus).toBe("blocker-verification");
      expect(current.requests[1]?.verificationReview?.findings).toEqual(initial.findings);
      current.pending[1]!.resolve(revise(current.requests[1]!));
      await vi.advanceTimersByTimeAsync(0);
      expect(value.ctx.abort).toHaveBeenCalledOnce();
      expect(value.appended).toHaveLength(1);

      await value.emit("turn_end", {
        ...finalTurn(""),
        message: { role: "assistant", content: [], stopReason: "aborted" },
      });
      (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(true);
      await value.emit("agent_settled", { type: "agent_settled" });
      expect(value.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ details: expect.objectContaining({ action: "recovery" }) }),
        { deliverAs: "steer", triggerTurn: true },
      );
      expect(value.appended).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("suppresses a late blocker after an external abort without waking the parent", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    await value.emit("turn_end", {
      ...finalTurn(""),
      message: { role: "assistant", content: [], stopReason: "aborted" },
    });
    current.pending[0]!.resolve(revise(current.requests[0]!));
    await tick();
    expect(value.ctx.abort).not.toHaveBeenCalled();
    expect(value.sendMessage).not.toHaveBeenCalled();
  });

  test("drops a late completion after newer genuine user work", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    await value.emit("message_end", {
      type: "message_end",
      message: { role: "user", content: "newer work" },
    });
    current.pending[0]!.resolve(revise(current.requests[0]!));
    await tick();
    expect(value.sendMessage).not.toHaveBeenCalled();
  });

  test.each(["pause", "cancel"])(
    "%s cancels in-flight work without late delivery",
    async (action) => {
      const value = harness();
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", finalTurn("candidate"));
      await tick();
      const current = value.runtimes[0]!;
      await value.commands.get("advisor")!.handler(action, value.ctx as never);
      current.pending[0]!.resolve(revise(current.requests[0]!));
      await tick();
      expect(value.sendMessage).not.toHaveBeenCalled();
    },
  );

  test("allows at most one advisor correction in one request", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("first"));
    await tick();
    const current = value.runtimes[0]!;
    await resolveVerifiedBlocker(current, 0, "first issue");
    await value.emit("turn_end", finalTurn("second"));
    await tick();
    await resolveVerifiedBlocker(current, 2, "second issue");
    expect(value.sendMessage).toHaveBeenCalledTimes(1);
    expect(
      value.sendMessage.mock.calls.filter((call) => call[1]?.triggerTurn === true),
    ).toHaveLength(1);
    expect(value.sendMessage.mock.calls[0]?.[0]?.details?.action).toBe("revision");
  });

  test("requires a correlated second pass before delivering a high-confidence blocker", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    const initial = confidentBlocker(current.requests[0]!);
    current.pending[0]!.resolve(initial);
    await tick();

    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(current.requests[1]?.focus).toBe("blocker-verification");
    expect(current.requests[1]?.verificationReview?.findings).toEqual(initial.findings);
    current.pending[1]!.resolve(confidentBlocker(current.requests[1]!));
    await tick();

    expect(value.sendMessage).toHaveBeenCalledOnce();
    expect(value.sendMessage.mock.lastCall?.[1]).toEqual({
      deliverAs: "steer",
      triggerTurn: true,
    });
  });

  test("correlates blocker verification with canonical fingerprint formatting", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(confidentBlocker(current.requests[0]!, "Unsupported Test Claim"));
    await tick();
    current.pending[1]!.resolve(confidentBlocker(current.requests[1]!, "unsupported_test-claim"));
    await tick();

    expect(value.sendMessage).toHaveBeenCalledOnce();
    expect(value.sendMessage.mock.lastCall?.[0]?.details?.review).toMatchObject({
      findings: [expect.objectContaining({ status: "acknowledged", severity: "blocker" })],
    });
  });

  test("retains weaker blockers for deterministic downgrade when strong blockers are rejected", async () => {
    const value = harness({ reviewPolicy: "guardrail" });
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    const strong = confidentBlocker(current.requests[0]!, "strong-blocker").findings[0]!;
    const weak = {
      ...strong,
      fingerprint: "weak-blocker",
      confidence: "medium" as const,
      evidenceBasis: "inferred" as const,
      issue: "A weaker blocker should be downgraded.",
    };
    current.pending[0]!.resolve({
      ...pass(current.requests[0]!),
      verdict: "revise",
      summary: "Mixed blockers.",
      findings: [strong, weak],
    });
    await tick();
    current.pending[1]!.resolve(pass(current.requests[1]!));
    await tick();

    expect(value.sendMessage).toHaveBeenCalledOnce();
    expect(value.sendMessage.mock.lastCall?.[0]?.details?.review).toMatchObject({
      findings: [expect.objectContaining({ severity: "concern", status: "acknowledged" })],
    });
    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    expect(String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0])).toContain(
      "Verification reviews: 1 attempted · blocker fingerprints 0 confirmed · 1 rejected",
    );
  });

  test("drops an unconfirmed blocker without disturbing the primary response", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(confidentBlocker(current.requests[0]!));
    await tick();
    current.pending[1]!.resolve(pass(current.requests[1]!));
    await tick();

    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(value.ctx.abort).not.toHaveBeenCalled();
  });

  test("preserves the original summary when blocker verification leaves a concern", async () => {
    const value = harness();
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    const initial = confidentBlocker(current.requests[0]!, "unconfirmed-blocker");
    initial.summary = "The completed response still has a supported concern.";
    initial.findings.push({
      fingerprint: "supported-concern",
      category: "evidence",
      severity: "concern",
      confidence: "high",
      evidenceBasis: "direct",
      issue: "A validation claim is unsupported.",
      evidence: "No matching test result is present.",
      recommendation: "Run and report the focused test.",
    });
    current.pending[0]!.resolve(initial);
    await tick();
    current.pending[1]!.resolve({
      ...pass(current.requests[1]!),
      summary: "No blocker was confirmed.",
    });
    await tick();

    expect(value.sendMessage.mock.lastCall?.[0]?.details?.review).toMatchObject({
      summary: "The completed response still has a supported concern.",
      findings: [expect.objectContaining({ severity: "concern" })],
    });
  });

  test("counts confirmed and rejected blockers per fingerprint", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    const initial = confidentBlocker(current.requests[0]!, "confirmed-blocker");
    initial.findings.push({
      ...initial.findings[0]!,
      fingerprint: "rejected-blocker",
      issue: "A second blocker was proposed.",
    });
    current.pending[0]!.resolve(initial);
    await tick();
    current.pending[1]!.resolve(confidentBlocker(current.requests[1]!, "confirmed-blocker"));
    await tick();

    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    expect(String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0])).toContain(
      "Verification reviews: 1 attempted · blocker fingerprints 1 confirmed · 1 rejected",
    );
  });

  test("allows a resolved finding to recur in a later genuine request", async () => {
    const value = harness({ reviewPolicy: "guardrail" });
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("first candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(revise(current.requests[0]!, "concern", "recurring issue"));
    await tick();

    await value.emit("message_end", { message: { role: "user", content: "resolve it" } });
    await value.emit("turn_end", finalTurn("resolved candidate"));
    await tick();
    current.pending[1]!.resolve(pass(current.requests[1]!));
    await tick();

    await value.emit("message_end", { message: { role: "user", content: "new request" } });
    await value.emit("turn_end", finalTurn("regressed candidate"));
    await tick();
    current.pending[2]!.resolve(revise(current.requests[2]!, "concern", "recurring issue"));
    await tick();

    expect(value.sendMessage).toHaveBeenCalledTimes(2);
  });

  test("allows blocker routing across genuine user request boundaries", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    const complete = async (issue: string) => {
      await value.emit("turn_end", finalTurn(issue));
      await tick();
      const current = value.runtimes[0]!;
      const index = current.requests.length - 1;
      await resolveVerifiedBlocker(current, index, issue);
    };
    await complete("first");
    await value.emit("message_end", { message: { role: "user", content: "second request" } });
    await complete("second");
    await value.emit("message_end", { message: { role: "user", content: "third request" } });
    await complete("third");
    expect(value.sendMessage.mock.calls.map((call) => call[0]?.details?.action)).toEqual([
      "revision",
      "revision",
      "revision",
    ]);
  });

  test.each([
    ["guardrail", "concern"],
    ["advisory", "blocker"],
  ] as const)(
    "drops automatic direct %s %s advice when the parent is idle",
    async (policy, severity) => {
      const value = harness({ reviewPolicy: policy });
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", finalTurn("candidate"));
      await tick();
      const current = value.runtimes[0]!;
      current.pending[0]!.resolve(revise(current.requests[0]!, severity));
      await tick();
      expect(value.sendMessage).not.toHaveBeenCalled();
    },
  );

  const expectRedactedLabels = (value: ReturnType<typeof harness>): void => {
    const details = value.sendMessage.mock.lastCall?.[0]?.details as {
      provider: string;
      model: string;
    };
    const persisted = JSON.stringify(details);

    expect(details.provider.length).toBeLessThanOrEqual(256);
    expect(details.model.length).toBeLessThanOrEqual(256);
    expect(persisted).toContain("REDACTED");
    expect(persisted).not.toMatch(/sk-abcdefghijklmnop|secret-value/);
  };

  test.each([
    {
      mode: "advice" as const,
      prepare: async (value: ReturnType<typeof harness>) => {
        await value.emit("session_start", { type: "session_start" });
        await value.emit("turn_end", finalTurn("candidate"));
        await tick();
        const current = value.runtimes[0]!;
        current.pending[0]!.resolve(pass(current.requests[0]!));
        await tick();
        await value.commands.get("advisor")!.handler("review-last", value.ctx as never);
        await tick();
        const manualIndex = current.requests.length - 1;
        current.pending[manualIndex]!.resolve(
          revise(current.requests[manualIndex]!, "concern", "manual label issue"),
        );
        await tick();
      },
    },
    {
      mode: "correction" as const,
      prepare: async (value: ReturnType<typeof harness>) => {
        (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
        await value.emit("session_start", { type: "session_start" });
        await value.emit("turn_end", finalTurn("candidate"));
        await tick();
        const current = value.runtimes[0]!;
        current.pending[0]!.resolve(
          revise(current.requests[0]!, "concern", "correction label issue"),
        );
        await tick();
      },
    },
  ])(
    "redacts and clips provider/model labels in $mode message details",
    async ({ mode, prepare }) => {
      const value = harness({
        provider: "provider-api_key=sk-abcdefghijklmnop",
        model: `model-token=secret-value-${"x".repeat(400)}`,
        ...(mode === "correction" ? { reviewPolicy: "corrective" as const } : {}),
      });
      await prepare(value);
      expectRedactedLabels(value);
    },
  );

  test("idle automatic direct drop rolls back emission and dedupe across manual review and restore", async () => {
    const value = harness({ reviewPolicy: "guardrail" });
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(revise(current.requests[0]!, "concern", "idle rollback issue"));
    await tick();

    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(value.appended.at(-1)).toMatchObject({
      routing: { interventionBudget: { delivered: 0, correctionUsed: false } },
      emissionHashes: [],
    });
    const branchAfterDrop = structuredClone(value.branch);

    await value.commands.get("advisor")!.handler("review-last", value.ctx as never);
    await tick();
    current.pending[1]!.resolve(revise(current.requests[1]!, "concern", "idle rollback issue"));
    await tick();
    expect(value.sendMessage).toHaveBeenCalledOnce();

    const restored = harness({ reviewPolicy: "guardrail" }, { branch: branchAfterDrop });
    (restored.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await restored.emit("session_start", { type: "session_start" });
    await restored.emit("turn_end", finalTurn("candidate"));
    await tick();
    const restoredRuntime = restored.runtimes[0]!;
    restoredRuntime.pending[0]!.resolve(
      revise(restoredRuntime.requests[0]!, "concern", "idle rollback issue"),
    );
    await tick();
    expect(restored.sendMessage).toHaveBeenCalledOnce();
  });

  test("idle corrective concerns still trigger an immediate correction", async () => {
    const value = harness({ reviewPolicy: "corrective" });
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(revise(current.requests[0]!, "concern"));
    await tick();
    expect(value.sendMessage.mock.calls[0]?.[0]?.details?.action).toBe("revision");
    expect(value.sendMessage.mock.calls[0]?.[1]?.triggerTurn === true).toBe(true);
  });

  test("direct advice steers an active parent without waiting for user input", async () => {
    const value = harness({ reviewPolicy: "guardrail" });
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(revise(current.requests[0]!, "concern"));
    await tick();

    expect(value.sendMessage.mock.lastCall?.[1]).toEqual({ deliverAs: "steer" });
  });

  test("records a causal receipt when main-agent processing continues after advice", async () => {
    const value = harness({ reviewPolicy: "guardrail" });
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(revise(current.requests[0]!, "concern"));
    await tick();
    await value.emit("turn_start", { type: "turn_start", turnIndex: 2 });
    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    const usage = String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0]);
    expect(usage).toContain("Receipts: 1 of 1 delivered interventions");
  });

  test("persists the reset intervention budget at a genuine request boundary", async () => {
    const value = harness({ reviewPolicy: "guardrail" });
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(revise(current.requests[0]!, "concern", "budgeted issue"));
    await tick();
    expect(value.appended.at(-1)).toMatchObject({
      routing: { interventionBudget: { delivered: 1 } },
    });

    await value.emit("message_end", {
      type: "message_end",
      message: { role: "user", content: "new request" },
    });
    expect(value.appended.at(-1)).toMatchObject({
      routing: { interventionBudget: { delivered: 0, correctionUsed: false } },
    });
  });

  test("aggregates causal receipts when multiple manual interventions precede processing", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("completed answer"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(pass(current.requests[0]!));
    await tick();
    await value.commands.get("advisor")!.handler("review-last", value.ctx as never);
    await tick();
    const firstManualIndex = current.requests.length - 1;
    current.pending[firstManualIndex]!.resolve(
      revise(current.requests[firstManualIndex]!, "concern", "first manual issue"),
    );
    await tick();
    await value.commands.get("advisor")!.handler("review-last", value.ctx as never);
    await tick();
    const secondManualIndex = current.requests.length - 1;
    current.pending[secondManualIndex]!.resolve(
      revise(current.requests[secondManualIndex]!, "concern", "second manual issue"),
    );
    await tick();
    await value.emit("turn_start", { type: "turn_start", turnIndex: 2 });
    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    const usage = String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0]);
    expect(usage).toContain("Receipts: 2 of 2 delivered interventions");
  });

  test("corrective concerns are dropped during three-turn immunity", async () => {
    const value = harness({ reviewPolicy: "corrective" });
    await value.emit("session_start", { type: "session_start" });
    const complete = async (index: number) => {
      await value.emit("turn_end", finalTurn(`candidate-${index}`));
      await tick();
      const current = value.runtimes[0]!;
      const requestIndex = current.requests.length - 1;
      current.pending[requestIndex]!.resolve(
        revise(current.requests[requestIndex]!, "concern", `concern-${index}`),
      );
      await tick();
    };
    for (let index = 1; index <= 5; index += 1) await complete(index);
    expect(value.sendMessage.mock.calls.map((call) => call[1])).toEqual([
      { deliverAs: "steer", triggerTurn: true },
    ]);
  });

  test("tool-loop evidence is chronological and requires an Advisor blocker before abort", async () => {
    const value = harness();
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_start", { type: "turn_start", turnIndex: 1 });
    for (let index = 0; index < 3; index += 1) {
      await value.emit("tool_execution_start", {
        type: "tool_execution_start",
        toolCallId: `call-${index}`,
        toolName: "read",
        args: { path: "src/a.ts" },
      });
      await value.emit("tool_execution_update", {
        type: "tool_execution_update",
        toolCallId: `call-${index}`,
        toolName: "read",
        partialResult: "same",
      });
      await value.emit("tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: `call-${index}`,
        toolName: "read",
        result: "same",
        isError: false,
      });
    }
    await tick();
    const current = value.runtimes[0]!;
    expect(current.requests).toHaveLength(1);
    const evidence = current.requests[0]!.observations;
    expect(evidence).toContain("trajectory_signal");
    expect(evidence.indexOf("tool_start")).toBeLessThan(evidence.indexOf("trajectory_signal"));
    expect(value.ctx.abort).not.toHaveBeenCalled();
    await resolveVerifiedBlocker(current, 0);
    expect(value.ctx.abort).toHaveBeenCalledOnce();
  });

  test("routes a second queued blocker as aborting until the first recovery settles", async () => {
    const value = harness();
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate for review-last"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(pass(current.requests[0]!));
    await tick();
    value.appended.length = 0;
    await value.emit("turn_start", { type: "turn_start", turnIndex: 2 });
    await emitToolLoop(value, "queued-loop");
    await value.commands.get("advisor")!.handler("review-last", value.ctx as never);
    await tick();

    current.pending[1]!.resolve(revise(current.requests[1]!, "blocker", "loop blocker"));
    await tick();
    current.pending[2]!.resolve(revise(current.requests[2]!, "blocker", "second blocker"));
    await tick();
    expect(current.requests[3]?.focus).toBe("blocker-verification");
    current.pending[3]!.resolve(revise(current.requests[3]!, "blocker", "loop blocker"));
    await tick();
    expect(value.ctx.abort).toHaveBeenCalledOnce();

    expect(value.ctx.abort).toHaveBeenCalledOnce();
    expect(value.sendMessage.mock.lastCall?.[1]).toEqual({ deliverAs: "steer" });
    expect(value.appended).toHaveLength(2);
    expect((value.appended.at(-1) as { emissionHashes?: unknown[] }).emissionHashes).toHaveLength(
      1,
    );
  });

  test("materially novel terminal tool evidence invalidates a queued loop blocker", async () => {
    const value = harness();
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_start", { type: "turn_start", turnIndex: 1 });
    await emitToolLoop(value, "old-loop");
    await tick();
    const current = value.runtimes[0]!;

    await value.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "novel",
      toolName: "read",
      args: { path: "src/new.ts" },
    });
    await value.emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "novel",
      toolName: "read",
      result: "materially new terminal evidence",
      isError: false,
    });
    await resolveVerifiedBlocker(current, 0);

    expect(value.ctx.abort).not.toHaveBeenCalled();
    expect(value.sendMessage).toHaveBeenCalledWith(expect.anything(), { deliverAs: "steer" });
  });

  test("a suppressed recovery releases delivery capacity but preserves the correction-attempt latch", async () => {
    const value = harness();
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("unrelated candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(
      revise(current.requests[0]!, "concern", "unrelated delivered history"),
    );
    await tick();
    expect(value.sendMessage).toHaveBeenCalledOnce();

    await value.emit("turn_start", { type: "turn_start", turnIndex: 1 });
    await emitToolLoop(value, "suppressed-one");
    await tick();
    await resolveVerifiedBlocker(current, 1, "repeatable blocker");
    expect(value.appended).toHaveLength(2);
    expect(value.appended.at(-1)).toMatchObject({
      routing: { interventionBudget: { delivered: 1, correctionUsed: true } },
    });
    expect((value.appended.at(-1) as { emissionHashes?: unknown[] }).emissionHashes).toHaveLength(
      1,
    );

    await value.emit("turn_end", {
      ...finalTurn(""),
      turnIndex: 1,
      message: { role: "assistant", content: [], stopReason: "aborted" },
    });
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (value.ctx.hasPendingMessages as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await value.emit("agent_settled", { type: "agent_settled" });
    expect(value.appended).toHaveLength(2);
    expect(value.sendMessage).toHaveBeenCalledOnce();

    await value.commands.get("advisor")!.handler("review-last", value.ctx as never);
    await tick();
    const manualDuplicate = current.requests.length - 1;
    current.pending[manualDuplicate]!.resolve(
      revise(current.requests[manualDuplicate]!, "concern", "unrelated delivered history"),
    );
    await tick();
    expect(value.sendMessage).toHaveBeenCalledOnce();

    (value.ctx.hasPendingMessages as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("turn_start", { type: "turn_start", turnIndex: 2 });
    await emitToolLoop(value, "suppressed-two");
    await tick();
    await resolveVerifiedBlocker(current, current.requests.length - 1, "repeatable blocker");
    expect(value.ctx.abort).toHaveBeenCalledOnce();
    expect(value.sendMessage).toHaveBeenCalledWith(expect.anything(), { deliverAs: "steer" });
  });

  test("persists a correction attempt across restart without consuming undelivered capacity", async () => {
    const first = harness();
    (first.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await first.emit("session_start", { type: "session_start" });
    await first.emit("turn_start", { type: "turn_start", turnIndex: 1 });
    await emitToolLoop(first, "restart-attempt-one");
    await tick();
    const initial = first.runtimes[0]!;
    await resolveVerifiedBlocker(initial, 0, "restart blocker");
    expect(first.ctx.abort).toHaveBeenCalledOnce();
    expect(first.appended.at(-1)).toMatchObject({
      routing: { interventionBudget: { delivered: 0, correctionUsed: true } },
    });

    const second = harness({}, { branch: first.branch });
    (second.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await second.emit("session_start", { type: "session_start" });
    await second.emit("turn_start", { type: "turn_start", turnIndex: 2 });
    await emitToolLoop(second, "restart-attempt-two");
    await tick();
    const restored = second.runtimes[0]!;
    await resolveVerifiedBlocker(restored, 0, "restart blocker");

    expect(second.ctx.abort).not.toHaveBeenCalled();
    expect(second.sendMessage).toHaveBeenCalledWith(expect.anything(), { deliverAs: "steer" });
  });

  test("keeps lifecycle identity stable across restart without a session ID", async () => {
    const first = harness({ reviewPolicy: "guardrail" }, { withoutSessionId: true });
    (first.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await first.emit("session_start", { type: "session_start" });
    await first.emit("turn_end", finalTurn("first candidate"));
    await tick();
    const initial = first.runtimes[0]!;
    initial.pending[0]!.resolve(revise(initial.requests[0]!, "concern", "stable fallback issue"));
    await tick();
    const firstLedger = first.appended.at(-1) as {
      findingLifecycle: Array<{ id: string; status: string }>;
    };
    const findingId = firstLedger.findingLifecycle[0]!.id;
    for (const entry of first.branch) {
      if (entry.type === "custom" && typeof entry.data === "object" && entry.data) {
        (entry.data as { emissionHashes?: string[] }).emissionHashes = [];
      }
    }

    const second = harness(
      { reviewPolicy: "guardrail" },
      {
        branch: first.branch,
        withoutSessionId: true,
      },
    );
    await second.emit("session_start", { type: "session_start" });
    await second.emit("turn_end", finalTurn("second candidate"));
    await tick();
    const restored = second.runtimes[0]!;
    restored.pending[0]!.resolve(revise(restored.requests[0]!, "concern", "stable fallback issue"));
    await tick();

    expect(second.sendMessage).not.toHaveBeenCalled();
    expect(second.appended.at(-1)).toMatchObject({
      findingLifecycle: [expect.objectContaining({ id: findingId, status: "acknowledged" })],
    });
  });

  test("stale advisor abort provenance cannot consume a later unrelated aborted turn", async () => {
    const value = harness();
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_start", { type: "turn_start", turnIndex: 1 });
    await emitToolLoop(value, "stale-one");
    await tick();
    const current = value.runtimes[0]!;
    await resolveVerifiedBlocker(current, 0, "stale blocker");
    expect(value.ctx.abort).toHaveBeenCalledOnce();

    await value.emit("message_end", {
      type: "message_end",
      message: { role: "user", content: "new genuine work" },
    });
    await value.emit("turn_end", {
      ...finalTurn(""),
      turnIndex: 1,
      message: { role: "assistant", content: [], stopReason: "aborted" },
    });
    await value.emit("turn_start", { type: "turn_start", turnIndex: 2 });
    await emitToolLoop(value, "stale-two");
    await tick();
    await resolveVerifiedBlocker(current, 2, "fresh blocker");

    expect(value.ctx.abort).toHaveBeenCalledOnce();
    expect(value.sendMessage).not.toHaveBeenCalled();
  });

  test("disabled supervision skips automatic checkpoints but once reviews the next final turn", async () => {
    const value = harness({ enabled: false });
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("automatic"));
    await tick();
    expect(value.runtimes).toHaveLength(0);
    await value.commands.get("advisor")!.handler("once", value.ctx as never);
    await value.emit("turn_end", finalTurn("requested"));
    await tick();
    expect(value.runtimes[0]?.requests).toHaveLength(1);
  });

  test("disabled explicit reviews survive cursor invalidation", async () => {
    const value = harness({ enabled: false });
    const command = value.commands.get("advisor")!;
    await value.emit("session_start", { type: "session_start" });
    await command.handler("once", value.ctx as never);
    await value.emit("turn_end", finalTurn("first explicit review"));
    await tick();
    const first = value.runtimes[0]!;
    first.pending[0]!.resolve(pass(first.requests[0]!));
    await tick();

    (value.ctx.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: "replacement",
        type: "message",
        parentId: null,
        timestamp: "now",
        message: { role: "user", content: "replacement" },
      },
    ]);
    await command.handler("once", value.ctx as never);
    await value.emit("turn_end", finalTurn("explicit review after replacement"));
    await tick();

    expect(value.runtimes).toHaveLength(2);
    expect(first.driver.dispose).toHaveBeenCalled();
    expect(value.runtimes[1]?.requests).toHaveLength(1);
    value.runtimes[1]!.pending[0]!.resolve(pass(value.runtimes[1]!.requests[0]!));
    await tick();
    expect(value.appended).toHaveLength(2);
  });

  test.each([
    ["advisory", "blocker"],
    ["guardrail", "concern"],
  ] as const)(
    "/advisor once pushes %s policy advice directly for %s findings",
    async (reviewPolicy, severity) => {
      const value = harness({ enabled: false, reviewPolicy });
      await value.emit("session_start", { type: "session_start" });
      await value.commands.get("advisor")!.handler("once", value.ctx as never);
      await value.emit("turn_end", finalTurn("requested"));
      await tick();
      const current = value.runtimes[0]!;
      current.pending[0]!.resolve(revise(current.requests[0]!, severity));
      await tick();

      expect(value.sendMessage).toHaveBeenCalledOnce();
      expect(value.sendMessage.mock.calls[0]?.[0]?.details?.action).toBe("advice");
      expect(value.sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "steer" });
      expect(value.ctx.abort).not.toHaveBeenCalled();
    },
  );

  test("/advisor once bypasses automatic intervention budget without consuming it", async () => {
    const value = harness({ reviewPolicy: "guardrail" });
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("automatic candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(revise(current.requests[0]!, "concern", "automatic concern"));
    await tick();
    expect(value.sendMessage).toHaveBeenCalledOnce();

    await value.commands.get("advisor")!.handler("once", value.ctx as never);
    await value.emit("turn_end", finalTurn("manual candidate"));
    await tick();
    current.pending[1]!.resolve(revise(current.requests[1]!, "concern", "manual concern"));
    await tick();
    expect(value.sendMessage).toHaveBeenCalledTimes(2);

    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    const usage = String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0]);
    expect(usage).toContain("Intervention budget: 1/2 delivered");
  });

  test("manual review-last and verify-last push direct advice for blockers", async () => {
    const value = harness({ reviewPolicy: "corrective" });
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(pass(current.requests[0]!));
    await tick();

    const command = value.commands.get("advisor")!;
    await command.handler("review-last", value.ctx as never);
    await tick();
    current.pending[1]!.resolve(revise(current.requests[1]!, "blocker", "historical issue"));
    await tick();
    await command.handler("verify-last", value.ctx as never);
    await tick();
    current.pending[2]!.resolve(revise(current.requests[2]!, "blocker", "verification issue"));
    await tick();

    expect(value.sendMessage.mock.calls.slice(-2).map((call) => call[1])).toEqual([
      { deliverAs: "steer" },
      { deliverAs: "steer" },
    ]);
    expect(value.ctx.abort).not.toHaveBeenCalled();
  });

  test("review-last and verify-last preserve their requested focus", async () => {
    const value = harness({ enabled: false });
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    const command = value.commands.get("advisor")!;
    await command.handler("review-last", value.ctx as never);
    await tick();
    const current = value.runtimes[0]!;
    expect(current.requests[0]?.focus).toBe("standard");
    current.pending[0]!.resolve(pass(current.requests[0]!));
    await tick();
    await command.handler("verify-last", value.ctx as never);
    await tick();
    expect(current.requests[1]?.focus).toBe("verification");
  });

  test.each(["aborted", "error", "length"] as const)(
    "skips incomplete %s turns",
    async (stopReason) => {
      const value = harness();
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", {
        ...finalTurn("incomplete"),
        message: { ...finalTurn("incomplete").message, stopReason },
      });
      await tick();
      expect(value.runtimes[0]?.requests).toHaveLength(0);
    },
  );

  test("disabled review does not start child work or review turns", async () => {
    const value = harness({ enabled: false });
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    expect(value.runtimes).toHaveLength(0);
  });

  test("queued user input still runs mandatory catch-up but suppresses stale delivery", async () => {
    const value = harness();
    (value.ctx.hasPendingMessages as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("obsolete"));
    await tick();
    const current = value.runtimes[0]!;
    expect(current.requests).toHaveLength(1);
    current.pending[0]!.resolve(revise(current.requests[0]!));
    await tick();
    expect(value.sendMessage).not.toHaveBeenCalled();
  });

  test("warns for unconfigured sessions and does not create a child runtime", async () => {
    const value = harness({ provider: undefined, model: undefined, configured: false });
    await value.emit("session_start", { type: "session_start" });
    expect(value.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("/advisor-settings"),
      "warning",
    );
    expect(value.runtimes).toHaveLength(0);
  });

  test("successful pass checkpoints remain silent while persisting compact state", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(pass(current.requests[0]!));
    await tick();
    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(value.appended).toHaveLength(1);
  });

  test("never copies model-authored checkpoint state into the durable ledger", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve({
      ...pass(current.requests[0]!),
      stateSummary: "COPIED_TRANSCRIPT_73af private thinking /secret/file sk-abcdefghijklmnop",
      summary: "COPIED_TRANSCRIPT_73af",
    });
    await tick();

    expect(JSON.stringify(value.appended[0])).not.toMatch(
      /COPIED_TRANSCRIPT_73af|private thinking|secret\/file|sk-abcdefghijklmnop/,
    );
    expect(value.appended[0]).toMatchObject({
      reviewSummary: { verdict: "pass" },
    });
  });

  test("cancel after a persisted ledger preserves the live cancellation latch across restart", async () => {
    const value = harness({ reviewPolicy: "corrective" });
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("persisted candidate"));
    await tick();
    const first = value.runtimes[0]!;
    first.pending[0]!.resolve(revise(first.requests[0]!, "concern", "persisted concern"));
    await tick();
    expect(value.appended).toHaveLength(1);

    await value.commands.get("advisor")!.handler("cancel", value.ctx as never);
    await tick();
    await value.commands.get("advisor")!.handler("review-last", value.ctx as never);
    await tick();
    const restarted = value.runtimes.at(-1)!;
    restarted.pending[0]!.resolve(revise(restarted.requests[0]!, "blocker", "new blocker"));
    await tick();

    expect(value.sendMessage.mock.lastCall?.[1]).toEqual({ deliverAs: "steer" });
  });

  test("pause invalidates an in-flight checkpoint before it can deliver", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    await value.commands.get("advisor")!.handler("pause", value.ctx as never);
    current.pending[0]!.resolve(revise(current.requests[0]!));
    await tick();
    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(value.appended).toHaveLength(1);
    expect(value.appended[0]).toMatchObject({
      routing: { cancellationLatched: true },
    });
  });

  test.each(["command", "dashboard", "settings"] as const)(
    "%s enablement toggle shares lifecycle ownership and clears the session pause",
    async (entryPoint) => {
      const directory = mkdtempSync(join(tmpdir(), `pi-advisor-${entryPoint}-toggle-`));
      try {
        const configPath = join(directory, "extensions", "pi-advisor.json");
        const value = harness({ configPath });
        await value.emit("session_start", { type: "session_start" });
        const command = value.commands.get("advisor")!;
        await command.handler("pause", value.ctx as never);

        const select = value.ctx.ui.select as ReturnType<typeof vi.fn>;
        if (entryPoint === "command") {
          await command.handler("off", value.ctx as never);
        } else if (entryPoint === "dashboard") {
          select.mockResolvedValueOnce("Turn automatic review off");
          await command.handler("", value.ctx as never);
        } else {
          select.mockResolvedValueOnce("Advisor supervision: on").mockResolvedValueOnce("Done");
          await command.handler("settings", value.ctx as never);
        }
        await tick();

        const notify = value.ctx.ui.notify as ReturnType<typeof vi.fn>;
        notify.mockClear();
        await command.handler("status", value.ctx as never);
        expect(notify).toHaveBeenLastCalledWith(
          expect.stringMatching(/Advisor: off[\s\S]*Session: idle/),
          "info",
        );
        expect(value.appended).toHaveLength(2);
        expect(value.appended.at(-1)).toMatchObject({
          routing: { cancellationLatched: true },
        });
        expect(value.runtimes).toHaveLength(1);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test("config updates clear pending recovery before resetting the request budget", async () => {
    const value = harness();
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_start", { type: "turn_start", turnIndex: 1 });
    await emitToolLoop(value, "config-recovery");
    await tick();
    await resolveVerifiedBlocker(value.runtimes[0]!, 0, "pending config recovery");
    expect(value.ctx.abort).toHaveBeenCalledOnce();

    await value.commands.get("advisor")!.handler("off", value.ctx as never);
    await tick();
    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    expect(String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0])).toContain(
      "Intervention budget: 0/2 delivered · correction available",
    );
  });

  test("policy updates persist reset lifecycle and emission state", async () => {
    const value = harness({ reviewPolicy: "guardrail" });
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(revise(current.requests[0]!, "concern", "policy reset issue"));
    await tick();
    expect(value.sendMessage).toHaveBeenCalledOnce();

    const select = value.ctx.ui.select as ReturnType<typeof vi.fn>;
    select
      .mockResolvedValueOnce("Behavior: Guardrail")
      .mockResolvedValueOnce("Advisory")
      .mockResolvedValueOnce("Done");
    await value.commands.get("advisor")!.handler("settings", value.ctx as never);
    await tick();
    expect(value.appended.at(-1)).toMatchObject({
      findingLifecycle: [],
      emissionHashes: [],
      routing: { interventionBudget: { delivered: 0, correctionUsed: false } },
    });
  });

  test("off persists the cancellation latch before stopping automatic review", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-advisor-off-"));
    try {
      const configPath = join(directory, "extensions", "pi-advisor.json");
      mkdirSync(join(directory, "extensions"), { recursive: true });
      const value = harness({ configPath });
      await value.emit("session_start", { type: "session_start" });
      await value.commands.get("advisor")!.handler("off", value.ctx as never);

      expect(value.appended.length).toBeGreaterThan(0);
      expect(value.appended.at(-1)).toMatchObject({
        findingLifecycle: [],
        emissionHashes: [],
        routing: {
          cancellationLatched: true,
          interventionBudget: { delivered: 0, correctionUsed: false },
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports startup authentication failure without blocking the parent lifecycle", async () => {
    const value = harness({}, { runtimeStartError: new Error("authentication unavailable") });
    await value.emit("session_start", { type: "session_start" });
    expect(value.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("authentication failure"),
      "warning",
    );
    expect(value.ctx.abort).not.toHaveBeenCalled();
    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    expect(String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0])).toContain(
      "Discarded: 0 · failures 1",
    );
  });

  test("passes trusted guidance into the child lifecycle and accumulates usage telemetry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-advisor-lifecycle-"));
    try {
      const agentDirectory = join(directory, "agent");
      const configPath = join(agentDirectory, "extensions", "pi-advisor.json");
      mkdirSync(agentDirectory, { recursive: true });
      writeFileSync(join(agentDirectory, "ADVISOR.md"), "Watch durable queue invariants.", "utf8");
      const value = harness({ configPath });
      await value.emit("session_start", { type: "session_start" });
      const startOptions = (value.runtimes[0]!.driver.start as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as AdvisorRuntimeStartOptions | undefined;
      expect(startOptions?.instructions).toContain("Watch durable queue invariants.");
      startOptions?.onUsage?.({
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        cost: 0.125,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 22,
      });
      await value.commands.get("advisor-status")!.handler("--verbose", value.ctx as never);
      const status = String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0]);
      expect(status).toContain("input 10, output 5, cache read 3, cache write 4, total 22");
      expect(status).toContain(join(agentDirectory, "ADVISOR.md"));

      await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
      const usage = String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0]);
      expect(usage).toContain("Model responses: 1");
      expect(usage).toContain("Input:        10");
      expect(usage).toContain("Reported cost: $0.125000");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("logs checkpoint failures and emits a rate-limited warning", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    value.runtimes[0]!.pending[0]!.reject(new Error("provider failure"));
    await tick();
    expect(value.logFailure).toHaveBeenCalledOnce();
    expect(value.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("keeping the primary response"),
      "warning",
    );

    await value.emit("turn_end", finalTurn("second candidate"));
    await tick();
    value.runtimes[0]!.pending[1]!.reject(new Error("provider failed again"));
    await tick();
    const failureWarnings = (value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([message, level]) =>
        level === "warning" && String(message).includes("keeping the primary response"),
    );
    expect(failureWarnings).toHaveLength(1);
    expect(value.logFailure).toHaveBeenCalledTimes(2);
  });

  test("shows the model and effective effort in the delayed animated status", async () => {
    vi.useFakeTimers();
    try {
      const value = harness();
      (value.ctx.modelRegistry.find as ReturnType<typeof vi.fn>).mockReturnValue({
        provider: "p",
        id: "m",
        reasoning: false,
      });
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", finalTurn("candidate"));
      await vi.advanceTimersByTimeAsync(0);
      const current = value.runtimes[0]!;
      const setStatus = value.ctx.ui.setStatus as ReturnType<typeof vi.fn>;
      const reviewStatuses = () =>
        setStatus.mock.calls
          .map((call) => call[1])
          .filter((text): text is string => typeof text === "string" && text.includes("advising"));

      expect(current.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(199);
      expect(reviewStatuses()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      const firstFrame = reviewStatuses().at(-1);
      expect(firstFrame).toMatch(/^⠋ m:off advising…$/);

      await vi.advanceTimersByTimeAsync(120);
      expect(reviewStatuses().at(-1)).not.toBe(firstFrame);

      current.pending[0]!.resolve(pass(current.requests[0]!));
      await vi.advanceTimersByTimeAsync(0);
      expect(setStatus).toHaveBeenLastCalledWith("pi-advisor", undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  test("redacts model secrets in the delayed spinner label", async () => {
    vi.useFakeTimers();
    try {
      const value = harness({ model: "reviewer-token=secret-value" });
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", finalTurn("candidate"));
      await vi.advanceTimersByTimeAsync(200);
      const statuses = (value.ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
        String(call[1]),
      );
      expect(
        statuses.some((status) => status.includes("REDACTED") && status.includes("advising")),
      ).toBe(true);
      expect(statuses.join("\n")).not.toContain("secret-value");
      value.runtimes[0]!.pending[0]!.resolve(pass(value.runtimes[0]!.requests[0]!));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not show a late spinner when a checkpoint settles within the delay", async () => {
    vi.useFakeTimers();
    try {
      const value = harness();
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", finalTurn("candidate"));
      await vi.advanceTimersByTimeAsync(0);
      const current = value.runtimes[0]!;
      const setStatus = value.ctx.ui.setStatus as ReturnType<typeof vi.fn>;

      current.pending[0]!.resolve(pass(current.requests[0]!));
      await vi.advanceTimersByTimeAsync(500);
      expect(setStatus.mock.calls.some((call) => String(call[1]).includes("advising"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a completed checkpoint cannot clear the next queued checkpoint spinner", async () => {
    vi.useFakeTimers();
    try {
      const value = harness();
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", finalTurn("candidate"));
      await vi.advanceTimersByTimeAsync(0);
      const current = value.runtimes[0]!;
      await value.commands.get("advisor")!.handler("review-last", value.ctx as never);
      await vi.advanceTimersByTimeAsync(200);

      const setStatus = value.ctx.ui.setStatus as ReturnType<typeof vi.fn>;
      setStatus.mockClear();
      current.pending[0]!.resolve(revise(current.requests[0]!, "concern", "first review"));
      await vi.advanceTimersByTimeAsync(0);
      expect(current.requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(setStatus).toHaveBeenCalledWith(
        "pi-advisor",
        expect.stringMatching(/^⠋ m:medium advising…$/),
      );

      current.pending[1]!.resolve(pass(current.requests[1]!));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("delayed recovery cannot clear a newer checkpoint spinner", async () => {
    vi.useFakeTimers();
    try {
      const value = harness();
      (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", finalTurn("completed candidate"));
      await vi.advanceTimersByTimeAsync(0);
      const current = value.runtimes[0]!;
      current.pending[0]!.resolve(pass(current.requests[0]!));
      await vi.advanceTimersByTimeAsync(0);

      await value.emit("turn_start", { type: "turn_start", turnIndex: 2 });
      await value.emit("message_update", {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "repeat-this-unit".repeat(12),
        },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      current.pending[1]!.resolve(revise(current.requests[1]!));
      await vi.advanceTimersByTimeAsync(0);
      expect(current.requests[2]?.focus).toBe("blocker-verification");
      current.pending[2]!.resolve(revise(current.requests[2]!));
      await vi.advanceTimersByTimeAsync(0);
      expect(value.ctx.abort).toHaveBeenCalledOnce();

      await value.emit("turn_end", {
        ...finalTurn(""),
        turnIndex: 2,
        message: { role: "assistant", content: [], stopReason: "aborted" },
      });
      await value.commands.get("advisor")!.handler("review-last", value.ctx as never);
      await vi.advanceTimersByTimeAsync(200);
      const setStatus = value.ctx.ui.setStatus as ReturnType<typeof vi.fn>;
      expect(setStatus).toHaveBeenLastCalledWith(
        "pi-advisor",
        expect.stringMatching(/^⠋ m:medium advising…$/),
      );

      setStatus.mockClear();
      (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(true);
      await value.emit("agent_settled", { type: "agent_settled" });
      expect(setStatus).not.toHaveBeenCalled();

      current.pending[2]!.resolve(pass(current.requests[2]!));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("new sessions ignore late callbacks without clearing current spinner", async () => {
    vi.useFakeTimers();
    try {
      const value = harness();
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", finalTurn("old candidate"));
      await vi.advanceTimersByTimeAsync(0);
      const old = value.runtimes[0]!;
      const oldStart = (old.driver.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | AdvisorRuntimeStartOptions
        | undefined;

      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", finalTurn("new candidate"));
      await vi.advanceTimersByTimeAsync(200);
      const current = value.runtimes.at(-1)!;
      const setStatus = value.ctx.ui.setStatus as ReturnType<typeof vi.fn>;
      expect(setStatus).toHaveBeenLastCalledWith(
        "pi-advisor",
        expect.stringMatching(/^⠋ m:medium advising…$/),
      );

      setStatus.mockClear();
      oldStart?.onUsage?.({
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        cost: 0.5,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 22,
      });
      old.pending[0]!.reject(new Error("late old-session failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(setStatus).not.toHaveBeenCalledWith("pi-advisor", undefined);

      await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
      const usage = String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0]);
      expect(usage).toContain("Model responses: 0");
      expect(usage).toContain("Reviews: 1 attempted · 0 settled · 1 in progress");
      expect(usage).toContain("Discarded: 0 · failures 0");

      current.pending[0]!.resolve(pass(current.requests[0]!));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a session reset discards a request awaiting cursor restart", async () => {
    const restart = deferred<void>();
    const value = harness({}, { runtimeStartPromises: [undefined, restart.promise, undefined] });
    await value.emit("session_start", { type: "session_start" });
    value.branch.splice(0, value.branch.length, {
      id: "new-anchor",
      type: "message",
      parentId: null,
      timestamp: "later",
      message: { role: "user", content: "new branch" },
    });

    await value.emit("turn_end", finalTurn("stale candidate"));
    await tick();
    expect(value.runtimes).toHaveLength(2);
    await value.emit("session_start", { type: "session_start" });
    expect(value.runtimes).toHaveLength(3);

    restart.resolve();
    await tick();
    const current = value.runtimes[2]!;
    expect(current.requests).toHaveLength(0);
    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    expect(String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0])).toContain(
      "Reviews: 0 attempted · 0 settled · 0 in progress",
    );

    await value.emit("turn_end", finalTurn("current candidate"));
    await tick();
    expect(current.requests).toHaveLength(1);
    current.pending[0]!.resolve(pass(current.requests[0]!));
    await tick();
  });

  test("a tree restart discards a request awaiting an older cursor restart", async () => {
    const restart = deferred<void>();
    const value = harness({}, { runtimeStartPromises: [undefined, restart.promise, undefined] });
    await value.emit("session_start", { type: "session_start" });
    value.branch.splice(0, value.branch.length, {
      id: "new-anchor",
      type: "message",
      parentId: null,
      timestamp: "later",
      message: { role: "user", content: "new branch" },
    });

    await value.emit("turn_end", finalTurn("stale candidate"));
    await tick();
    expect(value.runtimes).toHaveLength(2);
    await value.emit("session_tree", { type: "session_tree" });
    expect(value.runtimes).toHaveLength(3);

    restart.resolve();
    await tick();
    expect(value.runtimes[2]!.requests).toHaveLength(0);
    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    expect(String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0])).toContain(
      "Reviews: 0 attempted · 0 settled · 0 in progress",
    );
  });

  test("invalidated trajectory does not submit after a cursor restart", async () => {
    const restart = deferred<void>();
    const value = harness({}, { runtimeStartPromises: [undefined, restart.promise] });
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_start", { type: "turn_start", turnIndex: 1 });
    value.branch.splice(0, value.branch.length, {
      id: "new-anchor",
      type: "message",
      parentId: null,
      timestamp: "now",
      message: { role: "user", content: "new branch" },
    });

    await emitToolLoop(value, "restart-invalidates-trajectory");
    await tick();
    expect(value.runtimes).toHaveLength(2);
    restart.resolve();
    await tick();

    expect(value.runtimes[1]!.requests).toHaveLength(0);
    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    expect(String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0])).toContain(
      "Reviews: 0 attempted · 0 settled · 0 in progress",
    );
  });

  test("review-last startup cannot cross into a new session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-advisor-review-last-race-"));
    try {
      const configPath = join(directory, "pi-advisor.json");
      writeFileSync(configPath, JSON.stringify({ enabled: true, provider: "p", model: "m" }));
      const restart = deferred<void>();
      const value = harness(
        { configPath },
        { runtimeStartPromises: [undefined, restart.promise, undefined] },
      );
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", finalTurn("candidate"));
      await tick();
      const initial = value.runtimes[0]!;
      initial.pending[0]!.resolve(pass(initial.requests[0]!));
      await tick();
      const command = value.commands.get("advisor")!;
      await command.handler("off", value.ctx as never);
      await tick();

      const notify = value.ctx.ui.notify as ReturnType<typeof vi.fn>;
      notify.mockClear();
      const review = command.handler("review-last", value.ctx as never);
      await tick();
      expect(value.runtimes).toHaveLength(2);
      await value.emit("session_start", { type: "session_start" });
      expect(value.runtimes).toHaveLength(3);
      restart.resolve();
      await expect(review).resolves.toBeUndefined();
      await tick();
      expect(value.runtimes[2]!.requests).toHaveLength(0);
      expect(notify).not.toHaveBeenCalledWith(
        "No completed response is available to review.",
        "warning",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("review-last startup cannot cross a tree restart", async () => {
    const restart = deferred<void>();
    const value = harness({}, { runtimeStartPromises: [undefined, restart.promise, undefined] });
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const initial = value.runtimes[0]!;
    initial.pending[0]!.resolve(pass(initial.requests[0]!));
    await tick();
    await value.emit("session_shutdown", { type: "session_shutdown" });
    const command = value.commands.get("advisor")!;
    const notify = value.ctx.ui.notify as ReturnType<typeof vi.fn>;
    notify.mockClear();

    const review = command.handler("review-last", value.ctx as never);
    await tick();
    expect(value.runtimes).toHaveLength(2);
    await value.emit("session_tree", { type: "session_tree" });
    expect(value.runtimes).toHaveLength(3);
    restart.resolve();
    await review;
    await tick();

    expect(value.runtimes[2]!.requests).toHaveLength(0);
    expect(notify).not.toHaveBeenCalledWith(
      "No completed response is available to review.",
      "warning",
    );
  });

  test("once startup cannot cross into a new session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-advisor-once-race-"));
    try {
      const configPath = join(directory, "pi-advisor.json");
      writeFileSync(configPath, JSON.stringify({ enabled: true, provider: "p", model: "m" }));
      const restart = deferred<void>();
      const value = harness(
        { configPath },
        { runtimeStartPromises: [undefined, restart.promise, undefined] },
      );
      await value.emit("session_start", { type: "session_start" });
      const command = value.commands.get("advisor")!;
      await command.handler("off", value.ctx as never);
      await tick();
      await command.handler("once", value.ctx as never);

      const turn = value.emitAwait("turn_end", finalTurn("stale once candidate"));
      await tick();
      expect(value.runtimes).toHaveLength(2);
      await value.emit("session_start", { type: "session_start" });
      expect(value.runtimes).toHaveLength(3);
      restart.resolve();
      await turn;
      await tick();
      expect(value.runtimes[2]!.requests).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("once startup cannot cross a tree restart", async () => {
    const restart = deferred<void>();
    const value = harness({}, { runtimeStartPromises: [undefined, restart.promise, undefined] });
    await value.emit("session_start", { type: "session_start" });
    await value.emit("session_shutdown", { type: "session_shutdown" });
    const command = value.commands.get("advisor")!;
    await command.handler("once", value.ctx as never);

    const turn = value.emitAwait("turn_end", finalTurn("stale once candidate"));
    await tick();
    expect(value.runtimes).toHaveLength(2);
    await value.emit("session_tree", { type: "session_tree" });
    expect(value.runtimes).toHaveLength(3);

    restart.resolve();
    await turn;
    await tick();
    expect(value.runtimes[2]!.requests).toHaveLength(0);
  });

  test("cancel stops once while its runtime is starting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-advisor-once-cancel-"));
    try {
      const configPath = join(directory, "pi-advisor.json");
      writeFileSync(configPath, JSON.stringify({ enabled: true, provider: "p", model: "m" }));
      const restart = deferred<void>();
      const value = harness({ configPath }, { runtimeStartPromises: [undefined, restart.promise] });
      await value.emit("session_start", { type: "session_start" });
      const command = value.commands.get("advisor")!;
      await command.handler("off", value.ctx as never);
      await tick();
      await command.handler("once", value.ctx as never);
      const turn = value.emitAwait("turn_end", finalTurn("cancelled once candidate"));
      await tick();
      expect(value.runtimes).toHaveLength(2);
      const notify = value.ctx.ui.notify as ReturnType<typeof vi.fn>;
      notify.mockClear();

      await command.handler("cancel", value.ctx as never);
      expect(notify).toHaveBeenLastCalledWith("Cancelled pending advisor work.", "info");
      restart.resolve();
      await turn;
      await tick();
      expect(value.runtimes[1]!.requests).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cancel stops review-last while its runtime is starting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-advisor-review-last-cancel-"));
    try {
      const configPath = join(directory, "pi-advisor.json");
      writeFileSync(configPath, JSON.stringify({ enabled: true, provider: "p", model: "m" }));
      const restart = deferred<void>();
      const value = harness({ configPath }, { runtimeStartPromises: [undefined, restart.promise] });
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_end", finalTurn("candidate"));
      await tick();
      const initial = value.runtimes[0]!;
      initial.pending[0]!.resolve(pass(initial.requests[0]!));
      await tick();
      const command = value.commands.get("advisor")!;
      await command.handler("off", value.ctx as never);
      await tick();

      const review = command.handler("review-last", value.ctx as never);
      await tick();
      expect(value.runtimes).toHaveLength(2);
      const notify = value.ctx.ui.notify as ReturnType<typeof vi.fn>;
      notify.mockClear();
      await command.handler("cancel", value.ctx as never);
      expect(notify).toHaveBeenLastCalledWith("Cancelled pending advisor work.", "info");

      restart.resolve();
      await review;
      await tick();
      expect(value.runtimes[1]!.requests).toHaveLength(0);
      expect(notify).not.toHaveBeenCalledWith(
        "No completed response is available to review.",
        "warning",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cancel recognizes a requested next review before it starts", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    const command = value.commands.get("advisor")!;
    await command.handler("once", value.ctx as never);
    const notify = value.ctx.ui.notify as ReturnType<typeof vi.fn>;
    notify.mockClear();

    await command.handler("cancel", value.ctx as never);
    expect(notify).toHaveBeenLastCalledWith("Cancelled pending advisor work.", "info");
  });

  test("cancel recognizes pending recovery after its checkpoint settles", async () => {
    const value = harness();
    (value.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_start", { type: "turn_start", turnIndex: 1 });
    await emitToolLoop(value, "cancel-recovery");
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(revise(current.requests[0]!, "blocker", "pending recovery"));
    await tick();
    const command = value.commands.get("advisor")!;
    const notify = value.ctx.ui.notify as ReturnType<typeof vi.fn>;
    notify.mockClear();

    await command.handler("cancel", value.ctx as never);
    expect(notify).toHaveBeenLastCalledWith("Cancelled pending advisor work.", "info");
  });

  test("cancel recognizes an active manual review with no observation backlog", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(pass(current.requests[0]!));
    await tick();

    const command = value.commands.get("advisor")!;
    await command.handler("review-last", value.ctx as never);
    await tick();
    const notify = value.ctx.ui.notify as ReturnType<typeof vi.fn>;
    notify.mockClear();
    await command.handler("cancel", value.ctx as never);
    expect(notify).toHaveBeenLastCalledWith("Cancelled pending advisor work.", "info");
  });

  test("cancelled queued checkpoints keep attempted and settled usage coherent", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    await value.commands.get("advisor")!.handler("review-last", value.ctx as never);
    await tick();
    await value.commands.get("advisor")!.handler("cancel", value.ctx as never);
    await tick();

    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    const usage = String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0]);
    expect(usage).toContain("Reviews: 2 attempted · 2 settled · 0 in progress");
    expect(usage).toContain("Discarded: 2 · failures 0");
    await value.commands.get("advisor-status")!.handler("--verbose", value.ctx as never);
    expect(String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0])).toContain(
      "timeouts 0, failures 0",
    );
  });

  test("bounded queue eviction preserves attempted and settled accounting", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    current.pending[0]!.resolve(pass(current.requests[0]!));
    await tick();

    const command = value.commands.get("advisor")!;
    for (let index = 0; index < 18; index += 1) {
      await command.handler("review-last", value.ctx as never);
    }
    await tick();
    await command.handler("cancel", value.ctx as never);
    await tick();

    await value.commands.get("advisor-usage")!.handler("", value.ctx as never);
    const usage = String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0]);
    expect(usage).toContain("Reviews: 19 attempted · 19 settled · 0 in progress");
    expect(usage).toContain("Pass: 1 (100.0%)");
    expect(usage).toContain("Discarded: 17 · failures 1");
  });

  test("status exposes attempts, pass outcomes and bounded queue metrics", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    await value.commands.get("advisor-status")!.handler("", value.ctx as never);
    expect(String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0])).toContain(
      "Session: reviewing",
    );
    current.pending[0]!.resolve(pass(current.requests[0]!));
    await tick();
    await value.commands.get("advisor-status")!.handler("--verbose", value.ctx as never);
    const status = String((value.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.lastCall?.[0]);
    expect(status).toContain("Session review attempts: 1");
    expect(status).toContain("pass 1");
    expect(status).toContain("Sequence: processed");
    expect(status).toContain("Catch-up barrier: hard 30,000 ms cap");
    expect(status).toContain("Active Advisor tools: read, grep, find, ls");
  });

  test("cleans trajectory timers when newer user work supersedes the active turn", async () => {
    vi.useFakeTimers();
    try {
      const value = harness();
      await value.emit("session_start", { type: "session_start" });
      await value.emit("turn_start", { type: "turn_start", turnIndex: 1 });
      await value.emit("message_end", { message: { role: "user", content: "new work" } });
      await vi.advanceTimersByTimeAsync(100_000);
      expect(value.runtimes[0]?.requests).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses turn_start as the sole parent-turn increment in Pi message ordering", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("message_end", {
      type: "message_end",
      message: { role: "user", content: "ordered user" },
    });
    await value.emit("turn_start", { type: "turn_start", turnIndex: 1 });
    await value.emit("message_update", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "ordered assistant" },
    });
    await value.emit("turn_end", finalTurn("ordered final"));
    await tick();
    const observations = value.runtimes[0]!.requests[0]!.observations;
    const records = JSON.parse(observations.split("\n\n").at(-1)!) as Array<{
      type: string;
      parentTurnId: number;
    }>;

    expect(records.find((record) => record.type === "user")?.parentTurnId).toBe(0);
    expect(records.find((record) => record.type === "assistant_text_delta")?.parentTurnId).toBe(1);
    expect(records.find((record) => record.type === "assistant_final")?.parentTurnId).toBe(1);
    value.runtimes[0]!.pending[0]!.resolve(pass(value.runtimes[0]!.requests[0]!));
    await tick();
  });

  test("persists an external aborted turn cancellation across shutdown and restart", async () => {
    const first = harness({ reviewPolicy: "corrective" });
    await first.emit("session_start", { type: "session_start" });
    await first.emit("turn_end", finalTurn("baseline"));
    await tick();
    first.runtimes[0]!.pending[0]!.resolve(pass(first.runtimes[0]!.requests[0]!));
    await tick();
    await first.emit("turn_end", {
      ...finalTurn(""),
      message: { role: "assistant", content: [], stopReason: "aborted" },
    });
    expect(first.appended.at(-1)).toMatchObject({
      routing: { cancellationLatched: true },
    });
    await first.emit("session_shutdown", { type: "session_shutdown" });

    const second = harness({ reviewPolicy: "corrective" }, { branch: first.branch });
    await second.emit("session_start", { type: "session_start" });
    await second.emit("turn_end", finalTurn("after restart"));
    await tick();
    const current = second.runtimes[0]!;
    current.pending[0]!.resolve(confidentBlocker(current.requests[0]!));
    await tick();
    current.pending[1]!.resolve(confidentBlocker(current.requests[1]!));
    await tick();
    expect(second.sendMessage).not.toHaveBeenCalled();
  });

  test("restores a persisted cancellation across shutdown and a new extension session", async () => {
    const first = harness({ reviewPolicy: "corrective" });
    await first.emit("session_start", { type: "session_start" });
    await first.commands.get("advisor")!.handler("cancel", first.ctx as never);
    expect(first.appended.at(-1)).toMatchObject({
      routing: { cancellationLatched: true },
    });
    await first.emit("session_shutdown", { type: "session_shutdown" });

    const second = harness({ reviewPolicy: "corrective" }, { branch: first.branch });
    await second.emit("session_start", { type: "session_start" });
    await second.emit("turn_end", finalTurn("before genuine prompt"));
    await tick();
    const current = second.runtimes[0]!;
    current.pending[0]!.resolve(
      revise(current.requests[0]!, "concern", "restored cancellation concern"),
    );
    await tick();
    expect(second.sendMessage).not.toHaveBeenCalled();

    await second.emit("message_end", {
      type: "message_end",
      message: { role: "user", content: "genuine new prompt" },
    });
    await second.emit("turn_start", { type: "turn_start", turnIndex: 2 });
    await second.emit("turn_end", { ...finalTurn("after prompt"), turnIndex: 2 });
    await tick();
    await resolveVerifiedBlocker(current, 1, "post-prompt blocker");
    expect(second.sendMessage.mock.lastCall?.[1]).toEqual({
      deliverAs: "steer",
      triggerTurn: true,
    });
  });

  test("observes assistant_final before turn_complete in the checkpoint batch", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("ordered"));
    await tick();
    const observations = value.runtimes[0]?.requests[0]?.observations ?? "";
    expect(observations.indexOf("assistant_final")).toBeLessThan(
      observations.indexOf("turn_complete"),
    );
  });
});
