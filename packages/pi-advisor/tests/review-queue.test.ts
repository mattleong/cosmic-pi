import { describe, expect, test, vi } from "vitest";
import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeDriver,
} from "../src/advisor-runtime.ts";
import { AdvisorReviewQueue } from "../src/review-queue.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function result(request: AdvisorCheckpointRequest): AdvisorCheckpoint {
  return {
    checkpointId: request.checkpointId,
    processedThrough: request.processedThrough,
    stateSummary: "compact state",
    verdict: "pass",
    summary: "No issue.",
    findings: [],
  };
}

function runtimeHarness() {
  const calls: string[] = [];
  const pending: Array<ReturnType<typeof deferred<AdvisorCheckpoint>>> = [];
  const requests: AdvisorCheckpointRequest[] = [];
  const runtime: AdvisorRuntimeDriver = {
    activeToolNames: [],
    start: vi.fn(async () => undefined),
    checkpoint: vi.fn((request: AdvisorCheckpointRequest) => {
      calls.push(`checkpoint:${request.checkpointId}`);
      requests.push(request);
      const wait = deferred<AdvisorCheckpoint>();
      pending.push(wait);
      return wait.promise;
    }),
    steer: vi.fn(async () => {
      calls.push("steer");
      return true;
    }),
    reprime: vi.fn(async () => undefined),
    abort: vi.fn(async () => {
      calls.push("abort");
    }),
    dispose: vi.fn(async () => undefined),
  };
  return { calls, pending, requests, runtime };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AdvisorReviewQueue", () => {
  test("serializes two checkpoints and does not ordinarily abort the first", async () => {
    const harness = runtimeHarness();
    const queue = new AdvisorReviewQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "request" });
    const first = queue.checkpoint({ checkpointId: "one", focus: "standard", parentTurnId: 1 });
    const second = queue.checkpoint({ checkpointId: "two", focus: "standard", parentTurnId: 1 });
    await tick();

    expect(harness.calls).toEqual(["checkpoint:one"]);
    expect(queue.pendingCheckpoints).toBe(2);
    expect(queue.activeToolNames).toEqual([]);
    expect(harness.runtime.abort).not.toHaveBeenCalled();
    const firstRequest = harness.requests[0];
    if (!firstRequest) throw new Error("missing request");
    harness.pending[0]?.resolve(result(firstRequest));
    await expect(first).resolves.toMatchObject({ checkpointId: "one" });
    await tick();
    expect(harness.calls).toEqual(["checkpoint:one", "checkpoint:two"]);
    const secondRequest = harness.requests[1];
    if (!secondRequest) throw new Error("missing second request");
    harness.pending[1]?.resolve(result(secondRequest));
    await expect(second).resolves.toMatchObject({ checkpointId: "two" });
    expect(queue.pendingCheckpoints).toBe(0);
  });

  test("coalesces and live-steers bounded deltas without committing them", async () => {
    const harness = runtimeHarness();
    const queue = new AdvisorReviewQueue(harness.runtime);
    queue.ingest(1, { type: "assistant_text_delta", text: "before" });
    const checkpoint = queue.checkpoint({
      checkpointId: "one",
      focus: "standard",
      parentTurnId: 1,
    });
    await tick();

    const startedAt = performance.now();
    for (let index = 0; index < 2_000; index += 1) {
      queue.ingest(1, { type: "assistant_thinking_delta", text: "x" });
    }
    expect(performance.now() - startedAt).toBeLessThan(100);
    await tick();
    expect(harness.runtime.steer).toHaveBeenCalledOnce();
    expect(harness.runtime.steer).toHaveBeenCalledWith(
      expect.stringContaining("assistant_thinking_delta"),
    );
    const steering = String((harness.runtime.steer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(steering.length).toBeLessThan(20_000);
    expect(harness.runtime.abort).not.toHaveBeenCalled();
    const request = harness.requests[0];
    if (!request) throw new Error("missing request");
    harness.pending[0]?.resolve(result(request));
    await checkpoint;
    expect(queue.processedThrough).toBe(1);
    expect(queue.backlog).toBeGreaterThan(0);

    const catchUp = queue.checkpoint({
      checkpointId: "two",
      focus: "standard",
      parentTurnId: 1,
    });
    await tick();
    expect(harness.requests[1]?.observations).toContain("assistant_thinking_delta");
    harness.pending[1]?.resolve(result(harness.requests[1]!));
    await catchUp;
  });

  test("freezes exact pre-pump checkpoint barriers across a seq1/seq2 coalescing race", async () => {
    const harness = runtimeHarness();
    const queue = new AdvisorReviewQueue(harness.runtime);
    queue.ingest(1, { type: "assistant_text_delta", text: "seq1" });
    const first = queue.checkpoint({ checkpointId: "one", focus: "standard", parentTurnId: 1 });
    queue.ingest(1, { type: "assistant_text_delta", text: "seq2" });
    const second = queue.checkpoint({ checkpointId: "two", focus: "standard", parentTurnId: 1 });
    await tick();

    expect(harness.requests[0]?.processedThrough).toBe(1);
    expect(harness.requests[0]?.observations).toContain("seq1");
    expect(harness.requests[0]?.observations).not.toContain("seq2");
    harness.pending[0]?.resolve(result(harness.requests[0]!));
    await first;
    await tick();
    expect(harness.requests[1]?.processedThrough).toBe(2);
    expect(harness.requests[1]?.observations).toContain("seq2");
    harness.pending[1]?.resolve(result(harness.requests[1]!));
    await second;
  });

  test("freezes seq1 tool_update before seq2 same-tool replacement in the pre-pump race", async () => {
    const harness = runtimeHarness();
    const queue = new AdvisorReviewQueue(harness.runtime);
    queue.ingest(1, { type: "tool_update", toolCallId: "c", toolName: "read", update: "seq1" });
    const first = queue.checkpoint({ checkpointId: "one", focus: "standard", parentTurnId: 1 });
    queue.ingest(1, { type: "tool_update", toolCallId: "c", toolName: "read", update: "seq2" });
    const second = queue.checkpoint({ checkpointId: "two", focus: "standard", parentTurnId: 1 });
    await tick();

    expect(harness.requests[0]?.processedThrough).toBe(1);
    expect(harness.requests[0]?.observations).toContain("seq1");
    expect(harness.requests[0]?.observations).not.toContain("seq2");
    harness.pending[0]?.resolve(result(harness.requests[0]!));
    await first;
    await tick();
    expect(harness.requests[1]?.processedThrough).toBe(2);
    expect(harness.requests[1]?.observations).toContain("seq2");
    harness.pending[1]?.resolve(result(harness.requests[1]!));
    await second;
  });

  test("retains failed or idle-race live delivery for the next coherent checkpoint", async () => {
    const harness = runtimeHarness();
    (harness.runtime.steer as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const queue = new AdvisorReviewQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "initial" });
    const first = queue.checkpoint({ checkpointId: "one", focus: "standard", parentTurnId: 1 });
    await tick();
    queue.ingest(1, { type: "assistant_text_delta", text: "late-must-survive" });
    await tick();
    harness.pending[0]?.resolve(result(harness.requests[0]!));
    await first;

    expect(queue.processedThrough).toBe(1);
    const retry = queue.checkpoint({ checkpointId: "two", focus: "standard", parentTurnId: 1 });
    await tick();
    expect(harness.requests[1]?.processedThrough).toBe(2);
    expect(harness.requests[1]?.observations).toContain("late-must-survive");
    harness.pending[1]?.resolve(result(harness.requests[1]!));
    await retry;
    expect(queue.processedThrough).toBe(2);
  });

  test("requeues an in-flight observation batch after checkpoint failure", async () => {
    const harness = runtimeHarness();
    const queue = new AdvisorReviewQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "must survive" });
    const failed = queue.checkpoint({ checkpointId: "failed", focus: "standard", parentTurnId: 1 });
    await tick();
    for (let index = 0; index < 1_000; index += 1) {
      queue.ingest(1, { type: "assistant_text_delta", text: `later-${index}` });
    }
    harness.pending[0]?.resolve({ ...result(harness.requests[0]!), checkpointId: "wrong" });
    await expect(failed).rejects.toThrow("correlation");

    const retry = queue.checkpoint({ checkpointId: "retry", focus: "standard", parentTurnId: 1 });
    await tick();
    expect(harness.requests[1]?.observations).toContain("must survive");
    harness.pending[1]?.resolve(result(harness.requests[1]!));
    await retry;
    expect(queue.processedThrough).toBe(1_001);
  });

  test("re-primes at the current cursor and bounds overflow retry to one", async () => {
    const harness = runtimeHarness();
    let attempt = 0;
    (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockImplementation(
      async (request: AdvisorCheckpointRequest) => {
        attempt += 1;
        if (attempt === 1) throw new Error("context overflow");
        return result(request);
      },
    );
    const reset = vi.fn();
    const queue = new AdvisorReviewQueue(harness.runtime, {
      getReprimeState: () => ({ seed: "current cursor", stateSummary: "compact" }),
      onRuntimeReset: reset,
    });
    queue.ingest(1, { type: "user", text: "bounded batch" });
    await expect(
      queue.checkpoint({ checkpointId: "overflow", focus: "standard", parentTurnId: 1 }),
    ).resolves.toMatchObject({ checkpointId: "overflow" });
    expect(harness.runtime.reprime).toHaveBeenCalledTimes(1);
    expect(harness.runtime.reprime).toHaveBeenCalledWith("current cursor", "compact");
    expect(reset).toHaveBeenCalledOnce();
  });

  test("drops a repeatedly overflowing batch and a later small checkpoint succeeds", async () => {
    const harness = runtimeHarness();
    let attempt = 0;
    (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockImplementation(
      async (request: AdvisorCheckpointRequest) => {
        attempt += 1;
        if (attempt <= 2) throw new Error("context overflow");
        return result(request);
      },
    );
    const queue = new AdvisorReviewQueue(harness.runtime, {
      getReprimeState: () => ({ seed: "current cursor", stateSummary: "compact" }),
    });
    queue.ingest(1, { type: "user", text: "oversized" });
    await expect(
      queue.checkpoint({ checkpointId: "drop", focus: "standard", parentTurnId: 1 }),
    ).rejects.toThrow("dropped");
    expect(queue.backlog).toBe(0);
    queue.ingest(2, { type: "user", text: "small" });
    await expect(
      queue.checkpoint({ checkpointId: "small", focus: "standard", parentTurnId: 2 }),
    ).resolves.toMatchObject({ checkpointId: "small" });
    expect(harness.runtime.reprime).toHaveBeenCalledTimes(2);
  });

  test("disposal prevents a rejected checkpoint from re-priming or retrying", async () => {
    const harness = runtimeHarness();
    const failure = deferred<AdvisorCheckpoint>();
    (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockImplementation(
      () => failure.promise,
    );
    const queue = new AdvisorReviewQueue(harness.runtime, {
      getReprimeState: () => ({ seed: "obsolete cursor", stateSummary: "obsolete state" }),
    });
    queue.ingest(1, { type: "user", text: "old request" });
    const checkpoint = queue.checkpoint({
      checkpointId: "obsolete",
      focus: "standard",
      parentTurnId: 1,
    });
    const rejection = expect(checkpoint).rejects.toThrow(/disposed|stale/);
    await tick();

    await queue.dispose();
    failure.reject(new Error("context overflow"));
    await rejection;
    await tick();

    expect(harness.runtime.checkpoint).toHaveBeenCalledOnce();
    expect(harness.runtime.reprime).not.toHaveBeenCalled();
  });

  test("hard reset aborts and rejects stale checkpoint work", async () => {
    const harness = runtimeHarness();
    const queue = new AdvisorReviewQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "old branch" });
    const checkpoint = queue.checkpoint({
      checkpointId: "old",
      focus: "standard",
      parentTurnId: 1,
    });
    await tick();
    const rejection = expect(checkpoint).rejects.toThrow(/stale|reset/);
    await queue.reset("new branch", "state");
    const request = harness.requests[0];
    if (!request) throw new Error("missing request");
    harness.pending[0]?.resolve(result(request));
    await rejection;

    expect(harness.calls).toContain("abort");
    expect(harness.runtime.reprime).toHaveBeenCalledWith("new branch", "state");
    expect(queue.processedThrough).toBe(0);
  });
});
