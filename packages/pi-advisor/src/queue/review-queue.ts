import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { makeSynchronousIngress, type SynchronousIngress } from "pi-cosmic-core";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeServiceContract,
} from "../runtime/runtime.ts";
import { AdvisorRuntimeResetRequiredError } from "../runtime/runtime.ts";
import { classifyAdvisorRuntimeFailure } from "../domain/runtime-error-classifier.ts";
import {
  AdvisorQueueBacklogExceededError,
  AdvisorQueueBatchDroppedError,
  AdvisorQueueCancelledError,
  AdvisorQueueCorrelationMismatchError,
  AdvisorQueueDisposedError,
  AdvisorQueueError,
  AdvisorQueueResetRequiredError,
  AdvisorQueueStaleEpochError,
  isAdvisorReviewQueueError,
  type AdvisorReviewQueueError,
} from "./errors.ts";
import {
  acceptSteering,
  attemptSteering,
  beginCheckpoint,
  cancelQueuedCheckpoint,
  disposeReviewQueue,
  dropQueuedCheckpoint,
  enqueueCheckpoint,
  initialReviewQueueState,
  settleCheckpoint,
  type ReviewQueueState,
} from "./state.ts";
import {
  AdvisorObservationBuffer,
  renderObservations,
  type AdvisorObservation,
  type AdvisorObservationInput,
} from "../review/observation-protocol.ts";
import type { AdvisorReview, AdvisorReviewFocus } from "../review/index.ts";

export const MAX_PENDING_CHECKPOINTS = 16;
export interface ReviewQueueCheckpointRequest {
  checkpointId: string;
  focus: AdvisorReviewFocus;
  parentTurnId: number;
  targetSequence?: number | undefined;
  verificationReview?: AdvisorReview | undefined;
}
export interface QueuedCheckpoint {
  readonly request: ReviewQueueCheckpointRequest;
  readonly target: number;
  readonly epoch: number;
  readonly done: Deferred.Deferred<AdvisorCheckpoint, AdvisorReviewQueueError>;
  phase: "queued" | "active" | "settled";
  cancelled: boolean;
}

export interface AdvisorReprimeState {
  seed: string;
  stateSummary?: string | undefined;
}
export interface AdvisorReviewQueueOptions {
  onCheckpointStart?: ((request: ReviewQueueCheckpointRequest) => void) | undefined;
  onCheckpointSettled?: ((request: ReviewQueueCheckpointRequest) => void) | undefined;
  onRuntimeReset?: ((reason: string) => void) | undefined;
  getReprimeState?: (() => AdvisorReprimeState) | undefined;
}

export interface AdvisorReviewQueue {
  readonly processedThrough: number;
  readonly sequence: number;
  readonly backlog: number;
  readonly pendingCheckpoints: number;
  readonly hasActiveCheckpoint: boolean;
  readonly activeToolNames: readonly string[];
  readonly ingest: (parentTurnId: number, input: AdvisorObservationInput) => AdvisorObservation;
  readonly checkpointEffect: (
    request: ReviewQueueCheckpointRequest,
  ) => Effect.Effect<AdvisorCheckpoint, AdvisorReviewQueueError>;
  readonly disposeEffect: () => Effect.Effect<void>;
  readonly cancelCheckpointEffect: (checkpointId: string) => Effect.Effect<void>;
}

class AdvisorReviewQueueImpl implements AdvisorReviewQueue {
  private readonly runtime: AdvisorRuntimeServiceContract;
  private readonly options: AdvisorReviewQueueOptions;
  private readonly resourceScope: Scope.Closeable;
  private readonly state: SynchronizedRef.SynchronizedRef<ReviewQueueState>;
  private readonly requestQueue: Queue.Queue<QueuedCheckpoint>;
  private readonly observations = new AdvisorObservationBuffer();
  private readonly requests = new Set<QueuedCheckpoint>();
  private readonly stateProjection: MutableRef.MutableRef<ReviewQueueState>;
  private readonly checkpointWorker: FiberHandle.FiberHandle<void, never>;
  private steeringIngress: SynchronousIngress<void> | undefined;
  private initialized = false;

