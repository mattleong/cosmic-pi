// Test harness boundary: only the diagnostics used by this file are suppressed.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { describe, expect, test, vi } from "vitest";
import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeDriver,
  AdvisorRuntimeServiceShape,
} from "../src/advisor-runtime.ts";
import {
  AdvisorReviewQueue,
  AdvisorQueueError,
  AdvisorReviewQueueService,
  advisorReviewQueueServiceLayer,
  type AdvisorReviewQueueOptions,
} from "../src/review-queue.ts";
import { AdvisorModelError } from "../src/client.ts";

type TestQueue = AdvisorReviewQueue & {
  checkpoint: (
    request: Parameters<AdvisorReviewQueue["checkpointEffect"]>[0],
  ) => Promise<AdvisorCheckpoint>;
  dispose: () => Promise<void>;
  reset: (seed: string, stateSummary?: string) => Promise<void>;
};

async function makeQueue(
  driver: AdvisorRuntimeDriver,
  options: AdvisorReviewQueueOptions = {},
): Promise<TestQueue> {
  const scope = Scope.makeUnsafe();
  const runtime: AdvisorRuntimeServiceShape = {
    activeToolNames: () => driver.activeToolNames,
    start: (value) => Effect.tryPromise({ try: () => driver.start(value), catch: modelError }),
    checkpoint: (value) =>
      Effect.tryPromise({ try: () => driver.checkpoint(value), catch: modelError }),
    steer: (value) => Effect.tryPromise({ try: () => driver.steer(value), catch: modelError }),
    reprime: (seed, state) =>
      Effect.tryPromise({ try: () => driver.reprime(seed, state), catch: modelError }),
    abort: () => Effect.promise(() => driver.abort()),
    dispose: () => Effect.promise(() => driver.dispose()),
  };
  const queue = new AdvisorReviewQueue(
    runtime,
    options,
    scope,
    Effect.runSync(Semaphore.make(1)),
    Effect.runSync(Semaphore.make(1)),
    Effect.runSync(Ref.make(0)),
  ) as TestQueue;
  await Effect.runPromise(queue.initializeEffect());
  queue.checkpoint = (request) => Effect.runPromise(queue.checkpointEffect(request));
  queue.reset = (seed, state) => Effect.runPromise(queue.resetEffect(seed, state));
  queue.dispose = () =>
    Effect.runPromise(queue.disposeEffect().pipe(Effect.andThen(Scope.close(scope, Exit.void))));
  return queue;
}

const modelError = (error: unknown) =>
  error instanceof AdvisorModelError
    ? error
    : new AdvisorModelError({ message: error instanceof Error ? error.message : "test failure" });

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
  test("ManagedRuntime disposal alone finalizes an acquired queue exactly once", async () => {
    let disposals = 0;
    const runtime: AdvisorRuntimeServiceShape = {
      activeToolNames: () => [],
      start: () => Effect.void,
      checkpoint: () => Effect.never,
      steer: () => Effect.succeed(false),
      reprime: () => Effect.void,
      abort: () => Effect.void,
      dispose: () =>
        Effect.sync(() => {
          disposals += 1;
        }),
    };
    const managed = ManagedRuntime.make(advisorReviewQueueServiceLayer);
    const service = await managed.runPromise(AdvisorReviewQueueService);
    await managed.runPromise(service.make(runtime));
    await managed.dispose();
    expect(disposals).toBe(1);
  });

  test("serializes two checkpoints and does not ordinarily abort the first", async () => {
    const harness = runtimeHarness();
    const queue = await makeQueue(harness.runtime);
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
    const queue = await makeQueue(harness.runtime);
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

  test("drains an observation that arrives while live steering is unresolved", async () => {
    const harness = runtimeHarness();
    const firstSteer = deferred<boolean>();
    const secondSteer = deferred<boolean>();
    (harness.runtime.steer as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => firstSteer.promise)
      .mockImplementationOnce(() => secondSteer.promise);
    const queue = await makeQueue(harness.runtime);
    queue.ingest(1, { type: "assistant_text_delta", text: "checkpoint seed" });
    const checkpoint = queue.checkpoint({
      checkpointId: "one",
      focus: "standard",
      parentTurnId: 1,
    });
    await tick();

    queue.ingest(1, { type: "assistant_text_delta", text: "first live delta" });
    await tick();
    expect(harness.runtime.steer).toHaveBeenCalledOnce();
    queue.ingest(1, { type: "assistant_text_delta", text: "second in-flight delta" });
    firstSteer.resolve(true);
    await tick();

    expect(harness.runtime.steer).toHaveBeenCalledTimes(2);
    expect(harness.runtime.steer).toHaveBeenLastCalledWith(
      expect.stringContaining("second in-flight delta"),
    );
    secondSteer.resolve(true);
    const request = harness.requests[0];
    if (!request) throw new Error("missing request");
    harness.pending[0]?.resolve(result(request));
    await checkpoint;
    await queue.dispose();
  });

  test("freezes exact pre-pump checkpoint barriers across a seq1/seq2 coalescing race", async () => {
    const harness = runtimeHarness();
    const queue = await makeQueue(harness.runtime);
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
    const queue = await makeQueue(harness.runtime);
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
    const queue = await makeQueue(harness.runtime);
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
    const queue = await makeQueue(harness.runtime);
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

  test("reports correlation validation as a typed queue failure, not a defect", async () => {
    const harness = runtimeHarness();
    (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockImplementation(
      async (request: AdvisorCheckpointRequest) => ({ ...result(request), checkpointId: "wrong" }),
    );
    const queue = await makeQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "request" });
    const exit = await Effect.runPromiseExit(
      queue.checkpointEffect({ checkpointId: "expected", focus: "standard", parentTurnId: 1 }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") expect(failure.value).toBeInstanceOf(AdvisorQueueError);
      expect(Cause.hasDies(exit.cause)).toBe(false);
    }
    await queue.dispose();
  });

  test("preserves typed provider failure text for parent classification", async () => {
    const harness = runtimeHarness();
    (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Advisor authentication failed; credential unavailable."),
    );
    const queue = await makeQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "request" });
    await expect(
      queue.checkpoint({ checkpointId: "auth", focus: "standard", parentTurnId: 1 }),
    ).rejects.toThrow(/authentication.*credential/i);
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
    const queue = await makeQueue(harness.runtime, {
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

  test("drops a repeated maximum-response batch and a later small checkpoint succeeds", async () => {
    const harness = runtimeHarness();
    let attempt = 0;
    (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockImplementation(
      async (request: AdvisorCheckpointRequest) => {
        attempt += 1;
        if (attempt <= 2) throw new Error("Advisor checkpoint exceeds the maximum response size.");
        return result(request);
      },
    );
    const queue = await makeQueue(harness.runtime, {
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
    const queue = await makeQueue(harness.runtime, {
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
    expect(harness.runtime.abort).toHaveBeenCalledOnce();
    expect(harness.runtime.reprime).not.toHaveBeenCalled();
  });

  test("hard reset aborts and rejects stale checkpoint work", async () => {
    const harness = runtimeHarness();
    const queue = await makeQueue(harness.runtime);
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
