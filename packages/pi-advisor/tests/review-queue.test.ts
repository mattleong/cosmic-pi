// Promise-shaped driver characterization intentionally remains at this test boundary.
// @effect-diagnostics effect/asyncFunction:off
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Scope from "effect/Scope";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeDriver,
  AdvisorRuntimeServiceShape,
} from "../src/runtime/runtime.ts";
import {
  AdvisorReviewQueue,
  AdvisorQueueBacklogExceededError,
  AdvisorQueueBatchDroppedError,
  AdvisorQueueCancelledError,
  AdvisorQueueCorrelationMismatchError,
  AdvisorQueueDisposedError,
  AdvisorQueueError,
  AdvisorQueueResetRequiredError,
  AdvisorQueueStaleEpochError,
  AdvisorReviewQueueService,
  MAX_PENDING_CHECKPOINTS,
  advisorReviewQueueServiceLayer,
  type AdvisorReviewQueueOptions,
  type QueuedCheckpoint,
} from "../src/queue/service.ts";
import { AdvisorModelError } from "../src/runtime/client.ts";

type TestQueue = AdvisorReviewQueue & {
  checkpoint: (
    request: Parameters<AdvisorReviewQueue["checkpointEffect"]>[0],
  ) => Promise<AdvisorCheckpoint>;
  dispose: () => Promise<void>;
  reset: (seed: string, stateSummary?: string) => Promise<void>;
};

const activeQueueCleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  await Promise.all([...activeQueueCleanups].map((cleanup) => cleanup()));
});

async function makeQueue(
  driver: AdvisorRuntimeDriver,
  options: AdvisorReviewQueueOptions = {},
): Promise<TestQueue> {
  const runtime: AdvisorRuntimeServiceShape = {
    activeToolNames: () => driver.activeToolNames,
    start: (value) => Effect.tryPromise({ try: () => driver.start(value), catch: modelError }),
    checkpoint: (value) =>
      Effect.tryPromise({ try: () => driver.checkpoint(value), catch: modelError }),
    steer: (value) => Effect.tryPromise({ try: () => driver.steer(value), catch: modelError }),
    reprime: (seed, state) =>
      Effect.tryPromise({ try: () => driver.reprime(seed, state), catch: modelError }),
    abort: () =>
      Effect.tryPromise({ try: () => driver.abort(), catch: modelError }).pipe(
        Effect.catch(() => Effect.void),
      ),
    dispose: () =>
      Effect.tryPromise({ try: () => driver.dispose(), catch: modelError }).pipe(
        Effect.catch(() => Effect.void),
      ),
  };
  const managed = ManagedRuntime.make(advisorReviewQueueServiceLayer);
  const service = await managed.runPromise(AdvisorReviewQueueService);
  const queue = (await managed.runPromise(service.make(runtime, options))) as TestQueue;
  const dispose = async () => {
    if (!activeQueueCleanups.delete(dispose)) return;
    try {
      await managed.runPromise(queue.disposeEffect());
    } finally {
      await managed.dispose();
    }
  };
  activeQueueCleanups.add(dispose);
  queue.checkpoint = (request) => managed.runPromise(queue.checkpointEffect(request));
  queue.reset = (seed, state) => managed.runPromise(queue.resetEffect(seed, state));
  queue.dispose = dispose;
  return queue;
}

const modelError = (error: unknown) =>
  error instanceof AdvisorModelError
    ? error
    : new AdvisorModelError({ message: error instanceof Error ? error.message : "test failure" });