  constructor(
    runtime: AdvisorRuntimeServiceContract,
    options: AdvisorReviewQueueOptions,
    resourceScope: Scope.Closeable,
    state: SynchronizedRef.SynchronizedRef<ReviewQueueState>,
    requestQueue: Queue.Queue<QueuedCheckpoint>,
    checkpointWorker: FiberHandle.FiberHandle<void, never>,
  ) {
    this.runtime = runtime;
    this.options = options;
    this.resourceScope = resourceScope;
    this.state = state;
    this.requestQueue = requestQueue;
    this.checkpointWorker = checkpointWorker;
    this.stateProjection = MutableRef.make(initialReviewQueueState());
  }

  get processedThrough() {
    return MutableRef.get(this.stateProjection).processedThrough;
  }
  get sequence() {
    return this.observations.sequence;
  }
  get backlog() {
    return this.observations.size;
  }
  get pendingCheckpoints() {
    const state = MutableRef.get(this.stateProjection);
    return state.pendingCount + (state.active ? 1 : 0);
  }
  get hasActiveCheckpoint() {
    return MutableRef.get(this.stateProjection).active !== undefined;
  }
  get activeToolNames() {
    return this.runtime.activeToolNames();
  }

  ingest(parentTurnId: number, input: AdvisorObservationInput): AdvisorObservation {
    const state = MutableRef.get(this.stateProjection);
    if (state.disposed)
      throw new AdvisorQueueDisposedError({ message: "Advisor review queue is disposed." });
    const record = this.observations.ingest(parentTurnId, input);
    if (state.active && record.sequence > state.active.target)
      this.steeringIngress?.offer(undefined);
    return record;
  }

