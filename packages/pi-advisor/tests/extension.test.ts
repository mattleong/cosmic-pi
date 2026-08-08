// Test harness boundary: only the diagnostics used by this file are suppressed.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/globalDate:off
// @effect-diagnostics effect/globalTimers:off
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import type { AdvisorCheckpoint, AdvisorCheckpointRequest } from "../src/runtime/runtime.ts";
import type { ResolvedAdvisorConfig } from "../src/config/options.ts";
import { createAdvisorExtension } from "../src/extension.ts";
import { deferred, tick } from "./support/async.ts";
import { finalTurn, passCheckpoint as pass } from "./support/checkpoints.ts";
import { resolvedAdvisorConfig } from "./support/config.ts";
import { configStoreLayerFromLoad, failureLoggerLayerFromLog } from "./support/layers.ts";
import {
  advisorExtensionApi,
  advisorExtensionContext,
  anchorUserBranch,
  commandRegistry,
  handlerRegistry,
} from "./support/extension-host.ts";
import { controllableRuntimeService } from "./support/runtime-service.ts";

type TrackedAbortListener = EventListenerOrEventListenerObject;

function trackedAbortSignal() {
  let aborted = false;
  const added: TrackedAbortListener[] = [];
  const removed: TrackedAbortListener[] = [];
  const live = new Set<TrackedAbortListener>();
  const addEventListener = vi.fn((_type: string, listener: TrackedAbortListener) => {
    added.push(listener);
    live.add(listener);
  });
  const removeEventListener = vi.fn((_type: string, listener: TrackedAbortListener) => {
    removed.push(listener);
    live.delete(listener);
  });
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener,
    removeEventListener,
  } as unknown as AbortSignal;
  return {
    signal,
    abort: () => {
      if (aborted) return;
      aborted = true;
      for (const listener of live) {
        if (typeof listener === "function") listener.call(signal, { type: "abort" } as Event);
        else listener.handleEvent({ type: "abort" } as Event);
      }
    },
    addedListeners: () => [...added],
    liveListeners: () => [...live],
    removalCount: (listener: TrackedAbortListener) =>
      removed.filter((candidate) => candidate === listener).length,
  };
}

function expectAbortListenersReleasedExactlyOnce(tracker: ReturnType<typeof trackedAbortSignal>) {
  const added = tracker.addedListeners();
  expect(added.length).toBeGreaterThan(0);
  expect(new Set(added).size).toBe(added.length);
  expect(tracker.liveListeners()).toHaveLength(0);
  for (const listener of added) expect(tracker.removalCount(listener)).toBe(1);
}

