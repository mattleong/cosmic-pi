// Promise-shaped driver characterization intentionally remains at this test boundary.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Scope from "effect/Scope";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { deferred, tick } from "./support/async.ts";
import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeServiceContract,
  AdvisorRuntimeStartOptions,
} from "../src/runtime/runtime.ts";

/** Test-local Promise-shaped harness driver wrapped into the Effect service below. */
interface AdvisorRuntimeDriver {
  readonly activeToolNames: readonly string[];
  start(options: AdvisorRuntimeStartOptions): Promise<void>;
  checkpoint(request: AdvisorCheckpointRequest): Promise<AdvisorCheckpoint>;
  steer(observations: string): Promise<boolean>;
  reprime(seed: string, stateSummary?: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
import {
  AdvisorQueueBatchDroppedError,
  AdvisorQueueCancelledError,
  AdvisorQueueCorrelationMismatchError,
  AdvisorQueueDisposedError,
  AdvisorQueueResetRequiredError,
} from "../src/queue/errors.ts";
import {
  AdvisorReviewQueueService,
  type AdvisorReviewQueue,
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
};

const activeQueueCleanups = new Set<() => Promise<void>>();

afterEach(() =>
  Promise.all([...activeQueueCleanups].map((cleanup) => cleanup())).then(() => undefined),
);

function makeQueue(
  driver: AdvisorRuntimeDriver,
  options: AdvisorReviewQueueOptions = {},
): Promise<TestQueue> {
  const runtime: AdvisorRuntimeServiceContract = {
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
  return managed
    .runPromise(AdvisorReviewQueueService)
    .then((service) => managed.runPromise(service.make(runtime, options)))
    .then((made) => {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const queue = made as TestQueue;
      const dispose = (): Promise<void> => {
        if (!activeQueueCleanups.delete(dispose)) return Promise.resolve();
        return managed.runPromise(queue.disposeEffect()).finally(() => managed.dispose());
      };
      activeQueueCleanups.add(dispose);
      queue.checkpoint = (request) => managed.runPromise(queue.checkpointEffect(request));
      queue.dispose = dispose;
      return queue;
    });
}

const modelError = <ErrorInput>(error: ErrorInput) =>
  error instanceof AdvisorModelError
    ? error
    : new AdvisorModelError({ message: error instanceof Error ? error.message : "test failure" });

function result(request: AdvisorCheckpointRequest): AdvisorCheckpoint {
  return {
    checkpointId: request.checkpointId,
    processedThrough: request.processedThrough,
    stateSummary: "compact state",
    verdict: "pass",
    summary: "No issue.",
    suggestions: [],
    findings: [],
  };
}

function runtimeHarness() {
  const calls: string[] = [];
  const pending: Array<ReturnType<typeof deferred<AdvisorCheckpoint>>> = [];
  const requests: AdvisorCheckpointRequest[] = [];
  const runtime: AdvisorRuntimeDriver = {
    activeToolNames: [],
    start: vi.fn(() => Promise.resolve(undefined)),
    checkpoint: vi.fn((request: AdvisorCheckpointRequest) => {
      calls.push(`checkpoint:${request.checkpointId}`);
      requests.push(request);
      const wait = deferred<AdvisorCheckpoint>();
      pending.push(wait);
      return wait.promise;
    }),
    steer: vi.fn(() => {
      calls.push("steer");
      return Promise.resolve(true);
    }),
    reprime: vi.fn(() => Promise.resolve(undefined)),
    abort: vi.fn(() => {
      calls.push("abort");
      return Promise.resolve(undefined);
    }),
    dispose: vi.fn(() => Promise.resolve(undefined)),
  };
  return { calls, pending, requests, runtime };
}

const invoke = <ValueInput>(value: ValueInput): Effect.Effect<void> =>
  Effect.promise(() => Promise.resolve(value).then(() => undefined));

/** Captures the synchronous ingest throw at this Promise-shaped test boundary. */
const ingestAfterDisposalOutcome = (queue: TestQueue) => {
  try {
    queue.ingest(1, { type: "user", text: "late" });
    return undefined;
  } catch (error) {
    return error;
  }
};

describe("AdvisorReviewQueue", () => {
  it.effect("ManagedRuntime disposal alone finalizes an acquired queue exactly once", () =>
    Effect.gen(function* () {
      let disposals = 0;
      const runtime: AdvisorRuntimeServiceContract = {
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
      const service = yield* Effect.promise(() => managed.runPromise(AdvisorReviewQueueService));
      yield* Effect.promise(() => managed.runPromise(service.make(runtime)));
      yield* Effect.promise(() => managed.dispose());
      expect(disposals).toBe(1);
    }),
  );

  it.effect("explicit disposal closes the queue child scope before the layer scope", () =>
    Effect.gen(function* () {
      let disposals = 0;
      const runtime: AdvisorRuntimeServiceContract = {
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
      const service = yield* Effect.promise(() => managed.runPromise(AdvisorReviewQueueService));
      const queue = yield* Effect.promise(() => managed.runPromise(service.make(runtime)));
      const scopeDescriptor = Object.getOwnPropertyDescriptor(queue, "resourceScope");
      if (!scopeDescriptor || !("value" in scopeDescriptor)) throw new Error("missing queue scope");
      const queueScope: Scope.Closeable = scopeDescriptor.value;

      expect(queueScope.state._tag).not.toBe("Closed");
      yield* Effect.promise(() => managed.runPromise(queue.disposeEffect()));
      expect(queueScope.state._tag).toBe("Closed");
      expect(disposals).toBe(1);

      yield* Effect.promise(() => managed.dispose());
      expect(disposals).toBe(1);
    }),
  );

  it.effect("serializes two checkpoints and does not ordinarily abort the first", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "request" });
      const first = queue.checkpoint({ checkpointId: "one", focus: "standard", parentTurnId: 1 });
      const second = queue.checkpoint({ checkpointId: "two", focus: "standard", parentTurnId: 1 });
      yield* Effect.promise(() => tick());

      expect(harness.calls).toEqual(["checkpoint:one"]);
      expect(queue.pendingCheckpoints).toBe(2);
      expect(queue.activeToolNames).toEqual([]);
      expect(harness.runtime.abort).not.toHaveBeenCalled();
      const firstRequest = harness.requests[0];
      if (!firstRequest) throw new Error("missing request");
      harness.pending[0]?.resolve(result(firstRequest));
      yield* Effect.promise(() => expect(first).resolves.toMatchObject({ checkpointId: "one" }));
      yield* Effect.promise(() => tick());
      expect(harness.calls).toEqual(["checkpoint:one", "checkpoint:two"]);
      const secondRequest = harness.requests[1];
      if (!secondRequest) throw new Error("missing second request");
      harness.pending[1]?.resolve(result(secondRequest));
      yield* Effect.promise(() => expect(second).resolves.toMatchObject({ checkpointId: "two" }));
      expect(queue.pendingCheckpoints).toBe(0);
    }),
  );

  it.effect(
    "interrupting an active checkpoint caller aborts owned work and leaves the queue reusable",
    () =>
      Effect.gen(function* () {
        const harness = runtimeHarness();
        const settled = vi.fn();
        const queue = yield* Effect.promise(() =>
          makeQueue(harness.runtime, { onCheckpointSettled: settled }),
        );
        queue.ingest(1, { type: "user", text: "interrupted" });
        const caller = yield* Effect.forkChild(
          queue.checkpointEffect({
            checkpointId: "interrupted",
            focus: "standard",
            parentTurnId: 1,
          }),
        );
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(harness.runtime.checkpoint).toHaveBeenCalledOnce()),
        );

        expect(queue.pendingCheckpoints).toBe(1);
        yield* Fiber.interrupt(caller);
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(harness.runtime.abort).toHaveBeenCalledOnce()),
        );
        expect(queue.pendingCheckpoints).toBe(0);
        expect(queue.hasActiveCheckpoint).toBe(false);
        expect(settled).toHaveBeenCalledOnce();

        queue.ingest(2, { type: "user", text: "later" });
        const later = queue.checkpoint({
          checkpointId: "later",
          focus: "standard",
          parentTurnId: 2,
        });
        yield* Effect.promise(() => tick());
        expect(harness.requests.map((request) => request.checkpointId)).toEqual([
          "interrupted",
          "later",
        ]);
        harness.pending[1]?.resolve(result(harness.requests[1]!));
        yield* Effect.promise(() =>
          expect(later).resolves.toMatchObject({ checkpointId: "later" }),
        );
        expect(queue.pendingCheckpoints).toBe(0);
        yield* Effect.promise(() => queue.dispose());
      }),
  );

  it.effect("interrupting a queued checkpoint caller removes only its admitted waiter", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "active" });
      const active = queue.checkpoint({
        checkpointId: "active",
        focus: "standard",
        parentTurnId: 1,
      });
      yield* Effect.promise(() => tick());
      const queuedCaller = yield* Effect.forkChild(
        queue.checkpointEffect({
          checkpointId: "queued",
          focus: "standard",
          parentTurnId: 1,
        }),
      );
      yield* Effect.promise(() => tick());

      expect(queue.pendingCheckpoints).toBe(2);
      yield* Fiber.interrupt(queuedCaller);
      expect(queue.pendingCheckpoints).toBe(1);
      expect(harness.runtime.abort).not.toHaveBeenCalled();

      harness.pending[0]?.resolve(result(harness.requests[0]!));
      yield* invoke(active);
      expect(queue.pendingCheckpoints).toBe(0);
      yield* Effect.promise(() => queue.dispose());
    }),
  );

  it.effect("interrupting after atomic settlement does not decrement the next queued waiter", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      const settlementReached = deferred<void>();
      const releaseCompletion = deferred<void>();
      const prototype = Object.getPrototypeOf(queue);
      const settleClaimedWaiterEffect: (
        waiter: QueuedCheckpoint,
        processedThrough?: number,
      ) => Effect.Effect<boolean> = prototype.settleClaimedWaiterEffect.bind(queue);
      Object.defineProperty(queue, "settleClaimedWaiterEffect", {
        configurable: true,
        value: (waiter: QueuedCheckpoint, processedThrough?: number) =>
          settleClaimedWaiterEffect(waiter, processedThrough).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                settlementReached.resolve();
              }),
            ),
            Effect.flatMap((settled) =>
              Effect.promise(() => releaseCompletion.promise).pipe(Effect.as(settled)),
            ),
          ),
      });

      queue.ingest(1, { type: "user", text: "first" });
      const firstCaller = yield* Effect.forkChild(
        queue.checkpointEffect({ checkpointId: "first", focus: "standard", parentTurnId: 1 }),
        { startImmediately: true },
      );
      yield* Effect.promise(() => tick());
      const second = queue.checkpoint({
        checkpointId: "second",
        focus: "standard",
        parentTurnId: 1,
      });
      yield* Effect.promise(() => tick());
      expect(queue.pendingCheckpoints).toBe(2);

      harness.pending[0]?.resolve(result(harness.requests[0]!));
      yield* Effect.promise(() => settlementReached.promise);
      expect(queue.hasActiveCheckpoint).toBe(false);
      expect(queue.pendingCheckpoints).toBe(1);
      yield* Fiber.interrupt(firstCaller);
      expect(queue.pendingCheckpoints).toBe(1);
      expect(harness.runtime.abort).not.toHaveBeenCalled();

      releaseCompletion.resolve();
      yield* Effect.promise(() => tick());
      expect(harness.requests[1]?.checkpointId).toBe("second");
      harness.pending[1]?.resolve(result(harness.requests[1]!));
      yield* invoke(second);
      expect(queue.pendingCheckpoints).toBe(0);
      yield* Effect.promise(() => queue.dispose());
    }),
  );

  it.effect("coalesces and live-steers bounded deltas without committing them", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "assistant_text_delta", text: "before" });
      const checkpoint = queue.checkpoint({
        checkpointId: "one",
        focus: "standard",
        parentTurnId: 1,
      });
      yield* Effect.promise(() => tick());

      const startedAt = performance.now();
      for (let index = 0; index < 2_000; index += 1) {
        queue.ingest(1, { type: "assistant_thinking_delta", text: "x" });
      }
      expect(performance.now() - startedAt).toBeLessThan(250);
      yield* Effect.promise(() => tick());
      expect(harness.runtime.steer).toHaveBeenCalledOnce();
      expect(harness.runtime.steer).toHaveBeenCalledWith(
        expect.stringContaining("assistant_thinking_delta"),
      );
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const steering = String(
        (harness.runtime.steer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
      );
      expect(steering.length).toBeLessThan(20_000);
      expect(harness.runtime.abort).not.toHaveBeenCalled();
      const request = harness.requests[0];
      if (!request) throw new Error("missing request");
      harness.pending[0]?.resolve(result(request));
      yield* invoke(checkpoint);
      expect(queue.processedThrough).toBe(1);
      expect(queue.backlog).toBeGreaterThan(0);

      const catchUp = queue.checkpoint({
        checkpointId: "two",
        focus: "standard",
        parentTurnId: 1,
      });
      yield* Effect.promise(() => tick());
      expect(harness.requests[1]?.observations).toContain("assistant_thinking_delta");
      harness.pending[1]?.resolve(result(harness.requests[1]!));
      yield* invoke(catchUp);
      yield* Effect.promise(() => queue.dispose());
    }),
  );

  it.effect("drains an observation that arrives while live steering is unresolved", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const firstSteer = deferred<boolean>();
      const secondSteer = deferred<boolean>();
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      (harness.runtime.steer as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => firstSteer.promise)
        .mockImplementationOnce(() => secondSteer.promise);
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "assistant_text_delta", text: "checkpoint seed" });
      const checkpoint = queue.checkpoint({
        checkpointId: "one",
        focus: "standard",
        parentTurnId: 1,
      });
      yield* Effect.promise(() => tick());

      queue.ingest(1, { type: "assistant_text_delta", text: "first live delta" });
      yield* Effect.promise(() => tick());
      expect(harness.runtime.steer).toHaveBeenCalledOnce();
      queue.ingest(1, { type: "assistant_text_delta", text: "second in-flight delta" });
      firstSteer.resolve(true);
      yield* Effect.promise(() => tick());

      expect(harness.runtime.steer).toHaveBeenCalledTimes(2);
      expect(harness.runtime.steer).toHaveBeenLastCalledWith(
        expect.stringContaining("second in-flight delta"),
      );
      secondSteer.resolve(true);
      const request = harness.requests[0];
      if (!request) throw new Error("missing request");
      harness.pending[0]?.resolve(result(request));
      yield* invoke(checkpoint);
      yield* Effect.promise(() => queue.dispose());
    }),
  );

  it.effect("freezes exact pre-pump checkpoint barriers across a seq1/seq2 coalescing race", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "assistant_text_delta", text: "seq1" });
      const first = queue.checkpoint({ checkpointId: "one", focus: "standard", parentTurnId: 1 });
      queue.ingest(1, { type: "assistant_text_delta", text: "seq2" });
      const second = queue.checkpoint({ checkpointId: "two", focus: "standard", parentTurnId: 1 });
      yield* Effect.promise(() => tick());

      expect(harness.requests[0]?.processedThrough).toBe(1);
      expect(harness.requests[0]?.observations).toContain("seq1");
      expect(harness.requests[0]?.observations).not.toContain("seq2");
      harness.pending[0]?.resolve(result(harness.requests[0]!));
      yield* invoke(first);
      yield* Effect.promise(() => tick());
      expect(harness.requests[1]?.processedThrough).toBe(2);
      expect(harness.requests[1]?.observations).toContain("seq2");
      harness.pending[1]?.resolve(result(harness.requests[1]!));
      yield* invoke(second);
    }),
  );

  it.effect("retains a shared-target barrier when one queued checkpoint is cancelled", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "active" });
      const active = queue.checkpoint({
        checkpointId: "active",
        focus: "standard",
        parentTurnId: 1,
        targetSequence: 1,
      });
      yield* Effect.promise(() => tick());

      queue.ingest(1, { type: "assistant_text_delta", text: "frozen-seq2" });
      const cancelled = queue
        .checkpoint({
          checkpointId: "cancel-shared",
          focus: "standard",
          parentTurnId: 1,
          targetSequence: 2,
        })
        .catch((error) => error);
      const survivor = queue.checkpoint({
        checkpointId: "survive-shared",
        focus: "standard",
        parentTurnId: 1,
        targetSequence: 2,
      });
      yield* queue.cancelCheckpointEffect("cancel-shared");
      expect(yield* Effect.promise(() => cancelled)).toBeInstanceOf(AdvisorQueueCancelledError);
      queue.ingest(1, { type: "assistant_text_delta", text: "later-seq3" });

      harness.pending[0]?.resolve(result(harness.requests[0]!));
      yield* invoke(active);
      yield* Effect.promise(() => tick());
      expect(harness.requests[1]?.checkpointId).toBe("survive-shared");
      expect(harness.requests[1]?.observations).toContain("frozen-seq2");
      expect(harness.requests[1]?.observations).not.toContain("later-seq3");
      harness.pending[1]?.resolve(result(harness.requests[1]!));
      yield* invoke(survivor);
      yield* Effect.promise(() => queue.dispose());
    }),
  );

  it.effect("retains a shared-target barrier when the oldest queued checkpoint is evicted", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "active" });
      const active = queue.checkpoint({
        checkpointId: "active",
        focus: "standard",
        parentTurnId: 1,
        targetSequence: 1,
      });
      yield* Effect.promise(() => tick());

      queue.ingest(1, { type: "assistant_text_delta", text: "frozen-seq2" });
      const evicted = queue
        .checkpoint({
          checkpointId: "evicted-shared",
          focus: "standard",
          parentTurnId: 1,
          targetSequence: 2,
        })
        .catch((error) => error);
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
          .catch((error) => error),
      );
      yield* Effect.promise(() => tick());
      expect(yield* Effect.promise(() => evicted)).toBeInstanceOf(AdvisorQueueBatchDroppedError);
      queue.ingest(1, { type: "assistant_text_delta", text: "later-seq3" });

      harness.pending[0]?.resolve(result(harness.requests[0]!));
      yield* invoke(active);
      yield* Effect.promise(() => tick());
      expect(harness.requests[1]?.checkpointId).toBe("survive-shared");
      expect(harness.requests[1]?.observations).toContain("frozen-seq2");
      expect(harness.requests[1]?.observations).not.toContain("later-seq3");
      yield* Effect.promise(() => queue.dispose());
      yield* Effect.promise(() => Promise.allSettled([survivor, ...filler]));
    }),
  );

  it.effect("freezes seq1 tool_update before seq2 same-tool replacement in the pre-pump race", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "tool_update", toolCallId: "c", toolName: "read", update: "seq1" });
      const first = queue.checkpoint({ checkpointId: "one", focus: "standard", parentTurnId: 1 });
      queue.ingest(1, { type: "tool_update", toolCallId: "c", toolName: "read", update: "seq2" });
      const second = queue.checkpoint({ checkpointId: "two", focus: "standard", parentTurnId: 1 });
      yield* Effect.promise(() => tick());

      expect(harness.requests[0]?.processedThrough).toBe(1);
      expect(harness.requests[0]?.observations).toContain("seq1");
      expect(harness.requests[0]?.observations).not.toContain("seq2");
      harness.pending[0]?.resolve(result(harness.requests[0]!));
      yield* invoke(first);
      yield* Effect.promise(() => tick());
      expect(harness.requests[1]?.processedThrough).toBe(2);
      expect(harness.requests[1]?.observations).toContain("seq2");
      harness.pending[1]?.resolve(result(harness.requests[1]!));
      yield* invoke(second);
    }),
  );

  it.effect("retains failed or idle-race live delivery for the next coherent checkpoint", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      (harness.runtime.steer as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "initial" });
      const first = queue.checkpoint({ checkpointId: "one", focus: "standard", parentTurnId: 1 });
      yield* Effect.promise(() => tick());
      queue.ingest(1, { type: "assistant_text_delta", text: "late-must-survive" });
      yield* Effect.promise(() => tick());
      harness.pending[0]?.resolve(result(harness.requests[0]!));
      yield* invoke(first);

      expect(queue.processedThrough).toBe(1);
      const retry = queue.checkpoint({ checkpointId: "two", focus: "standard", parentTurnId: 1 });
      yield* Effect.promise(() => tick());
      expect(harness.requests[1]?.processedThrough).toBe(2);
      expect(harness.requests[1]?.observations).toContain("late-must-survive");
      harness.pending[1]?.resolve(result(harness.requests[1]!));
      yield* invoke(retry);
      expect(queue.processedThrough).toBe(2);
    }),
  );

  it.effect("requeues an in-flight observation batch after checkpoint failure", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "must survive" });
      const failed = queue.checkpoint({
        checkpointId: "failed",
        focus: "standard",
        parentTurnId: 1,
      });
      yield* Effect.promise(() => tick());
      for (let index = 0; index < 1_000; index += 1) {
        queue.ingest(1, { type: "assistant_text_delta", text: `later-${index}` });
      }
      harness.pending[0]?.resolve({ ...result(harness.requests[0]!), checkpointId: "wrong" });
      yield* Effect.promise(() => expect(failed).rejects.toThrow("correlation"));

      const retry = queue.checkpoint({ checkpointId: "retry", focus: "standard", parentTurnId: 1 });
      yield* Effect.promise(() => tick());
      expect(harness.requests[1]?.observations).toContain("must survive");
      harness.pending[1]?.resolve(result(harness.requests[1]!));
      yield* invoke(retry);
      expect(queue.processedThrough).toBe(1_001);
    }),
  );

  it.effect("reports correlation validation as a typed queue failure, not a defect", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockImplementation(
        (request: AdvisorCheckpointRequest) =>
          Promise.resolve({ ...result(request), checkpointId: "wrong" }),
      );
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "request" });
      const exit = yield* Effect.exit(
        queue.checkpointEffect({ checkpointId: "expected", focus: "standard", parentTurnId: 1 }),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failure = Cause.findErrorOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(AdvisorQueueCorrelationMismatchError);
          expect(failure.value._tag).toBe("CorrelationMismatch");
        }
        expect(Cause.hasDies(exit.cause)).toBe(false);
      }
      yield* Effect.promise(() => queue.dispose());
    }),
  );

  it.effect("preserves typed provider failure text for parent classification", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Advisor authentication failed; credential unavailable."),
      );
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "request" });
      yield* Effect.promise(() =>
        expect(
          queue.checkpoint({ checkpointId: "auth", focus: "standard", parentTurnId: 1 }),
        ).rejects.toThrow(/authentication.*credential/i),
      );
    }),
  );

  it.effect("re-primes at the current cursor and bounds overflow retry to one", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      let attempt = 0;
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockImplementation(
        (request: AdvisorCheckpointRequest) => {
          attempt += 1;
          if (attempt === 1) return Promise.reject(new Error("context overflow"));
          return Promise.resolve(result(request));
        },
      );
      const reset = vi.fn();
      const queue = yield* Effect.promise(() =>
        makeQueue(harness.runtime, {
          getReprimeState: () => ({ seed: "current cursor", stateSummary: "compact" }),
          onRuntimeReset: reset,
        }),
      );
      queue.ingest(1, { type: "user", text: "bounded batch" });
      yield* Effect.promise(() =>
        expect(
          queue.checkpoint({ checkpointId: "overflow", focus: "standard", parentTurnId: 1 }),
        ).resolves.toMatchObject({ checkpointId: "overflow" }),
      );
      expect(harness.runtime.reprime).toHaveBeenCalledTimes(1);
      expect(harness.runtime.reprime).toHaveBeenCalledWith("current cursor", "compact");
      expect(reset).toHaveBeenCalledOnce();
    }),
  );

  it.effect("drops a repeated maximum-response batch and a later small checkpoint succeeds", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      let attempt = 0;
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockImplementation(
        (request: AdvisorCheckpointRequest) => {
          attempt += 1;
          if (attempt <= 2)
            return Promise.reject(
              new Error("Advisor checkpoint exceeds the maximum response size."),
            );
          return Promise.resolve(result(request));
        },
      );
      const queue = yield* Effect.promise(() =>
        makeQueue(harness.runtime, {
          getReprimeState: () => ({ seed: "current cursor", stateSummary: "compact" }),
        }),
      );
      queue.ingest(1, { type: "user", text: "oversized" });
      const dropped = yield* Effect.promise(() =>
        queue.checkpoint({ checkpointId: "drop", focus: "standard", parentTurnId: 1 }).then(
          () => undefined,
          (error) => error,
        ),
      );
      expect(dropped).toBeInstanceOf(AdvisorQueueBatchDroppedError);
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((dropped as AdvisorQueueBatchDroppedError)._tag).toBe("BatchDropped");
      expect(queue.backlog).toBe(0);
      queue.ingest(2, { type: "user", text: "small" });
      yield* Effect.promise(() =>
        expect(
          queue.checkpoint({ checkpointId: "small", focus: "standard", parentTurnId: 2 }),
        ).resolves.toMatchObject({ checkpointId: "small" }),
      );
      expect(harness.runtime.reprime).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("disposal prevents a rejected checkpoint from re-priming or retrying", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const failure = deferred<AdvisorCheckpoint>();
      const checkpointStarted = deferred<void>();
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockImplementation(() => {
        checkpointStarted.resolve(undefined);
        return failure.promise;
      });
      const queue = yield* Effect.promise(() =>
        makeQueue(harness.runtime, {
          getReprimeState: () => ({ seed: "obsolete cursor", stateSummary: "obsolete state" }),
        }),
      );
      queue.ingest(1, { type: "user", text: "old request" });
      const checkpoint = queue.checkpoint({
        checkpointId: "obsolete",
        focus: "standard",
        parentTurnId: 1,
      });
      const rejection = expect(checkpoint).rejects.toThrow(/disposed|stale/);
      yield* Effect.promise(() => checkpointStarted.promise);

      yield* Effect.promise(() => queue.dispose());
      failure.reject(new Error("context overflow"));
      yield* Effect.promise(() => rejection);

      expect(harness.runtime.checkpoint).toHaveBeenCalledOnce();
      expect(harness.runtime.abort).toHaveBeenCalledOnce();
      expect(harness.runtime.reprime).not.toHaveBeenCalled();
    }),
  );

  it.effect("drop-oldest admission fails the evicted Deferred with BatchDropped", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "active" });
      const active = queue
        .checkpoint({ checkpointId: "active", focus: "standard", parentTurnId: 1 })
        .catch((error) => error);
      yield* Effect.promise(() => tick());

      const queued = Array.from({ length: MAX_PENDING_CHECKPOINTS + 1 }, (_, index) =>
        queue
          .checkpoint({
            checkpointId: `queued-${index}`,
            focus: "standard",
            parentTurnId: 1,
          })
          .catch((error) => error),
      );
      yield* Effect.promise(() => tick());

      const evicted = yield* Effect.promise(() => queued[0]!);
      expect(evicted).toBeInstanceOf(AdvisorQueueBatchDroppedError);
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((evicted as AdvisorQueueBatchDroppedError)._tag).toBe("BatchDropped");
      expect(queue.pendingCheckpoints).toBe(MAX_PENDING_CHECKPOINTS + 1);

      yield* Effect.promise(() => queue.dispose());
      yield* Effect.promise(() => Promise.allSettled([active, ...queued]));
    }),
  );

  it.effect("compacts cancelled queued tombstones so live admission capacity is reusable", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "active" });
      const active = queue
        .checkpoint({ checkpointId: "active", focus: "standard", parentTurnId: 1 })
        .catch((error) => error);
      yield* Effect.promise(() => tick());

      for (let index = 0; index < MAX_PENDING_CHECKPOINTS + 1; index += 1) {
        const checkpointId = `cancelled-${index}`;
        const cancelled = queue
          .checkpoint({ checkpointId, focus: "standard", parentTurnId: 1 })
          .catch((error) => error);
        yield* Effect.promise(() => tick());
        yield* queue.cancelCheckpointEffect(checkpointId);
        expect(yield* Effect.promise(() => cancelled)).toBeInstanceOf(AdvisorQueueCancelledError);
      }
      expect(queue.pendingCheckpoints).toBe(1);

      const admitted = queue.checkpoint({
        checkpointId: "admitted-after-compaction",
        focus: "standard",
        parentTurnId: 1,
      });
      yield* Effect.promise(() => tick());
      expect(queue.pendingCheckpoints).toBe(2);
      harness.pending[0]?.resolve(result(harness.requests[0]!));
      yield* invoke(active);
      yield* Effect.promise(() => tick());
      expect(harness.requests[1]?.checkpointId).toBe("admitted-after-compaction");
      harness.pending[1]?.resolve(result(harness.requests[1]!));
      yield* Effect.promise(() =>
        expect(admitted).resolves.toMatchObject({ checkpointId: "admitted-after-compaction" }),
      );
      yield* Effect.promise(() => queue.dispose());
    }),
  );

  it.effect(
    "dispose shuts down and awaits the queue-owned steering ingress across replacements",
    () =>
      Effect.gen(function* () {
        for (let replacement = 0; replacement < 3; replacement += 1) {
          const queue = yield* Effect.promise(() => makeQueue(runtimeHarness().runtime));
          const ingressDescriptor = Object.getOwnPropertyDescriptor(queue, "steeringIngress");
          const ingress: { readonly awaitShutdown: Effect.Effect<void> } | undefined =
            ingressDescriptor && "value" in ingressDescriptor ? ingressDescriptor.value : undefined;
          expect(ingress).toBeDefined();
          yield* queue.disposeEffect();
          yield* ingress!.awaitShutdown;
          yield* Effect.promise(() => queue.dispose());
        }
      }),
  );

  it.effect("active cancellation waits for abort settlement before starting replacement work", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const abortRelease = deferred<void>();
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      (harness.runtime.abort as ReturnType<typeof vi.fn>).mockImplementation(
        () => abortRelease.promise,
      );
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "first" });
      const first = queue
        .checkpoint({ checkpointId: "first", focus: "standard", parentTurnId: 1 })
        .catch((error) => error);
      yield* Effect.promise(() => tick());
      const second = queue.checkpoint({
        checkpointId: "second",
        focus: "standard",
        parentTurnId: 1,
      });
      yield* Effect.promise(() => tick());

      const cancellation = yield* Effect.forkChild(queue.cancelCheckpointEffect("first"), {
        startImmediately: true,
      });
      yield* Effect.promise(() => tick());
      expect(harness.runtime.abort).toHaveBeenCalledOnce();
      expect(harness.requests.map((request) => request.checkpointId)).toEqual(["first"]);
      yield* Effect.promise(() => tick());
      expect(cancellation.pollUnsafe()).toBeUndefined();

      abortRelease.resolve();
      yield* Fiber.join(cancellation);
      expect(yield* Effect.promise(() => first)).toBeInstanceOf(AdvisorQueueCancelledError);
      yield* Effect.promise(() => tick());
      expect(harness.requests.map((request) => request.checkpointId)).toEqual(["first", "second"]);
      harness.pending[1]?.resolve(result(harness.requests[1]!));
      yield* invoke(second);
      yield* Effect.promise(() => queue.dispose());
    }),
  );

  it.effect("interrupting active cancellation during abort still restores a reusable queue", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const abortRelease = deferred<void>();
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      (harness.runtime.abort as ReturnType<typeof vi.fn>).mockImplementation(
        () => abortRelease.promise,
      );
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "first" });
      const first = queue
        .checkpoint({ checkpointId: "first", focus: "standard", parentTurnId: 1 })
        .catch((error) => error);
      yield* Effect.promise(() => tick());
      const second = queue.checkpoint({
        checkpointId: "second",
        focus: "standard",
        parentTurnId: 1,
      });
      yield* Effect.promise(() => tick());

      const cancellation = yield* Effect.forkChild(queue.cancelCheckpointEffect("first"), {
        startImmediately: true,
      });
      yield* Effect.promise(() => tick());
      expect(harness.runtime.abort).toHaveBeenCalledOnce();
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(cancellation), {
        startImmediately: true,
      });
      yield* Effect.promise(() => tick());
      expect(harness.requests.map((request) => request.checkpointId)).toEqual(["first"]);

      abortRelease.resolve();
      yield* Fiber.join(interrupting);
      expect(yield* Effect.promise(() => first)).toBeInstanceOf(AdvisorQueueCancelledError);
      expect(queue.pendingCheckpoints).toBe(1);
      yield* Effect.promise(() => tick());
      expect(harness.requests.map((request) => request.checkpointId)).toEqual(["first", "second"]);
      expect(queue.hasActiveCheckpoint).toBe(true);
      harness.pending[1]?.resolve(result(harness.requests[1]!));
      yield* invoke(second);
      expect(queue.pendingCheckpoints).toBe(0);
      yield* Effect.promise(() => queue.dispose());
    }),
  );

  it.effect("dispose awaits active abort finalizers before settling", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const abortRelease = deferred<void>();
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      (harness.runtime.abort as ReturnType<typeof vi.fn>).mockImplementation(
        () => abortRelease.promise,
      );
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "dispose" });
      const checkpoint = queue
        .checkpoint({ checkpointId: "dispose", focus: "standard", parentTurnId: 1 })
        .catch((error) => error);
      yield* Effect.promise(() => tick());

      const settlement = queue.dispose();
      let settled = false;
      void settlement.then(() => {
        settled = true;
      });
      yield* Effect.promise(() => tick());
      expect(harness.runtime.abort).toHaveBeenCalledOnce();
      expect(settled).toBe(false);

      abortRelease.resolve();
      yield* invoke(settlement);
      yield* invoke(checkpoint);
    }),
  );

  it.effect("active cancellation fails with Cancelled and interrupts the runtime", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "cancel" });
      const checkpoint = queue
        .checkpoint({ checkpointId: "cancel-me", focus: "standard", parentTurnId: 1 })
        .then(
          () => undefined,
          (error) => error,
        );
      yield* Effect.promise(() => tick());
      yield* queue.cancelCheckpointEffect("cancel-me");
      const cancelled = yield* Effect.promise(() => checkpoint);
      expect(cancelled).toBeInstanceOf(AdvisorQueueCancelledError);
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((cancelled as AdvisorQueueCancelledError)._tag).toBe("Cancelled");
      expect(harness.runtime.abort).toHaveBeenCalledOnce();
      yield* Effect.promise(() => queue.dispose());
    }),
  );

  it.effect("reports ResetRequired when recovery has no current re-prime state", () =>
    Effect.gen(function* () {
      const harness = runtimeHarness();
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      (harness.runtime.checkpoint as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("context overflow"),
      );
      const queue = yield* Effect.promise(() => makeQueue(harness.runtime));
      queue.ingest(1, { type: "user", text: "overflow" });
      const failure = yield* Effect.promise(() =>
        queue.checkpoint({ checkpointId: "reset", focus: "standard", parentTurnId: 1 }).then(
          () => undefined,
          (error) => error,
        ),
      );
      expect(failure).toBeInstanceOf(AdvisorQueueResetRequiredError);
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((failure as AdvisorQueueResetRequiredError)._tag).toBe("ResetRequired");
      yield* Effect.promise(() => queue.dispose());
    }),
  );

  it.effect("maps post-disposal synchronous ingestion to the Disposed queue tag", () =>
    Effect.gen(function* () {
      const queue = yield* Effect.promise(() => makeQueue(runtimeHarness().runtime));
      yield* Effect.promise(() => queue.dispose());
      const error = ingestAfterDisposalOutcome(queue);
      expect(error).toBeInstanceOf(AdvisorQueueDisposedError);
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((error as AdvisorQueueDisposedError)._tag).toBe("Disposed");
    }),
  );
});