  checkpointEffect(request: ReviewQueueCheckpointRequest) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        const target = this.observations.freezeThrough(
          request.targetSequence ?? this.observations.sequence,
        );
        const waiter: QueuedCheckpoint = {
          request,
          target,
          epoch: MutableRef.get(this.stateProjection).epoch,
          done: yield* Deferred.make<AdvisorCheckpoint, AdvisorReviewQueueError>(),
          phase: "queued",
          cancelled: false,
        };
        yield* this.admit(waiter);
        return yield* restore(Deferred.await(waiter.done)).pipe(
          Effect.onInterrupt(() => this.cancelWaiterEffect(waiter)),
        );
      }),
    );
  }

  disposeEffect() {
    return Scope.close(this.resourceScope, Exit.void);
  }

  private shutdownEffect() {
    return Effect.gen({ self: this }, function* () {
      const before = MutableRef.get(this.stateProjection);
      if (before.disposed) return;
      const active = this.findActive(before);
      yield* this.transition(disposeReviewQueue);
      yield* this.rejectAll(
        new AdvisorQueueDisposedError({ message: "Advisor review queue was disposed." }),
      );
      yield* this.clearRequestQueue();
      yield* FiberHandle.clear(this.checkpointWorker);
      if (active) this.requests.delete(active);
      const steeringIngress = this.steeringIngress;
      this.steeringIngress = undefined;
      if (steeringIngress) {
        yield* steeringIngress.shutdown;
        yield* steeringIngress.awaitShutdown;
      }
      yield* Queue.shutdown(this.requestQueue);
      yield* this.runtime.dispose();
    });
  }

  cancelCheckpointEffect(checkpointId: string) {
    return Effect.gen({ self: this }, function* () {
      const waiter = [...this.requests].find(
        (candidate) => candidate.request.checkpointId === checkpointId,
      );
      if (!waiter) return;
      yield* this.cancelWaiterEffect(waiter);
    });
  }

  private cancelWaiterEffect(waiter: QueuedCheckpoint) {
    return Effect.uninterruptible(
      Effect.gen({ self: this }, function* () {
        const checkpointId = waiter.request.checkpointId;
        const error = new AdvisorQueueCancelledError({
          message: "Advisor checkpoint was cancelled.",
        });
        const disposition = yield* SynchronizedRef.modifyEffect(this.state, (current) =>
          Effect.gen({ self: this }, function* () {
            if (!this.requests.has(waiter) || waiter.phase === "settled" || waiter.cancelled)
              return ["settled" as const, current] as const;
            if (waiter.phase === "active") {
              waiter.phase = "settled";
              waiter.cancelled = true;
              this.requests.delete(waiter);
              yield* Deferred.fail(waiter.done, error);
              return ["active" as const, current] as const;
            }
            waiter.phase = "settled";
            waiter.cancelled = true;
            this.requests.delete(waiter);
            this.observations.releaseBarrier(waiter.target);
            yield* Deferred.fail(waiter.done, error);
            yield* this.compactRequestQueue();
            const next = cancelQueuedCheckpoint(current);
            this.publish(next);
            return ["queued" as const, next] as const;
          }),
        );
        if (disposition !== "active") return;

        yield* FiberHandle.clear(this.checkpointWorker);
        this.observations.releaseBarrier(waiter.target);
        yield* this.transition((state) => settleCheckpoint(state, checkpointId));
        isolate(() => this.options.onCheckpointSettled?.(waiter.request));
        if (!MutableRef.get(this.stateProjection).disposed) yield* this.startCheckpointWorker();
      }),
    );
  }

  initializeEffect() {
    return Effect.suspend(() => {
      if (this.initialized) return Effect.void;
      this.initialized = true;
      return Effect.gen({ self: this }, function* () {
        this.steeringIngress = yield* makeSynchronousIngress<void, never, never>({
          capacity: 1,
          overflow: "coalesce-latest",
          handle: () => this.flushActiveSteering(),
        }).pipe(Effect.provideService(Scope.Scope, this.resourceScope), Effect.orDie);
        yield* this.startCheckpointWorker();
        yield* Scope.addFinalizer(this.resourceScope, this.shutdownEffect());
      }).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? Scope.close(this.resourceScope, exit).pipe(Effect.andThen(this.runtime.dispose()))
            : Effect.void,
        ),
      );
    });
  }

  private startCheckpointWorker() {
    return Effect.gen({ self: this }, function* () {
      if (MutableRef.get(this.stateProjection).disposed) return;
      yield* FiberHandle.run(this.checkpointWorker, {
        onlyIfMissing: true,
        startImmediately: true,
      })(
        Effect.forever(
          Queue.take(this.requestQueue).pipe(Effect.flatMap((item) => this.consume(item))),
        ),
      );
    });
  }

  private admit(waiter: QueuedCheckpoint) {
    return SynchronizedRef.modifyEffect(this.state, (current) =>
      Effect.gen({ self: this }, function* () {
        if (current.disposed) {
          waiter.phase = "settled";
          this.observations.releaseBarrier(waiter.target);
          return yield* new AdvisorQueueDisposedError({
            message: "Advisor review queue is disposed.",
          });
        }
        let next = current;
        const queuedLimit = MAX_PENDING_CHECKPOINTS + (current.active ? 0 : 1);
        const mustEvict = current.pendingCount >= queuedLimit;
        if (mustEvict) {
          const evicted = Option.getOrUndefined(yield* Queue.poll(this.requestQueue));
          if (evicted) {
            evicted.phase = "settled";
            this.requests.delete(evicted);
            this.observations.releaseBarrier(evicted.target);
            if (!evicted.cancelled) {
              yield* Deferred.fail(
                evicted.done,
                new AdvisorQueueBatchDroppedError({
                  message: "Advisor checkpoint backlog exceeded its bound and was dropped.",
                }),
              );
              evicted.cancelled = true;
              next = dropQueuedCheckpoint(next);
            }
          }
        }
        this.requests.add(waiter);
        if (!(yield* Queue.offer(this.requestQueue, waiter))) {
          waiter.phase = "settled";
          this.requests.delete(waiter);
          this.observations.releaseBarrier(waiter.target);
          return yield* new AdvisorQueueBacklogExceededError({
            message: "Advisor checkpoint backlog exceeded its bound.",
          });
        }
        next = enqueueCheckpoint(next);
        this.publish(next);
        return [undefined, next] as const;
      }),
    );
  }

  private consume(waiter: QueuedCheckpoint) {
    return Effect.gen({ self: this }, function* () {
      const claim = yield* SynchronizedRef.modify(this.state, (current) => {
        if (waiter.cancelled || waiter.phase !== "queued" || !this.requests.has(waiter))
          return ["cancelled", current] as const;
        if (current.disposed || current.epoch !== waiter.epoch) {
          waiter.phase = "settled";
          this.requests.delete(waiter);
          this.observations.releaseBarrier(waiter.target);
          return ["stale", current] as const;
        }
        waiter.phase = "active";
        const next = beginCheckpoint(
          current,
          waiter.request.checkpointId,
          waiter.target,
          waiter.epoch,
        );
        this.publish(next);
        return ["claimed", next] as const;
      });
      if (claim === "cancelled") return;
      if (claim === "stale") {
        yield* Deferred.fail(
          waiter.done,
          new AdvisorQueueStaleEpochError({
            message: "Advisor checkpoint completed for a stale queue epoch.",
          }),
        );
        return;
      }
      isolate(() => this.options.onCheckpointStart?.(waiter.request));
      const batch = this.observations.peekThrough(waiter.target);
      const baseRequest: AdvisorCheckpointRequest = {
        checkpointId: waiter.request.checkpointId,
        processedThrough: waiter.target,
        observations: batch?.rendered ?? renderPreviouslyProcessed(waiter.target),
        focus: waiter.request.focus,
      };
      const runtimeRequest: AdvisorCheckpointRequest =
        waiter.request.verificationReview === undefined
          ? baseRequest
          : { ...baseRequest, verificationReview: waiter.request.verificationReview };
      const result = yield* this.checkpointWithBoundedRecovery(runtimeRequest, waiter.epoch).pipe(
        Effect.exit,
      );
      let settled = false;
      if (result._tag === "Success") {
        const checkpoint = result.value;
        const latest = MutableRef.get(this.stateProjection);
        if (waiter.epoch !== latest.epoch || latest.disposed) {
          settled = yield* this.settleClaimedWaiterEffect(waiter);
          if (settled)
            yield* Deferred.fail(
              waiter.done,
              new AdvisorQueueStaleEpochError({
                message: "Advisor checkpoint completed for a stale queue epoch.",
              }),
            );
        } else if (
          checkpoint.checkpointId !== waiter.request.checkpointId ||
          checkpoint.processedThrough !== waiter.target
        ) {
          settled = yield* this.settleClaimedWaiterEffect(waiter);
          if (settled)
            yield* Deferred.fail(
              waiter.done,
              new AdvisorQueueCorrelationMismatchError({
                message: "Advisor checkpoint correlation mismatch.",
              }),
            );
        } else {
          settled = yield* this.settleClaimedWaiterEffect(waiter, checkpoint.processedThrough);
          if (settled) yield* Deferred.succeed(waiter.done, checkpoint);
        }
      } else {
        const failure = Option.getOrUndefined(Cause.findErrorOption(result.cause));
        const error = isAdvisorReviewQueueError(failure)
          ? failure
          : new AdvisorQueueError({ message: "Advisor checkpoint failed." });
        settled = yield* this.settleClaimedWaiterEffect(waiter);
        if (settled) yield* Deferred.fail(waiter.done, error);
      }
      if (settled) isolate(() => this.options.onCheckpointSettled?.(waiter.request));
    });
  }

  private checkpointWithBoundedRecovery(request: AdvisorCheckpointRequest, expectedEpoch: number) {
    return Effect.gen({ self: this }, function* () {
      let retried = false;
      while (true) {
        yield* this.assertRecoveryCurrentEffect(expectedEpoch);
        const attempt = yield* this.runtime.checkpoint(request).pipe(
          Effect.mapError(toQueueError("Advisor checkpoint failed.")),
          Effect.onInterrupt(() => this.runtime.abort()),
          Effect.exit,
        );
        if (attempt._tag === "Success") return attempt.value;
        yield* this.assertRecoveryCurrentEffect(expectedEpoch);
        const failure = Option.getOrUndefined(Cause.findErrorOption(attempt.cause));
        if (classifyAdvisorRuntimeFailure(failure) !== "reset-required")
          return yield* new AdvisorQueueError({
            message: failureMessage(failure, "Advisor checkpoint failed."),
          });
        const state = this.options.getReprimeState?.();
        if (!state)
          return yield* new AdvisorQueueResetRequiredError({
            message: "Advisor checkpoint requires a fresh context.",
          });
        isolate(() => this.options.onRuntimeReset?.("Advisor runtime requires a fresh context."));
        yield* this.runtime
          .reprime(state.seed, state.stateSummary)
          .pipe(Effect.mapError(toQueueError("Advisor runtime re-prime failed.")));
        yield* this.assertRecoveryCurrentEffect(expectedEpoch);
        if (retried) {
          this.observations.commitThrough(request.processedThrough);
          return yield* new AdvisorQueueBatchDroppedError({
            message: "Advisor batch failed again after one fresh-context retry and was dropped.",
          });
        }
        retried = true;
      }
    });
  }

  private assertRecoveryCurrentEffect(expectedEpoch: number) {
    const state = MutableRef.get(this.stateProjection);
    return state.disposed || expectedEpoch !== state.epoch
      ? Effect.fail(
          new AdvisorQueueStaleEpochError({
            message: "Advisor checkpoint recovery became stale.",
          }),
        )
      : Effect.void;
  }

  private flushActiveSteering() {
    return Effect.gen({ self: this }, function* () {
      const state = MutableRef.get(this.stateProjection);
      const active = state.active;
      if (!active || state.disposed || active.epoch !== state.epoch) return;
      const through = this.observations.sequence;
      const batch = this.observations.peekRange(active.steeredThrough, through);
      if (!batch) return;
      yield* this.transition((current) => attemptSteering(current, active.checkpointId, through));
      const accepted = yield* this.runtime.steer(batch.rendered).pipe(
        Effect.mapError(toQueueError("Advisor steering failed.")),
        Effect.catch(() => Effect.succeed(false)),
      );
      const latest = MutableRef.get(this.stateProjection);
      if (
        accepted &&
        latest.active?.checkpointId === active.checkpointId &&
        latest.epoch === active.epoch &&
        !latest.disposed
      )
        yield* this.transition((current) => acceptSteering(current, active.checkpointId, through));
      const after = MutableRef.get(this.stateProjection);
      if (
        after.active?.checkpointId === active.checkpointId &&
        this.observations.sequence > after.active.steeringAttemptedThrough
      )
        this.steeringIngress?.offer(undefined);
    });
  }

  private transition(update: (state: ReviewQueueState) => ReviewQueueState) {
    return SynchronizedRef.modify(this.state, (current) => {
      const next = update(current);
      this.publish(next);
      return [undefined, next] as const;
    });
  }

  private settleClaimedWaiterEffect(waiter: QueuedCheckpoint, processedThrough?: number) {
    return SynchronizedRef.modify(this.state, (current) => {
      if (waiter.phase !== "active" || !this.requests.has(waiter)) return [false, current] as const;
      waiter.phase = "settled";
      this.requests.delete(waiter);
      if (processedThrough !== undefined) this.observations.commitThrough(processedThrough);
      const next = settleCheckpoint(current, waiter.request.checkpointId, processedThrough);
      this.publish(next);
      return [true, next] as const;
    });
  }

  private publish(state: ReviewQueueState) {
    MutableRef.set(this.stateProjection, state);
  }

  private findActive(state: ReviewQueueState): QueuedCheckpoint | undefined {
    const checkpointId = state.active?.checkpointId;
    return checkpointId
      ? [...this.requests].find(
          (waiter) => waiter.phase === "active" && waiter.request.checkpointId === checkpointId,
        )
      : undefined;
  }

  private rejectAll(error: AdvisorReviewQueueError) {
    return Effect.forEach(
      [...this.requests],
      (waiter) =>
        Effect.gen({ self: this }, function* () {
          this.observations.releaseBarrier(waiter.target);
          waiter.phase = "settled";
          waiter.cancelled = true;
          yield* Deferred.fail(waiter.done, error);
        }),
      { discard: true },
    );
  }

  private compactRequestQueue() {
    return Effect.gen({ self: this }, function* () {
      const live: QueuedCheckpoint[] = [];
      while (true) {
        const next = yield* Queue.poll(this.requestQueue);
        if (Option.isNone(next)) break;
        if (next.value.phase === "queued" && !next.value.cancelled && this.requests.has(next.value))
          live.push(next.value);
      }
      for (const waiter of live) {
        if (!(yield* Queue.offer(this.requestQueue, waiter))) {
          return yield* Effect.die("Advisor request queue compaction exceeded its bound.");
        }
      }
    });
  }

  private clearRequestQueue() {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        const next = yield* Queue.poll(this.requestQueue);
        if (Option.isNone(next)) break;
        next.value.phase = "settled";
        this.requests.delete(next.value);
      }
    });
  }
}

