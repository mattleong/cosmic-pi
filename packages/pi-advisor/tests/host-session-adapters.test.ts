// Test harness boundary: only the diagnostics used by this file are suppressed.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { describe, expect, test, vi } from "vitest";
import type { AdvisorCheckpoint, AdvisorCheckpointRequest } from "../src/runtime/runtime.ts";
import {
  abortAdvisorParentAtHostBoundary,
  AdvisorHostContextError,
  readAdvisorContextEntriesAtHostBoundary,
  readAdvisorContextEntriesEffect,
  readAdvisorParentIdleAtHostBoundary,
  readAdvisorPendingMessagesAtHostBoundary,
  readAdvisorSessionBranchAtHostBoundary,
  readAdvisorSessionBranchEffect,
  readAdvisorSessionIdAtHostBoundary,
  readAdvisorSessionLeafIdAtHostBoundary,
  type AdvisorHostReadResult,
} from "../src/boundary/host-context.ts";
import type { ResolvedAdvisorConfig } from "../src/config/options.ts";
import { createAdvisorExtension } from "../src/extension.ts";
import { tick } from "./support/async.ts";
import { finalTurn, passCheckpoint as pass } from "./support/checkpoints.ts";
import { resolvedAdvisorConfig } from "./support/config.ts";
import {
  advisorExtensionApi,
  advisorExtensionContext,
  anchorUserBranch,
  commandRegistry,
  handlerRegistry,
} from "./support/extension-host.ts";
import { controllableRuntimeDriver } from "./support/runtime-driver.ts";

const resolvedConfig = (): ResolvedAdvisorConfig =>
  resolvedAdvisorConfig({
    configPath: "/tmp/pi-advisor-host-session-test.json",
    provider: "provider",
    model: "model",
  });

function revise(
  request: AdvisorCheckpointRequest,
  severity: "blocker" | "concern" = "concern",
): AdvisorCheckpoint {
  return {
    checkpointId: request.checkpointId,
    processedThrough: request.processedThrough,
    stateSummary: "compact",
    verdict: "revise",
    summary: "A material issue remains.",
    findings: [
      {
        fingerprint: "host-boundary-finding",
        category: "correctness",
        severity,
        confidence: "high",
        evidenceBasis: "direct",
        issue: "The response contains a material issue.",
        evidence: "The transcript directly contradicts the response.",
        recommendation: "Correct the response.",
      },
    ],
  };
}

function makeHarness() {
  const registry = handlerRegistry();
  const { commands, registerCommand } = commandRegistry();
  const sendMessage = vi.fn();
  const branch = anchorUserBranch();
  const { driver, pending, requests } = controllableRuntimeDriver({ activeToolNames: ["read"] });
  const pi = advisorExtensionApi({
    on: registry.on,
    registerCommand,
    sendMessage,
  });
  const ctx = advisorExtensionContext({
    getBranch: () => branch,
    isProjectTrusted: false,
    modelRegistry: { getAvailable: vi.fn(() => []), find: vi.fn() },
  });

  createAdvisorExtension({
    loadConfig: resolvedConfig,
    createRuntime: () => driver,
  })(pi);

  const emit = async (name: string, event: unknown): Promise<void> =>
    registry.emitWithContext(name, event, ctx);

  return {
    commands,
    ctx,
    driver,
    emit,
    pending,
    requests,
    sendMessage,
    appendEntry: vi.mocked(pi.appendEntry),
  };
}

const hostileContext = (method: string, secret: string): ExtensionContext => {
  const fail = () => {
    throw new Error(secret);
  };
  return {
    abort: method === "abort" ? fail : () => undefined,
    hasPendingMessages: method === "hasPendingMessages" ? fail : () => false,
    isIdle: method === "isIdle" ? fail : () => true,
    sessionManager: {
      buildContextEntries: method === "buildContextEntries" ? fail : () => [],
      getBranch: method === "getBranch" ? fail : () => [],
      getLeafId: method === "getLeafId" ? fail : () => "anchor",
      getSessionId: method === "getSessionId" ? fail : () => "session",
    },
  } as unknown as ExtensionContext;
};

const expectTypedHostFailure = (
  result: AdvisorHostReadResult<unknown>,
  operation: string,
  secret: string,
): void => {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AdvisorHostContextError);
  expect(result.error.operation).toBe(operation);
  expect(JSON.stringify(result.error)).not.toContain(secret);
};

