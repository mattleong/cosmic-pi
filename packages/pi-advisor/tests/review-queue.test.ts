import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { vi } from "vitest";
import {
  AdvisorQueueBatchDroppedError,
  AdvisorQueueCancelledError,
  AdvisorQueueCorrelationMismatchError,
  AdvisorQueueDisposedError,
  AdvisorQueueResetRequiredError,
  type AdvisorReviewQueueError,
} from "../src/queue/errors.ts";
import {
  makeAdvisorReviewQueue,
  MAX_PENDING_CHECKPOINTS,
  type AdvisorReviewQueue,
  type ReviewQueueCheckpointRequest,
} from "../src/queue/review-queue.ts";
import { AdvisorModelError } from "../src/runtime/client.ts";
import {
  AdvisorRuntimeResetRequiredError,
  type AdvisorCheckpoint,
  type AdvisorCheckpointRequest,
  type AdvisorRuntimeServiceContract,
} from "../src/runtime/runtime.ts";

const result = (request: AdvisorCheckpointRequest): AdvisorCheckpoint => ({
  checkpointId: request.checkpointId,
  processedThrough: request.processedThrough,
  stateSummary: "compact state",
  verdict: "pass",
  summary: "No issue.",
  suggestions: [],
  findings: [],
});

const resetRequired = () =>
  new AdvisorRuntimeResetRequiredError({
    message: "opaque reset-required failure",
    kind: "response-format",
  });

const makeRuntime = (
  overrides: Partial<AdvisorRuntimeServiceContract> = {},
): AdvisorRuntimeServiceContract => ({
  activeToolNames: () => [],
  start: () => Effect.void,
  checkpoint: (request) => Effect.succeed(result(request)),
  steer: () => Effect.succeed(false),
  reprime: () => Effect.void,
  abort: () => Effect.void,
  dispose: () => Effect.void,
  ...overrides,
});

const makeCallGate = <Input, Output, Error = never>() => {
  const calls: Input[] = [];
  const completions: Array<Deferred.Deferred<Output, Error>> = [];
  const notices = new Map<number, Deferred.Deferred<Input>>();
  const notice = (index: number): Deferred.Deferred<Input> => {
    const existing = notices.get(index);
    if (existing) return existing;
    const created = Deferred.makeUnsafe<Input>();
    notices.set(index, created);
    return created;
  };
  return {
    calls,
    call: (input: Input): Effect.Effect<Output, Error> =>
      Effect.suspend(() => {
        const index = calls.length;
        calls.push(input);
        const completion = Deferred.makeUnsafe<Output, Error>();
        completions.push(completion);
        Deferred.doneUnsafe(notice(index), Effect.succeed(input));
        return Deferred.await(completion);
      }),
    awaitCall: (index: number): Effect.Effect<Input> =>
      calls[index] === undefined ? Deferred.await(notice(index)) : Effect.succeed(calls[index]),
    succeed: (index: number, output: Output): Effect.Effect<boolean> => {
      const completion = completions[index];
      return completion ? Deferred.succeed(completion, output) : Effect.succeed(false);
    },
    fail: (index: number, error: Error): Effect.Effect<boolean> => {
      const completion = completions[index];
      return completion ? Deferred.fail(completion, error) : Effect.succeed(false);
    },
  };
};

const forkCheckpoint = (queue: AdvisorReviewQueue, request: ReviewQueueCheckpointRequest) =>
  queue.checkpointEffect(request).pipe(Effect.forkChild({ startImmediately: true }));