export const makeAdvisorReviewQueue = Effect.fn("AdvisorReviewQueue.make")(function* (
  runtime: AdvisorRuntimeServiceContract,
  options: AdvisorReviewQueueOptions = {},
) {
  const parentScope = yield* Effect.scope;
  const resourceScope = yield* Scope.fork(parentScope);
  const state = yield* SynchronizedRef.make(initialReviewQueueState());
  const requestQueue = yield* Queue.dropping<QueuedCheckpoint>(MAX_PENDING_CHECKPOINTS + 1);
  const checkpointWorker = yield* FiberHandle.make<void, never>().pipe(
    Effect.provideService(Scope.Scope, resourceScope),
  );
  const queue = new AdvisorReviewQueueImpl(
    runtime,
    options,
    resourceScope,
    state,
    requestQueue,
    checkpointWorker,
  );
  yield* queue.initializeEffect();
  return queue satisfies AdvisorReviewQueue;
});

const toQueueError =
  (fallback: string) =>
  <ErrorInput>(error: ErrorInput): AdvisorReviewQueueError =>
    error instanceof AdvisorRuntimeResetRequiredError
      ? new AdvisorQueueResetRequiredError({ message: failureMessage(error, fallback) })
      : new AdvisorQueueError({ message: failureMessage(error, fallback) });
function failureMessage<ErrorInput>(error: ErrorInput, fallback: string): string {
  return hasObjectRuntimeType(error) &&
    error !== null &&
    "message" in error &&
    Predicate.isString(error.message)
    ? error.message
    : fallback;
}
function isolate(action: () => void) {
  try {
    action();
  } catch {
    /* callback isolation */
  }
}
function renderPreviouslyProcessed(target: number): string {
  return renderObservations([
    {
      type: "truncation",
      marker: `Observations through sequence ${target} were already processed by an earlier coherent checkpoint.`,
      epoch: 0,
      sequence: target,
      parentTurnId: 0,
    },
  ]);
}