function deferred<T>() {
  const value = Deferred.makeUnsafe<T, Error>();
  return {
    promise: Effect.runPromise(Deferred.await(value)),
    resolve: (next: T) => {
      Deferred.doneUnsafe(value, Effect.succeed(next));
    },
    reject: (error: Error) => {
      Deferred.doneUnsafe(value, Effect.fail(error));
    },
  };
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
  await Effect.runPromise(Effect.sleep(1));
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

  test("explicit disposal closes the queue child scope before the layer scope", async () => {
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
    const queue = await managed.runPromise(service.make(runtime));
    const queueScope = (queue as unknown as { resourceScope: Scope.Closeable }).resourceScope;

    expect(queueScope.state._tag).not.toBe("Closed");
    await managed.runPromise(queue.disposeEffect());
    expect(queueScope.state._tag).toBe("Closed");
    expect(disposals).toBe(1);

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

  test("interrupting an active checkpoint caller aborts owned work and leaves the queue reusable", async () => {
    const harness = runtimeHarness();
    const settled = vi.fn();
    const queue = await makeQueue(harness.runtime, { onCheckpointSettled: settled });
    queue.ingest(1, { type: "user", text: "interrupted" });
    const caller = Effect.runFork(
      queue.checkpointEffect({
        checkpointId: "interrupted",
        focus: "standard",
        parentTurnId: 1,
      }),
    );
    await tick();

    expect(queue.pendingCheckpoints).toBe(1);
    await Effect.runPromise(Fiber.interrupt(caller));
    expect(harness.runtime.abort).toHaveBeenCalledOnce();
    expect(queue.pendingCheckpoints).toBe(0);
    expect(queue.hasActiveCheckpoint).toBe(false);
    expect(settled).toHaveBeenCalledOnce();

    queue.ingest(2, { type: "user", text: "later" });
    const later = queue.checkpoint({
      checkpointId: "later",
      focus: "standard",
      parentTurnId: 2,
    });
    await tick();
    expect(harness.requests.map((request) => request.checkpointId)).toEqual([
      "interrupted",
      "later",
    ]);
    harness.pending[1]?.resolve(result(harness.requests[1]!));
    await expect(later).resolves.toMatchObject({ checkpointId: "later" });
    expect(queue.pendingCheckpoints).toBe(0);
    await queue.dispose();
  });

  test("interrupting a queued checkpoint caller removes only its admitted waiter", async () => {
    const harness = runtimeHarness();
    const queue = await makeQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "active" });
    const active = queue.checkpoint({
      checkpointId: "active",
      focus: "standard",
      parentTurnId: 1,
    });
    await tick();
    const queuedCaller = Effect.runFork(
      queue.checkpointEffect({
        checkpointId: "queued",
        focus: "standard",
        parentTurnId: 1,
      }),
    );
    await tick();

    expect(queue.pendingCheckpoints).toBe(2);
    await Effect.runPromise(Fiber.interrupt(queuedCaller));
    expect(queue.pendingCheckpoints).toBe(1);
    expect(harness.runtime.abort).not.toHaveBeenCalled();

    harness.pending[0]?.resolve(result(harness.requests[0]!));
    await active;
    expect(queue.pendingCheckpoints).toBe(0);
    await queue.dispose();
  });

  test("interrupting after atomic settlement does not decrement the next queued waiter", async () => {
    const harness = runtimeHarness();
    const queue = await makeQueue(harness.runtime);
    const settlementReached = deferred<void>();
    const releaseCompletion = deferred<void>();
    const internals = queue as unknown as {
      settleClaimedWaiterEffect: (
        waiter: QueuedCheckpoint,
        processedThrough?: number,
      ) => Effect.Effect<boolean>;
    };
    const settleClaimedWaiterEffect = internals.settleClaimedWaiterEffect.bind(queue);
    internals.settleClaimedWaiterEffect = (waiter, processedThrough) =>
      settleClaimedWaiterEffect(waiter, processedThrough).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            settlementReached.resolve();
          }),
        ),
        Effect.flatMap((settled) =>
          Effect.promise(() => releaseCompletion.promise).pipe(Effect.as(settled)),
        ),
      );

    queue.ingest(1, { type: "user", text: "first" });
    const firstCaller = Effect.runFork(
      queue.checkpointEffect({ checkpointId: "first", focus: "standard", parentTurnId: 1 }),
    );
    await tick();
    const second = queue.checkpoint({
      checkpointId: "second",
      focus: "standard",
      parentTurnId: 1,
    });
    await tick();
    expect(queue.pendingCheckpoints).toBe(2);

    harness.pending[0]?.resolve(result(harness.requests[0]!));
    await settlementReached.promise;
    expect(queue.hasActiveCheckpoint).toBe(false);
    expect(queue.pendingCheckpoints).toBe(1);
    await Effect.runPromise(Fiber.interrupt(firstCaller));
    expect(queue.pendingCheckpoints).toBe(1);
    expect(harness.runtime.abort).not.toHaveBeenCalled();

    releaseCompletion.resolve();
    await tick();
    expect(harness.requests[1]?.checkpointId).toBe("second");
    harness.pending[1]?.resolve(result(harness.requests[1]!));
    await second;
    expect(queue.pendingCheckpoints).toBe(0);
    await queue.dispose();
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
    expect(performance.now() - startedAt).toBeLessThan(250);
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
    await queue.dispose();
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

  test("retains a shared-target barrier when one queued checkpoint is cancelled", async () => {
    const harness = runtimeHarness();
    const queue = await makeQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "active" });
    const active = queue.checkpoint({
      checkpointId: "active",
      focus: "standard",
      parentTurnId: 1,
      targetSequence: 1,
    });
    await tick();

    queue.ingest(1, { type: "assistant_text_delta", text: "frozen-seq2" });
    const cancelled = queue
      .checkpoint({
        checkpointId: "cancel-shared",
        focus: "standard",
        parentTurnId: 1,
        targetSequence: 2,
      })
      .catch((error: unknown) => error);
    const survivor = queue.checkpoint({
      checkpointId: "survive-shared",
      focus: "standard",
      parentTurnId: 1,
      targetSequence: 2,
    });
    await queue.cancelCheckpointEffect("cancel-shared").pipe(Effect.runPromise);
    expect(await cancelled).toBeInstanceOf(AdvisorQueueCancelledError);
    queue.ingest(1, { type: "assistant_text_delta", text: "later-seq3" });

    harness.pending[0]?.resolve(result(harness.requests[0]!));
    await active;
    await tick();
    expect(harness.requests[1]?.checkpointId).toBe("survive-shared");
    expect(harness.requests[1]?.observations).toContain("frozen-seq2");
    expect(harness.requests[1]?.observations).not.toContain("later-seq3");
    harness.pending[1]?.resolve(result(harness.requests[1]!));
    await survivor;
    await queue.dispose();
  });

  test("retains a shared-target barrier when the oldest queued checkpoint is evicted", async () => {
    const harness = runtimeHarness();
    const queue = await makeQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "active" });
    const active = queue.checkpoint({
      checkpointId: "active",
      focus: "standard",
      parentTurnId: 1,
      targetSequence: 1,
    });
    await tick();

    queue.ingest(1, { type: "assistant_text_delta", text: "frozen-seq2" });
    const evicted = queue
      .checkpoint({
        checkpointId: "evicted-shared",
        focus: "standard",
        parentTurnId: 1,
        targetSequence: 2,
      })
      .catch((error: unknown) => error);
    const survivor = queue.checkpoint({
      checkpointId: "survive-shared",
      focus: "standard",
      parentTurnId: 1,
      targetSequence: 2,
    });
    const filler = Array.from({ length: MAX_PENDING_CHECKPOINTS - 1 }, (_, index) =>
      queue
        .checkpoint({
          checkpointId: `filler-${index}`,
          focus: "standard",
          parentTurnId: 1,
          targetSequence: 2,
        })
        .catch((error: unknown) => error),
    );
    await tick();
    expect(await evicted).toBeInstanceOf(AdvisorQueueBatchDroppedError);
    queue.ingest(1, { type: "assistant_text_delta", text: "later-seq3" });

    harness.pending[0]?.resolve(result(harness.requests[0]!));
    await active;
    await tick();
    expect(harness.requests[1]?.checkpointId).toBe("survive-shared");
    expect(harness.requests[1]?.observations).toContain("frozen-seq2");
    expect(harness.requests[1]?.observations).not.toContain("later-seq3");
    await queue.dispose();
    await Promise.allSettled([survivor, ...filler]);
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
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(AdvisorQueueCorrelationMismatchError);
        expect(failure.value).toBeInstanceOf(AdvisorQueueError);
        expect(failure.value._tag).toBe("CorrelationMismatch");
      }
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
    const dropped = await queue
      .checkpoint({ checkpointId: "drop", focus: "standard", parentTurnId: 1 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(dropped).toBeInstanceOf(AdvisorQueueBatchDroppedError);
    expect((dropped as AdvisorQueueBatchDroppedError)._tag).toBe("BatchDropped");
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
    const checkpointStarted = deferred<void>();
    (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockImplementation(() => {
      checkpointStarted.resolve(undefined);
      return failure.promise;
    });
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
    await checkpointStarted.promise;

    await queue.dispose();
    failure.reject(new Error("context overflow"));
    await rejection;

    expect(harness.runtime.checkpoint).toHaveBeenCalledOnce();
    expect(harness.runtime.abort).toHaveBeenCalledOnce();
    expect(harness.runtime.reprime).not.toHaveBeenCalled();
  });

  test("drop-oldest admission fails the evicted Deferred with BatchDropped", async () => {
    const harness = runtimeHarness();
    const queue = await makeQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "active" });
    const active = queue
      .checkpoint({ checkpointId: "active", focus: "standard", parentTurnId: 1 })
      .catch((error: unknown) => error);
    await tick();

    const queued = Array.from({ length: MAX_PENDING_CHECKPOINTS + 1 }, (_, index) =>
      queue
        .checkpoint({
          checkpointId: `queued-${index}`,
          focus: "standard",
          parentTurnId: 1,
        })
        .catch((error: unknown) => error),
    );
    await tick();

    const evicted = await queued[0];
    expect(evicted).toBeInstanceOf(AdvisorQueueBatchDroppedError);
    expect((evicted as AdvisorQueueBatchDroppedError)._tag).toBe("BatchDropped");
    expect(queue.pendingCheckpoints).toBe(MAX_PENDING_CHECKPOINTS + 1);

    await queue.dispose();
    await Promise.allSettled([active, ...queued]);
  });

  test("compacts cancelled queued tombstones so live admission capacity is reusable", async () => {
    const harness = runtimeHarness();
    const queue = await makeQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "active" });
    const active = queue
      .checkpoint({ checkpointId: "active", focus: "standard", parentTurnId: 1 })
      .catch((error: unknown) => error);
    await tick();

    for (let index = 0; index < MAX_PENDING_CHECKPOINTS + 1; index += 1) {
      const checkpointId = `cancelled-${index}`;
      const cancelled = queue
        .checkpoint({ checkpointId, focus: "standard", parentTurnId: 1 })
        .catch((error: unknown) => error);
      await tick();
      await queue.cancelCheckpointEffect(checkpointId).pipe(Effect.runPromise);
      expect(await cancelled).toBeInstanceOf(AdvisorQueueCancelledError);
    }
    expect(queue.pendingCheckpoints).toBe(1);

    const admitted = queue.checkpoint({
      checkpointId: "admitted-after-compaction",
      focus: "standard",
      parentTurnId: 1,
    });
    await tick();
    expect(queue.pendingCheckpoints).toBe(2);
    harness.pending[0]?.resolve(result(harness.requests[0]!));
    await active;
    await tick();
    expect(harness.requests[1]?.checkpointId).toBe("admitted-after-compaction");
    harness.pending[1]?.resolve(result(harness.requests[1]!));
    await expect(admitted).resolves.toMatchObject({ checkpointId: "admitted-after-compaction" });
    await queue.dispose();
  });

  test("dispose shuts down and awaits the queue-owned steering ingress across replacements", async () => {
    for (let replacement = 0; replacement < 3; replacement += 1) {
      const queue = await makeQueue(runtimeHarness().runtime);
      const ingress = (
        queue as unknown as {
          steeringIngress?: { readonly awaitShutdown: Effect.Effect<void> };
        }
      ).steeringIngress;
      expect(ingress).toBeDefined();
      await Effect.runPromise(queue.disposeEffect());
      await expect(Effect.runPromise(ingress!.awaitShutdown)).resolves.toBeUndefined();
      await queue.dispose();
    }
  });

  test("active cancellation waits for abort settlement before starting replacement work", async () => {
    const harness = runtimeHarness();
    const abortRelease = deferred<void>();
    (harness.runtime.abort as ReturnType<typeof vi.fn>).mockImplementation(
      () => abortRelease.promise,
    );
    const queue = await makeQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "first" });
    const first = queue
      .checkpoint({ checkpointId: "first", focus: "standard", parentTurnId: 1 })
      .catch((error: unknown) => error);
    await tick();
    const second = queue.checkpoint({
      checkpointId: "second",
      focus: "standard",
      parentTurnId: 1,
    });
    await tick();

    const cancellation = Effect.runPromise(queue.cancelCheckpointEffect("first"));
    await tick();
    expect(harness.runtime.abort).toHaveBeenCalledOnce();
    expect(harness.requests.map((request) => request.checkpointId)).toEqual(["first"]);
    let cancellationSettled = false;
    void cancellation.then(() => {
      cancellationSettled = true;
    });
    await tick();
    expect(cancellationSettled).toBe(false);

    abortRelease.resolve();
    await cancellation;
    expect(await first).toBeInstanceOf(AdvisorQueueCancelledError);
    await tick();
    expect(harness.requests.map((request) => request.checkpointId)).toEqual(["first", "second"]);
    harness.pending[1]?.resolve(result(harness.requests[1]!));
    await second;
    await queue.dispose();
  });

  test("interrupting active cancellation during abort still restores a reusable queue", async () => {
    const harness = runtimeHarness();
    const abortRelease = deferred<void>();
    (harness.runtime.abort as ReturnType<typeof vi.fn>).mockImplementation(
      () => abortRelease.promise,
    );
    const queue = await makeQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "first" });
    const first = queue
      .checkpoint({ checkpointId: "first", focus: "standard", parentTurnId: 1 })
      .catch((error: unknown) => error);
    await tick();
    const second = queue.checkpoint({
      checkpointId: "second",
      focus: "standard",
      parentTurnId: 1,
    });
    await tick();

    const cancellation = Effect.runFork(queue.cancelCheckpointEffect("first"));
    await tick();
    expect(harness.runtime.abort).toHaveBeenCalledOnce();
    const interrupting = Effect.runFork(Fiber.interrupt(cancellation));
    await tick();
    expect(harness.requests.map((request) => request.checkpointId)).toEqual(["first"]);

    abortRelease.resolve();
    await Effect.runPromise(Fiber.join(interrupting));
    expect(await first).toBeInstanceOf(AdvisorQueueCancelledError);
    expect(queue.pendingCheckpoints).toBe(1);
    await tick();
    expect(harness.requests.map((request) => request.checkpointId)).toEqual(["first", "second"]);
    expect(queue.hasActiveCheckpoint).toBe(true);
    harness.pending[1]?.resolve(result(harness.requests[1]!));
    await second;
    expect(queue.pendingCheckpoints).toBe(0);
    await queue.dispose();
  });

  test("reset and dispose await active abort finalizers before settling", async () => {
    for (const operation of ["reset", "dispose"] as const) {
      const harness = runtimeHarness();
      const abortRelease = deferred<void>();
      (harness.runtime.abort as ReturnType<typeof vi.fn>).mockImplementation(
        () => abortRelease.promise,
      );
      const queue = await makeQueue(harness.runtime);
      queue.ingest(1, { type: "user", text: operation });
      const checkpoint = queue
        .checkpoint({ checkpointId: operation, focus: "standard", parentTurnId: 1 })
        .catch((error: unknown) => error);
      await tick();

      const settlement = operation === "reset" ? queue.reset("seed") : queue.dispose();
      let settled = false;
      void settlement.then(() => {
        settled = true;
      });
      await tick();
      expect(harness.runtime.abort).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      if (operation === "reset") expect(harness.runtime.reprime).not.toHaveBeenCalled();

      abortRelease.resolve();
      await settlement;
      if (operation === "reset") expect(harness.runtime.reprime).toHaveBeenCalledOnce();
      await checkpoint;
      if (operation === "reset") await queue.dispose();
    }
  });

  test("active cancellation fails with Cancelled and interrupts the runtime", async () => {
    const harness = runtimeHarness();
    const queue = await makeQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "cancel" });
    const checkpoint = queue
      .checkpoint({ checkpointId: "cancel-me", focus: "standard", parentTurnId: 1 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await tick();
    await queue.cancelCheckpointEffect("cancel-me").pipe(Effect.runPromise);
    const cancelled = await checkpoint;
    expect(cancelled).toBeInstanceOf(AdvisorQueueCancelledError);
    expect((cancelled as AdvisorQueueCancelledError)._tag).toBe("Cancelled");
    expect(harness.runtime.abort).toHaveBeenCalledOnce();
    await queue.dispose();
  });

  test("reports ResetRequired when recovery has no current re-prime state", async () => {
    const harness = runtimeHarness();
    (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("context overflow"),
    );
    const queue = await makeQueue(harness.runtime);
    queue.ingest(1, { type: "user", text: "overflow" });
    const failure = await queue
      .checkpoint({ checkpointId: "reset", focus: "standard", parentTurnId: 1 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(AdvisorQueueResetRequiredError);
    expect((failure as AdvisorQueueResetRequiredError)._tag).toBe("ResetRequired");
    await queue.dispose();
  });

  test.each([
    ["BacklogExceeded", AdvisorQueueBacklogExceededError],
    ["StaleEpoch", AdvisorQueueStaleEpochError],
  ] as const)("keeps the %s compatibility tag schema-backed", (tag, ErrorClass) => {
    const error = new ErrorClass({ message: "characterized" });
    expect(error._tag).toBe(tag);
    expect(error).toBeInstanceOf(AdvisorQueueError);
  });

  test("maps post-disposal synchronous ingestion to the Disposed queue tag", async () => {
    const queue = await makeQueue(runtimeHarness().runtime);
    await queue.dispose();
    try {
      queue.ingest(1, { type: "user", text: "late" });
      throw new Error("expected disposed ingestion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AdvisorQueueDisposedError);
      expect((error as AdvisorQueueDisposedError)._tag).toBe("Disposed");
    }
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
    await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
    const rejection = checkpoint.then(
      () => undefined,
      (error: unknown) => error,
    );
    await queue.reset("new branch", "state");
    const request = harness.requests[0];
    if (!request) throw new Error("missing request");
    harness.pending[0]?.resolve(result(request));
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/stale|reset/i);

    expect(harness.calls).toContain("abort");
    expect(harness.runtime.reprime).toHaveBeenCalledWith("new branch", "state");
    expect(queue.processedThrough).toBe(0);
  });
});