describe("advisor host session adapters", () => {
  test.each([
    [
      "buildContextEntries",
      "session-context",
      (ctx: ExtensionContext) => readAdvisorContextEntriesAtHostBoundary(ctx),
    ],
    [
      "getBranch",
      "session-branch",
      (ctx: ExtensionContext) => readAdvisorSessionBranchAtHostBoundary(ctx),
    ],
    [
      "getLeafId",
      "session-leaf",
      (ctx: ExtensionContext) => readAdvisorSessionLeafIdAtHostBoundary(ctx),
    ],
    [
      "getSessionId",
      "session-id",
      (ctx: ExtensionContext) => readAdvisorSessionIdAtHostBoundary(ctx),
    ],
    ["isIdle", "parent-idle", (ctx: ExtensionContext) => readAdvisorParentIdleAtHostBoundary(ctx)],
    [
      "hasPendingMessages",
      "pending-messages",
      (ctx: ExtensionContext) => readAdvisorPendingMessagesAtHostBoundary(ctx),
    ],
    ["abort", "parent-abort", (ctx: ExtensionContext) => abortAdvisorParentAtHostBoundary(ctx)],
  ] as const)("maps a throwing %s read to a redacted typed failure", (method, operation, read) => {
    const secret = `secret-${method}`;
    expectTypedHostFailure(read(hostileContext(method, secret)), operation, secret);
  });

  test("keeps startup branch and context reads typed in Effect", async () => {
    const secret = "startup-read-secret";
    const branch = await Effect.runPromise(
      Effect.result(readAdvisorSessionBranchEffect(hostileContext("getBranch", secret))),
    );
    const entries = await Effect.runPromise(
      Effect.result(readAdvisorContextEntriesEffect(hostileContext("buildContextEntries", secret))),
    );

    expect(branch._tag).toBe("Failure");
    expect(entries._tag).toBe("Failure");
    if (branch._tag === "Failure") {
      expect(branch.failure).toMatchObject({
        _tag: "AdvisorHostContextError",
        operation: "session-branch",
      });
      expect(JSON.stringify(branch.failure)).not.toContain(secret);
    }
    if (entries._tag === "Failure") {
      expect(entries.failure).toMatchObject({
        _tag: "AdvisorHostContextError",
        operation: "session-context",
      });
      expect(JSON.stringify(entries.failure)).not.toContain(secret);
    }
  });

  test("rejects hostile or malformed live arrays before they leave the boundary", () => {
    const branchProxy = new Proxy([], {
      getOwnPropertyDescriptor() {
        throw new Error("branch-proxy-secret");
      },
    });
    const hostileBranch = {
      sessionManager: { getBranch: () => branchProxy },
    } as unknown as ExtensionContext;
    const malformedContext = {
      sessionManager: { buildContextEntries: () => ({ 0: {}, length: 1 }) },
    } as unknown as ExtensionContext;

    expectTypedHostFailure(
      readAdvisorSessionBranchAtHostBoundary(hostileBranch),
      "session-branch",
      "branch-proxy-secret",
    );
    expectTypedHostFailure(
      readAdvisorContextEntriesAtHostBoundary(malformedContext),
      "session-context",
      "unavailable-secret",
    );
  });

  test.each(["getBranch", "buildContextEntries"] as const)(
    "keeps the outer session_start callback no-throw when %s fails",
    async (method) => {
      const value = makeHarness();
      vi.mocked(value.ctx.sessionManager[method]).mockImplementation(() => {
        throw new Error(`secret-${method}`);
      });

      await expect(value.emit("session_start", { type: "session_start" })).resolves.toBeUndefined();
      expect(value.sendMessage).not.toHaveBeenCalled();
    },
  );

  test.each(["buildContextEntries", "getBranch", "getLeafId", "getSessionId"] as const)(
    "keeps turn_end no-throw when dynamic %s fails",
    async (method) => {
      const value = makeHarness();
      await value.emit("session_start", { type: "session_start" });
      vi.mocked(value.ctx.sessionManager[method]).mockImplementation(() => {
        throw new Error(`secret-${method}`);
      });

      const completed = value.emit("turn_end", finalTurn("candidate"));
      await tick();
      for (let index = 0; index < value.pending.length; index += 1) {
        value.pending[index]!.resolve(pass(value.requests[index]!));
        await tick();
      }
      await expect(completed).resolves.toBeUndefined();
    },
  );

  test("treats a hostile pending-message read as pending and suppresses delivery", async () => {
    const value = makeHarness();
    await value.emit("session_start", { type: "session_start" });
    const completed = value.emit("turn_end", finalTurn("candidate"));
    await tick();
    expect(value.requests).toHaveLength(1);
    vi.mocked(value.ctx.hasPendingMessages).mockImplementation(() => {
      throw new Error("pending-message-secret");
    });

    value.pending[0]!.resolve(revise(value.requests[0]!));
    await completed;

    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(value.ctx.abort).not.toHaveBeenCalled();
  });

  test("uses the turn-dynamic signal when session_start had no active run signal", async () => {
    const value = makeHarness();
    let currentSignal: AbortSignal | undefined;
    Object.defineProperty(value.ctx, "signal", {
      configurable: true,
      get: () => currentSignal,
    });
    await value.emit("session_start", { type: "session_start" });

    const run = new AbortController();
    currentSignal = run.signal;
    const completed = value.emit("turn_end", finalTurn("candidate"));
    await tick();
    expect(value.requests).toHaveLength(1);

    run.abort();
    value.pending[0]!.resolve(revise(value.requests[0]!));
    await completed;

    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(value.ctx.abort).not.toHaveBeenCalled();
  });

  test("fails closed when both branch and leaf cursor reads become hostile", async () => {
    const value = makeHarness();
    await value.emit("session_start", { type: "session_start" });
    vi.mocked(value.ctx.sessionManager.getBranch).mockImplementation(() => {
      throw new Error("branch-secret");
    });
    vi.mocked(value.ctx.sessionManager.getLeafId).mockImplementation(() => {
      throw new Error("leaf-secret");
    });

    await expect(value.emit("turn_end", finalTurn("candidate"))).resolves.toBeUndefined();

    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(value.ctx.abort).not.toHaveBeenCalled();
  });

  test("treats a hostile idle read as active and uses non-triggering correction guidance", async () => {
    const value = makeHarness();
    await value.emit("session_start", { type: "session_start" });
    const completed = value.emit("turn_end", finalTurn("candidate"));
    await tick();
    expect(value.requests).toHaveLength(1);
    vi.mocked(value.ctx.isIdle).mockImplementation(() => {
      throw new Error("idle-secret");
    });

    value.pending[0]!.resolve(revise(value.requests[0]!));
    await completed;

    expect(value.appendEntry).toHaveBeenCalledWith(
      "pi-advisor-review-card-v1",
      expect.objectContaining({ version: 1, kind: "issues" }),
    );
    expect(value.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "pi-advisor-guidance-v1", display: false }),
      { deliverAs: "steer" },
    );
  });

  test("falls back to direct advice when the hostile parent abort throws", async () => {
    vi.useFakeTimers();
    try {
      const value = makeHarness();
      vi.mocked(value.ctx.isIdle).mockReturnValue(false);
      vi.mocked(value.ctx.abort).mockImplementation(() => {
        throw new Error("parent-abort-secret");
      });
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
      expect(value.requests[0]?.focus).toBe("trajectory");

      value.pending[0]!.resolve(revise(value.requests[0]!, "blocker"));
      await vi.advanceTimersByTimeAsync(0);
      expect(value.requests[1]?.focus).toBe("blocker-verification");
      value.pending[1]!.resolve(revise(value.requests[1]!, "blocker"));
      await vi.advanceTimersByTimeAsync(0);

      expect(value.ctx.abort).toHaveBeenCalledOnce();
      expect(value.appendEntry).toHaveBeenCalledWith(
        "pi-advisor-review-card-v1",
        expect.objectContaining({ version: 1, kind: "issues" }),
      );
      expect(value.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "pi-advisor-guidance-v1", display: false }),
        { deliverAs: "steer" },
      );
      expect(value.ctx.ui.notify).toHaveBeenCalledWith(
        "Advisor could not abort the parent safely.",
        "warning",
      );
      expect(JSON.stringify(vi.mocked(value.ctx.ui.notify).mock.calls)).not.toContain(
        "parent-abort-secret",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