function harness(
  overrides: Partial<ResolvedAdvisorConfig> = {},
  options: {
    runtimeStartError?: Error;
    runtimeStartPromises?: Array<Promise<void> | undefined>;
    runtimeDisposePromises?: Array<Promise<void> | undefined>;
    branch?: Array<Record<string, unknown>>;
    withoutSessionId?: boolean;
  } = {},
) {
  const registry = handlerRegistry();
  const { commands, registerCommand } = commandRegistry();
  const sendMessage = vi.fn();
  const appended: unknown[] = [];
  const runtimeService = controllableRuntimeService({
    startError: options.runtimeStartError,
    startPromises: options.runtimeStartPromises,
    disposePromises: options.runtimeDisposePromises,
  });
  const runtimes = runtimeService.runtimes;
  const branch = options.branch ?? anchorUserBranch();
  const pi = advisorExtensionApi({
    on: registry.on,
    registerCommand,
    sendMessage,
    appendEntry: (customType: string, data: unknown) => {
      appended.push(data);
      branch.push({
        id: `ledger-${branch.length}`,
        type: "custom",
        parentId: branch.at(-1)?.id ?? null,
        timestamp: "now",
        customType,
        data,
      });
    },
  });
  const ctx = advisorExtensionContext({
    getBranch: () => branch,
    withoutSessionId: options.withoutSessionId,
  });
  const logFailure = vi.fn();
  createAdvisorExtension({
    configStore: configStoreLayerFromLoad(() => resolvedAdvisorConfig(overrides)),
    runtimeService: runtimeService.layer,
    failureLogger: failureLoggerLayerFromLog(logFailure),
  })(pi);
  const emitWithContext = registry.emitWithContext;
  const emitAwait = async (name: string, event: unknown) => emitWithContext(name, event, ctx);
  const emit = async (name: string, event: unknown) => {
    if (name !== "turn_end") return emitAwait(name, event);
    registry.emitDetachedWithContext(name, event, ctx);
  };
  return {
    appended,
    branch,
    commands,
    ctx,
    emit,
    emitAwait,
    emitWithContext,
    logFailure,
    runtimes,
    sendMessage,
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

  test("keeps separately registered advisor factories runtime-isolated", async () => {
    const first = harness();
    const second = harness();
    await Promise.all([
      first.emit("session_start", { type: "session_start" }),
      second.emit("session_start", { type: "session_start" }),
    ]);
    await first.emit("session_shutdown", { type: "session_shutdown" });
    await second.emit("session_tree", { type: "session_tree" });

    expect(first.runtimes).toHaveLength(1);
    expect(first.runtimes[0]!.driver.dispose).toHaveBeenCalledOnce();
    expect(second.runtimes).toHaveLength(2);
    expect(second.runtimes[1]!.driver.start).toHaveBeenCalledOnce();
  });

  test("starts once per parent session and disposes on shutdown", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    const current = value.runtimes[0];
    expect(current?.driver.start).toHaveBeenCalledOnce();
    await value.emit("session_shutdown", { type: "session_shutdown" });
    expect(current?.driver.dispose).toHaveBeenCalledOnce();
  });

  test("a failed replacement capture shuts down the prior application exactly once", async () => {
    const value = harness();
    const cancellation = trackedAbortSignal();
    (value.ctx as unknown as { signal: AbortSignal }).signal = cancellation.signal;
    await value.emit("session_start", { type: "session_start" });
    const current = value.runtimes[0]!;
    expect(cancellation.liveListeners()).toHaveLength(2);

    const invalidContext = Object.create(value.ctx) as ExtensionContext;
    Object.defineProperty(invalidContext, "cwd", {
      configurable: true,
      get: () => {
        throw new Error("guarded cwd unavailable");
      },
    });
    await expect(
      value.emitWithContext("session_start", { type: "session_start" }, invalidContext),
    ).resolves.toBeUndefined();
    await expect(
      value.emitWithContext("session_start", { type: "session_start" }, invalidContext),
    ).resolves.toBeUndefined();

    expect(value.runtimes).toHaveLength(1);
    expect(current.driver.dispose).toHaveBeenCalledOnce();
    expectAbortListenersReleasedExactlyOnce(cancellation);
    await value.emit("turn_end", finalTurn("must not reach the disposed application"));
    await tick();
    expect(current.requests).toHaveLength(0);
    cancellation.abort();
    await tick();
    expect(current.driver.dispose).toHaveBeenCalledOnce();
  });

  test("valid replacement disposes the old Layer and its committed abort listener", async () => {
    const value = harness();
    const firstCancellation = trackedAbortSignal();
    const secondCancellation = trackedAbortSignal();
    (value.ctx as unknown as { signal: AbortSignal }).signal = firstCancellation.signal;
    await value.emit("session_start", { type: "session_start" });
    const firstRuntime = value.runtimes[0]!;
    expect(firstCancellation.liveListeners()).toHaveLength(2);

    const replacementContext = Object.create(value.ctx) as ExtensionContext;
    Object.defineProperty(replacementContext, "signal", {
      configurable: true,
      value: secondCancellation.signal,
    });
    await value.emitWithContext("session_start", { type: "session_start" }, replacementContext);

    expect(value.runtimes).toHaveLength(2);
    expect(firstRuntime.driver.dispose).toHaveBeenCalledOnce();
    expectAbortListenersReleasedExactlyOnce(firstCancellation);
    expect(secondCancellation.liveListeners()).toHaveLength(2);

    firstCancellation.abort();
    await tick();
    expect(value.runtimes[1]!.driver.dispose).not.toHaveBeenCalled();

    secondCancellation.abort();
    await tick();
    await tick();
    expect(value.runtimes[1]!.driver.dispose).toHaveBeenCalledOnce();
    expectAbortListenersReleasedExactlyOnce(secondCancellation);
  });

  test("throwing status UI cannot skip child shutdown disposal", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    const current = value.runtimes[0]!;
    (value.ctx.ui.setStatus as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("status failed");
    });

    await expect(
      value.emit("session_shutdown", { type: "session_shutdown" }),
    ).resolves.toBeUndefined();
    expect(current.driver.dispose).toHaveBeenCalledOnce();
  });

  test("serializes overlapping child replacements behind prior disposal", async () => {
    const disposal = deferred<void>();
    const value = harness({}, { runtimeDisposePromises: [disposal.promise, undefined] });
    await value.emit("session_start", { type: "session_start" });
    const first = value.runtimes[0]!;

    const tree = value.emitAwait("session_tree", { type: "session_tree" });
    await tick();
    const compact = value.emitAwait("session_compact", { type: "session_compact" });
    await tick();
    expect(value.runtimes).toHaveLength(1);
    expect(first.driver.dispose).toHaveBeenCalledOnce();

    disposal.resolve();
    await Promise.all([tree, compact]);
    expect(value.runtimes).toHaveLength(2);
    expect(value.runtimes[1]!.driver.start).toHaveBeenCalledOnce();
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
        await value.commands.get("advisor")!.handler("review", value.ctx as never);
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

  test("cancel stops in-flight work without late delivery", async () => {
    const value = harness();
    await value.emit("session_start", { type: "session_start" });
    await value.emit("turn_end", finalTurn("candidate"));
    await tick();
    const current = value.runtimes[0]!;
    await value.commands.get("advisor")!.handler("cancel", value.ctx as never);
    current.pending[0]!.resolve(revise(current.requests[0]!));
    await tick();
    expect(value.sendMessage).not.toHaveBeenCalled();
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

  test("persists the reset intervention budget at a genuine request boundary", async () => {
    const value = harness();
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

  test("keeps lifecycle identity stable across restart without a session ID", async () => {
    const first = harness({}, { withoutSessionId: true });
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
      {},
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

  test("manual review cannot start unmanaged work after shutdown or a tree callback", async () => {
    const value = harness({}, { runtimeStartPromises: [undefined] });
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

    const review = command.handler("review", value.ctx as never);
    await tick();
    expect(value.runtimes).toHaveLength(1);
    await value.emit("session_tree", { type: "session_tree" });
    expect(value.runtimes).toHaveLength(1);
    await review;
    await tick();

    expect(value.runtimes[0]!.requests).toHaveLength(1);
    expect(notify).not.toHaveBeenCalledWith(
      "No completed response is available to review.",
      "warning",
    );
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
    const first = harness();
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

    const second = harness({}, { branch: first.branch });
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