const queueError = <A>(exit: Exit.Exit<A, AdvisorReviewQueueError>) =>
  exit._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("AdvisorReviewQueue", () => {
  it.effect("parent scope disposal finalizes an acquired queue exactly once", () =>
    Effect.gen(function* () {
      let disposals = 0;
      yield* Effect.scoped(
        makeAdvisorReviewQueue(
          makeRuntime({
            dispose: () =>
              Effect.sync(() => {
                disposals += 1;
              }),
          }),
        ).pipe(Effect.asVoid),
      );
      expect(disposals).toBe(1);
    }),
  );

  it.effect(
    "explicit disposal closes the child scope and remains exact once at parent release",
    () =>
      Effect.gen(function* () {
        let disposals = 0;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* makeAdvisorReviewQueue(
              makeRuntime({
                dispose: () =>
                  Effect.sync(() => {
                    disposals += 1;
                  }),
              }),
            );
            yield* queue.disposeEffect();
            yield* queue.disposeEffect();
            expect(disposals).toBe(1);
          }),
        );
        expect(disposals).toBe(1);
      }),
  );

  it.effect("serializes checkpoints in FIFO order", () =>
    Effect.gen(function* () {
      const checkpoints = makeCallGate<
        AdvisorCheckpointRequest,
        AdvisorCheckpoint,
        AdvisorModelError
      >();
      const queue = yield* makeAdvisorReviewQueue(makeRuntime({ checkpoint: checkpoints.call }));
      queue.ingest(1, { type: "user", text: "one" });
      const first = yield* forkCheckpoint(queue, { checkpointId: "one", focus: "standard" });
      yield* checkpoints.awaitCall(0);
      const second = yield* forkCheckpoint(queue, { checkpointId: "two", focus: "standard" });
      yield* Effect.yieldNow;
      expect(checkpoints.calls.map((request) => request.checkpointId)).toEqual(["one"]);
      yield* checkpoints.succeed(0, result(checkpoints.calls[0]!));
      yield* checkpoints.awaitCall(1);
      expect(checkpoints.calls.map((request) => request.checkpointId)).toEqual(["one", "two"]);
      yield* checkpoints.succeed(1, result(checkpoints.calls[1]!));
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }),
  );

  it.effect("normal settlement runs barrier and hooks before caller completion", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: (request) =>
            Effect.sync(() => {
              events.push("runtime");
              return result(request);
            }),
        }),
        {
          onCheckpointStart: () => events.push("start"),
          onCheckpointSettled: () => events.push("settled"),
        },
      );
      queue.ingest(1, { type: "user", text: "evidence" });
      yield* queue.checkpointEffect({ checkpointId: "ordered", focus: "standard" }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            events.push("caller");
          }),
        ),
      );
      expect(events).toEqual(["start", "runtime", "settled", "caller"]);
      expect(queue.processedThrough).toBe(1);
      expect(queue.backlog).toBe(0);
    }),
  );

  it.effect("rearms the idle wake after each completed checkpoint", () =>
    Effect.gen(function* () {
      const ids: string[] = [];
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: (request) =>
            Effect.sync(() => {
              ids.push(request.checkpointId);
              return result(request);
            }),
        }),
      );
      queue.ingest(1, { type: "user", text: "first" });
      yield* queue.checkpointEffect({ checkpointId: "first", focus: "standard" });
      queue.ingest(2, { type: "user", text: "second" });
      yield* queue.checkpointEffect({ checkpointId: "second", focus: "standard" });
      expect(ids).toEqual(["first", "second"]);
    }),
  );

  it.effect("cancels a middle queued checkpoint without disturbing survivor FIFO", () =>
    Effect.gen(function* () {
      const firstGate = makeCallGate<
        AdvisorCheckpointRequest,
        AdvisorCheckpoint,
        AdvisorModelError
      >();
      const ids: string[] = [];
      const runtime = makeRuntime({
        checkpoint: (request) => {
          ids.push(request.checkpointId);
          return request.checkpointId === "active"
            ? firstGate.call(request)
            : Effect.succeed(result(request));
        },
      });
      const queue = yield* makeAdvisorReviewQueue(runtime);
      queue.ingest(1, { type: "user", text: "evidence" });
      const active = yield* forkCheckpoint(queue, { checkpointId: "active", focus: "standard" });
      yield* firstGate.awaitCall(0);
      const first = yield* forkCheckpoint(queue, { checkpointId: "first", focus: "standard" });
      const middle = yield* forkCheckpoint(queue, { checkpointId: "middle", focus: "standard" });
      const last = yield* forkCheckpoint(queue, { checkpointId: "last", focus: "standard" });
      yield* Effect.yieldNow;
      yield* queue.cancelCheckpointEffect("middle");
      const middleExit = yield* Fiber.await(middle);
      expect(queueError(middleExit)).toBeInstanceOf(AdvisorQueueCancelledError);
      yield* firstGate.succeed(0, result(firstGate.calls[0]!));
      yield* Fiber.join(active);
      yield* Fiber.join(first);
      yield* Fiber.join(last);
      expect(ids).toEqual(["active", "first", "last"]);
    }),
  );

  it.effect("overflow drops only the oldest queued entry and keeps survivor FIFO", () =>
    Effect.gen(function* () {
      const activeGate = makeCallGate<
        AdvisorCheckpointRequest,
        AdvisorCheckpoint,
        AdvisorModelError
      >();
      const ids: string[] = [];
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: (request) => {
            ids.push(request.checkpointId);
            return request.checkpointId === "active"
              ? activeGate.call(request)
              : Effect.succeed(result(request));
          },
        }),
      );
      queue.ingest(1, { type: "user", text: "bounded" });
      const active = yield* forkCheckpoint(queue, { checkpointId: "active", focus: "standard" });
      yield* activeGate.awaitCall(0);
      const queued: Array<Fiber.Fiber<AdvisorCheckpoint, AdvisorReviewQueueError>> = [];
      for (let index = 0; index <= MAX_PENDING_CHECKPOINTS; index += 1) {
        queued.push(
          yield* forkCheckpoint(queue, {
            checkpointId: `queued-${index}`,
            focus: "standard",
          }),
        );
        yield* Effect.yieldNow;
      }
      expect(queue.pendingCheckpoints).toBe(MAX_PENDING_CHECKPOINTS + 1);
      const evicted = yield* Fiber.await(queued[0]!);
      expect(queueError(evicted)).toBeInstanceOf(AdvisorQueueBatchDroppedError);
      yield* activeGate.succeed(0, result(activeGate.calls[0]!));
      yield* Fiber.join(active);
      for (const survivor of queued.slice(1)) yield* Fiber.join(survivor);
      expect(ids).toEqual([
        "active",
        ...Array.from({ length: MAX_PENDING_CHECKPOINTS }, (_, index) => `queued-${index + 1}`),
      ]);
    }),
  );

  it.effect("active cancellation stays pending until runtime abort cleanup settles", () =>
    Effect.gen(function* () {
      const abortStarted = yield* Deferred.make<void>();
      const abortRelease = yield* Deferred.make<void>();
      const checkpoints = makeCallGate<
        AdvisorCheckpointRequest,
        AdvisorCheckpoint,
        AdvisorModelError
      >();
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: checkpoints.call,
          abort: () =>
            Deferred.succeed(abortStarted, undefined).pipe(
              Effect.andThen(Deferred.await(abortRelease)),
              Effect.asVoid,
            ),
        }),
      );
      queue.ingest(1, { type: "user", text: "cancel" });
      const requestDone = yield* Deferred.make<void>();
      const request = yield* queue
        .checkpointEffect({ checkpointId: "cancel", focus: "standard" })
        .pipe(
          Effect.ensuring(Deferred.succeed(requestDone, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* checkpoints.awaitCall(0);
      const cancellationDone = yield* Deferred.make<void>();
      const cancellation = yield* queue
        .cancelCheckpointEffect("cancel")
        .pipe(
          Effect.ensuring(Deferred.succeed(cancellationDone, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(abortStarted);
      expect(yield* Deferred.isDone(cancellationDone)).toBe(false);
      expect(yield* Deferred.isDone(requestDone)).toBe(false);
      yield* Deferred.succeed(abortRelease, undefined);
      yield* Fiber.join(cancellation);
      const requestExit = yield* Fiber.await(request);
      expect(queueError(requestExit)).toBeInstanceOf(AdvisorQueueCancelledError);
    }),
  );

  it.effect("dispose stays pending through abort cleanup and completes requests last", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const abortStarted = yield* Deferred.make<void>();
      const abortRelease = yield* Deferred.make<void>();
      const checkpoints = makeCallGate<
        AdvisorCheckpointRequest,
        AdvisorCheckpoint,
        AdvisorModelError
      >();
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: checkpoints.call,
          abort: () =>
            Effect.sync(() => events.push("abort-start")).pipe(
              Effect.andThen(Deferred.succeed(abortStarted, undefined)),
              Effect.andThen(Deferred.await(abortRelease)),
              Effect.andThen(Effect.sync(() => events.push("abort-end"))),
            ),
          dispose: () => Effect.sync(() => events.push("runtime-dispose")),
        }),
        { onCheckpointSettled: () => events.push("settled") },
      );
      queue.ingest(1, { type: "user", text: "dispose" });
      const requestDone = yield* Deferred.make<void>();
      const request = yield* queue
        .checkpointEffect({ checkpointId: "dispose", focus: "standard" })
        .pipe(
          Effect.exit,
          Effect.tap(() => Effect.sync(() => events.push("request-complete"))),
          Effect.ensuring(Deferred.succeed(requestDone, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* checkpoints.awaitCall(0);
      const disposalDone = yield* Deferred.make<void>();
      const disposal = yield* queue.disposeEffect().pipe(
        Effect.tap(() => Effect.sync(() => events.push("dispose-complete"))),
        Effect.ensuring(Deferred.succeed(disposalDone, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(abortStarted);
      expect(yield* Deferred.isDone(disposalDone)).toBe(false);
      expect(yield* Deferred.isDone(requestDone)).toBe(false);
      yield* Deferred.succeed(abortRelease, undefined);
      yield* Fiber.join(disposal);
      const requestExit = yield* Fiber.join(request);
      expect(queueError(requestExit)).toBeInstanceOf(AdvisorQueueDisposedError);
      expect(events).toEqual([
        "abort-start",
        "abort-end",
        "runtime-dispose",
        "settled",
        "request-complete",
        "dispose-complete",
      ]);
    }),
  );

  it.effect("cancel versus dispose has one active settlement owner", () =>
    Effect.gen(function* () {
      let settlements = 0;
      let disposals = 0;
      const abortStarted = yield* Deferred.make<void>();
      const abortRelease = yield* Deferred.make<void>();
      const checkpoints = makeCallGate<
        AdvisorCheckpointRequest,
        AdvisorCheckpoint,
        AdvisorModelError
      >();
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: checkpoints.call,
          abort: () =>
            Deferred.succeed(abortStarted, undefined).pipe(
              Effect.andThen(Deferred.await(abortRelease)),
              Effect.asVoid,
            ),
          dispose: () =>
            Effect.sync(() => {
              disposals += 1;
            }),
        }),
        {
          onCheckpointSettled: () => {
            settlements += 1;
          },
        },
      );
      queue.ingest(1, { type: "user", text: "race" });
      const request = yield* forkCheckpoint(queue, { checkpointId: "race", focus: "standard" });
      yield* checkpoints.awaitCall(0);
      const cancellation = yield* queue
        .cancelCheckpointEffect("race")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(abortStarted);
      const disposal = yield* queue
        .disposeEffect()
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(abortRelease, undefined);
      yield* Fiber.join(cancellation);
      yield* Fiber.join(disposal);
      const requestExit = yield* Fiber.await(request);
      expect(queueError(requestExit)).toBeInstanceOf(AdvisorQueueDisposedError);
      expect(settlements).toBe(1);
      expect(disposals).toBe(1);
    }),
  );

  it.effect("dispose-first cancellation waits for the disposal owner to finish abort cleanup", () =>
    Effect.gen(function* () {
      const abortStarted = yield* Deferred.make<void>();
      const abortRelease = yield* Deferred.make<void>();
      const checkpoints = makeCallGate<
        AdvisorCheckpointRequest,
        AdvisorCheckpoint,
        AdvisorModelError
      >();
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: checkpoints.call,
          abort: () =>
            Deferred.succeed(abortStarted, undefined).pipe(
              Effect.andThen(Deferred.await(abortRelease)),
              Effect.asVoid,
            ),
        }),
      );
      queue.ingest(1, { type: "user", text: "dispose-first" });
      const request = yield* forkCheckpoint(queue, {
        checkpointId: "dispose-first",
        focus: "standard",
      });
      yield* checkpoints.awaitCall(0);
      const disposal = yield* queue
        .disposeEffect()
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(abortStarted);
      const cancellationDone = yield* Deferred.make<void>();
      const cancellation = yield* queue
        .cancelCheckpointEffect("dispose-first")
        .pipe(
          Effect.ensuring(Deferred.succeed(cancellationDone, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(cancellationDone)).toBe(false);
      yield* Deferred.succeed(abortRelease, undefined);
      yield* Fiber.join(disposal);
      yield* Fiber.join(cancellation);
      expect(queueError(yield* Fiber.await(request))).toBeInstanceOf(AdvisorQueueDisposedError);
    }),
  );

  it.effect("caller interruption cancels its internal token, not a repeated external ID", () =>
    Effect.gen(function* () {
      const checkpoints = makeCallGate<
        AdvisorCheckpointRequest,
        AdvisorCheckpoint,
        AdvisorModelError
      >();
      const queue = yield* makeAdvisorReviewQueue(makeRuntime({ checkpoint: checkpoints.call }));
      queue.ingest(1, { type: "user", text: "same-id" });
      const first = yield* forkCheckpoint(queue, { checkpointId: "same", focus: "standard" });
      yield* checkpoints.awaitCall(0);
      const second = yield* forkCheckpoint(queue, { checkpointId: "same", focus: "standard" });
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      yield* checkpoints.awaitCall(1);
      expect(checkpoints.calls).toHaveLength(2);
      yield* checkpoints.succeed(1, result(checkpoints.calls[1]!));
      yield* Fiber.join(second);
    }),
  );

  it.effect("a stale repeated-ID steer cannot advance its replacement", () =>
    Effect.gen(function* () {
      const checkpoints = makeCallGate<
        AdvisorCheckpointRequest,
        AdvisorCheckpoint,
        AdvisorModelError
      >();
      const steers = makeCallGate<string, boolean, AdvisorModelError>();
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({ checkpoint: checkpoints.call, steer: steers.call }),
      );
      queue.ingest(1, { type: "user", text: "initial" });
      const first = yield* forkCheckpoint(queue, { checkpointId: "same", focus: "standard" });
      yield* checkpoints.awaitCall(0);
      queue.ingest(1, { type: "assistant_text_delta", text: "stale-live" });
      yield* steers.awaitCall(0);
      const replacement = yield* forkCheckpoint(queue, {
        checkpointId: "same",
        focus: "standard",
      });
      yield* Effect.yieldNow;
      const cancellation = yield* queue
        .cancelCheckpointEffect("same")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.join(cancellation);
      expect(queueError(yield* Fiber.await(first))).toBeInstanceOf(AdvisorQueueCancelledError);
      yield* checkpoints.awaitCall(1);
      queue.ingest(1, { type: "assistant_text_delta", text: "replacement-live" });
      yield* steers.succeed(0, true);
      const replacementSteer = yield* steers.awaitCall(1);
      expect(replacementSteer).toContain("replacement-live");
      expect(replacementSteer).not.toContain("stale-live");
      yield* steers.succeed(1, true);
      yield* checkpoints.succeed(1, result(checkpoints.calls[1]!));
      yield* Fiber.join(replacement);
    }),
  );

  it.effect("accepted steering never commits evidence", () =>
    Effect.gen(function* () {
      const checkpoints = makeCallGate<
        AdvisorCheckpointRequest,
        AdvisorCheckpoint,
        AdvisorModelError
      >();
      const steers: string[] = [];
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: checkpoints.call,
          steer: (observations) =>
            Effect.sync(() => {
              steers.push(observations);
              return true;
            }),
        }),
      );
      queue.ingest(1, { type: "user", text: "initial" });
      const first = yield* forkCheckpoint(queue, { checkpointId: "first", focus: "standard" });
      yield* checkpoints.awaitCall(0);
      queue.ingest(1, { type: "assistant_text_delta", text: "live-must-survive" });
      yield* Effect.yieldNow;
      expect(steers[0]).toContain("live-must-survive");
      yield* checkpoints.succeed(0, result(checkpoints.calls[0]!));
      yield* Fiber.join(first);
      const second = yield* forkCheckpoint(queue, { checkpointId: "second", focus: "standard" });
      const secondRequest = yield* checkpoints.awaitCall(1);
      expect(secondRequest.observations).toContain("live-must-survive");
      yield* checkpoints.succeed(1, result(secondRequest));
      yield* Fiber.join(second);
    }),
  );

  it.effect("captures the admission cursor and ignores a supplied legacy cursor", () =>
    Effect.gen(function* () {
      const checkpoints = makeCallGate<
        AdvisorCheckpointRequest,
        AdvisorCheckpoint,
        AdvisorModelError
      >();
      const queue = yield* makeAdvisorReviewQueue(makeRuntime({ checkpoint: checkpoints.call }));
      queue.ingest(1, { type: "user", text: "first" });
      queue.ingest(1, { type: "assistant_text_delta", text: "second" });
      // SAFETY: This test intentionally sends one removed legacy field through structural typing.
      const forged = {
        checkpointId: "captured",
        focus: "standard",
        targetSequence: 1,
      } as ReviewQueueCheckpointRequest & { readonly targetSequence: number };
      const checkpoint = yield* forkCheckpoint(queue, forged);
      const request = yield* checkpoints.awaitCall(0);
      expect(request.processedThrough).toBe(2);
      expect(request.observations).toContain("second");
      yield* checkpoints.succeed(0, result(request));
      yield* Fiber.join(checkpoint);
    }),
  );

  it.effect("retains a shared admission barrier when one queued checkpoint is cancelled", () =>
    Effect.gen(function* () {
      const checkpoints = makeCallGate<
        AdvisorCheckpointRequest,
        AdvisorCheckpoint,
        AdvisorModelError
      >();
      const queue = yield* makeAdvisorReviewQueue(makeRuntime({ checkpoint: checkpoints.call }));
      queue.ingest(1, { type: "user", text: "seq1" });
      const active = yield* forkCheckpoint(queue, { checkpointId: "active", focus: "standard" });
      yield* checkpoints.awaitCall(0);
      queue.ingest(1, { type: "assistant_text_delta", text: "frozen-seq2" });
      const cancelled = yield* forkCheckpoint(queue, {
        checkpointId: "cancel-shared",
        focus: "standard",
      });
      const survivor = yield* forkCheckpoint(queue, {
        checkpointId: "survive-shared",
        focus: "standard",
      });
      yield* Effect.yieldNow;
      queue.ingest(1, { type: "assistant_text_delta", text: "later-seq3" });
      yield* queue.cancelCheckpointEffect("cancel-shared");
      expect(queueError(yield* Fiber.await(cancelled))).toBeInstanceOf(AdvisorQueueCancelledError);
      yield* checkpoints.succeed(0, result(checkpoints.calls[0]!));
      yield* Fiber.join(active);
      const survivorRequest = yield* checkpoints.awaitCall(1);
      expect(survivorRequest.processedThrough).toBe(2);
      expect(survivorRequest.observations).toContain("frozen-seq2");
      expect(survivorRequest.observations).not.toContain("later-seq3");
      yield* checkpoints.succeed(1, result(survivorRequest));
      yield* Fiber.join(survivor);
    }),
  );

  it.effect("retains evidence after provider failure and rejects correlation mismatches", () =>
    Effect.gen(function* () {
      let attempt = 0;
      const requests: AdvisorCheckpointRequest[] = [];
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: (request) => {
            requests.push(request);
            attempt += 1;
            if (attempt === 1)
              return Effect.fail(
                new AdvisorModelError({ message: "provider unavailable", kind: "authentication" }),
              );
            if (attempt === 2) return Effect.succeed({ ...result(request), checkpointId: "wrong" });
            return Effect.succeed(result(request));
          },
        }),
      );
      queue.ingest(1, { type: "user", text: "must survive" });
      const failed = yield* queue
        .checkpointEffect({ checkpointId: "provider", focus: "standard" })
        .pipe(Effect.exit);
      expect(queueError(failed)?.message).toBe("provider unavailable");
      const mismatch = yield* queue
        .checkpointEffect({ checkpointId: "expected", focus: "standard" })
        .pipe(Effect.exit);
      expect(queueError(mismatch)).toBeInstanceOf(AdvisorQueueCorrelationMismatchError);
      yield* queue.checkpointEffect({ checkpointId: "retry", focus: "standard" });
      expect(requests[2]?.observations).toContain("must survive");
    }),
  );

  it.effect("re-primes once and retries the exact correlated request", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const requests: AdvisorCheckpointRequest[] = [];
      const reprimes: Array<readonly [string, string | undefined]> = [];
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: (request) => {
            requests.push(request);
            attempts += 1;
            return attempts === 1 ? Effect.fail(resetRequired()) : Effect.succeed(result(request));
          },
          reprime: (seed, summary) =>
            Effect.sync(() => {
              reprimes.push([seed, summary]);
            }),
        }),
        { getReprimeState: () => ({ seed: "current cursor", stateSummary: "compact" }) },
      );
      queue.ingest(1, { type: "user", text: "bounded batch" });
      yield* queue.checkpointEffect({ checkpointId: "reset", focus: "standard" });
      expect(reprimes).toEqual([["current cursor", "compact"]]);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
    }),
  );

  it.effect("second reset re-primes, drops the poison batch, and lets later evidence run", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let reprimes = 0;
      const requests: AdvisorCheckpointRequest[] = [];
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: (request) => {
            requests.push(request);
            attempts += 1;
            return attempts <= 2 ? Effect.fail(resetRequired()) : Effect.succeed(result(request));
          },
          reprime: () =>
            Effect.sync(() => {
              reprimes += 1;
            }),
        }),
        { getReprimeState: () => ({ seed: "current" }) },
      );
      queue.ingest(1, { type: "user", text: "poison" });
      const dropped = yield* queue
        .checkpointEffect({ checkpointId: "drop", focus: "standard" })
        .pipe(Effect.exit);
      expect(queueError(dropped)).toBeInstanceOf(AdvisorQueueBatchDroppedError);
      expect(reprimes).toBe(2);
      expect(queue.processedThrough).toBe(1);
      queue.ingest(2, { type: "user", text: "small" });
      yield* queue.checkpointEffect({ checkpointId: "small", focus: "standard" });
      expect(requests[2]?.observations).toContain("small");
      expect(requests[2]?.observations).not.toContain("poison");
    }),
  );

  it.effect("returns ResetRequired when recovery has no current re-prime state", () =>
    Effect.gen(function* () {
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({ checkpoint: () => Effect.fail(resetRequired()) }),
      );
      queue.ingest(1, { type: "user", text: "reset" });
      const exit = yield* queue
        .checkpointEffect({ checkpointId: "reset", focus: "standard" })
        .pipe(Effect.exit);
      expect(queueError(exit)).toBeInstanceOf(AdvisorQueueResetRequiredError);
    }),
  );

  it.effect("cancelling a reset failure prevents any stale re-prime", () =>
    Effect.gen(function* () {
      let reprimes = 0;
      const checkpointStarted = yield* Deferred.make<void>();
      const checkpointRelease = yield* Deferred.make<void>();
      const abortStarted = yield* Deferred.make<void>();
      const abortRelease = yield* Deferred.make<void>();
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: () =>
            Deferred.succeed(checkpointStarted, undefined).pipe(
              Effect.andThen(Deferred.await(checkpointRelease)),
              Effect.andThen(Effect.fail(resetRequired())),
            ),
          reprime: () =>
            Effect.sync(() => {
              reprimes += 1;
            }),
          abort: () =>
            Deferred.succeed(abortStarted, undefined).pipe(
              Effect.andThen(Deferred.await(abortRelease)),
              Effect.asVoid,
            ),
        }),
        { getReprimeState: () => ({ seed: "stale" }) },
      );
      queue.ingest(1, { type: "user", text: "reset" });
      const request = yield* forkCheckpoint(queue, { checkpointId: "cancel", focus: "standard" });
      yield* Deferred.await(checkpointStarted);
      const cancellation = yield* queue
        .cancelCheckpointEffect("cancel")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(abortStarted);
      yield* Deferred.succeed(checkpointRelease, undefined);
      yield* Deferred.succeed(abortRelease, undefined);
      yield* Fiber.join(cancellation);
      expect(queueError(yield* Fiber.await(request))).toBeInstanceOf(AdvisorQueueCancelledError);
      expect(reprimes).toBe(0);
    }),
  );

  it.effect("disposal of a reset failure prevents any stale re-prime", () =>
    Effect.gen(function* () {
      let reprimes = 0;
      const checkpointStarted = yield* Deferred.make<void>();
      const checkpointRelease = yield* Deferred.make<void>();
      const abortStarted = yield* Deferred.make<void>();
      const abortRelease = yield* Deferred.make<void>();
      const queue = yield* makeAdvisorReviewQueue(
        makeRuntime({
          checkpoint: () =>
            Deferred.succeed(checkpointStarted, undefined).pipe(
              Effect.andThen(Deferred.await(checkpointRelease)),
              Effect.andThen(Effect.fail(resetRequired())),
            ),
          reprime: () =>
            Effect.sync(() => {
              reprimes += 1;
            }),
          abort: () =>
            Deferred.succeed(abortStarted, undefined).pipe(
              Effect.andThen(Deferred.await(abortRelease)),
              Effect.asVoid,
            ),
        }),
        { getReprimeState: () => ({ seed: "stale" }) },
      );
      queue.ingest(1, { type: "user", text: "reset" });
      const request = yield* forkCheckpoint(queue, { checkpointId: "dispose", focus: "standard" });
      yield* Deferred.await(checkpointStarted);
      const disposal = yield* queue
        .disposeEffect()
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(abortStarted);
      yield* Deferred.succeed(checkpointRelease, undefined);
      yield* Deferred.succeed(abortRelease, undefined);
      yield* Fiber.join(disposal);
      expect(queueError(yield* Fiber.await(request))).toBeInstanceOf(AdvisorQueueDisposedError);
      expect(reprimes).toBe(0);
    }),
  );

  it.effect("post-disposal ingestion throws the typed Disposed error", () =>
    Effect.gen(function* () {
      const queue = yield* makeAdvisorReviewQueue(makeRuntime());
      yield* queue.disposeEffect();
      expect(() => queue.ingest(1, { type: "user", text: "late" })).toThrow(
        AdvisorQueueDisposedError,
      );
    }),
  );

  it.effect("isolates lifecycle callbacks while preserving settlement", () =>
    Effect.gen(function* () {
      const settled = vi.fn(() => {
        throw new Error("hostile callback");
      });
      const queue = yield* makeAdvisorReviewQueue(makeRuntime(), {
        onCheckpointStart: () => {
          throw new Error("hostile callback");
        },
        onCheckpointSettled: settled,
      });
      queue.ingest(1, { type: "user", text: "safe" });
      yield* queue.checkpointEffect({ checkpointId: "safe", focus: "standard" });
      expect(settled).toHaveBeenCalledOnce();
    }),
  );
});
