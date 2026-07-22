/* oxlint-disable typescript/no-this-alias -- Effect.gen uses an explicit stable class receiver. */
import { makeSynchronousIngress, type SynchronousIngress } from "pi-cosmic-core";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeServiceShape,
} from "../runtime/runtime.ts";
import { AdvisorRuntimeResetRequiredError } from "../runtime/runtime.ts";
import { classifyAdvisorRuntimeFailure } from "../boundary/runtime-error-classifier.ts";
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
  resetReviewQueue,
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
export {
  AdvisorQueueBacklogExceededError,
  AdvisorQueueBatchDroppedError,
  AdvisorQueueCancelledError,
  AdvisorQueueCorrelationMismatchError,
  AdvisorQueueDisposedError,
  AdvisorQueueError,
  AdvisorQueueResetRequiredError,
  AdvisorQueueStaleEpochError,
} from "./errors.ts";

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

export class AdvisorReviewQueue {
  private readonly runtime: AdvisorRuntimeServiceShape;
  private readonly options: AdvisorReviewQueueOptions;
  private readonly resourceScope: Scope.Closeable;
  private readonly state: SynchronizedRef.SynchronizedRef<ReviewQueueState>;
  private readonly requestQueue: Queue.Queue<QueuedCheckpoint>;
  private readonly observations = new AdvisorObservationBuffer();
  private readonly requests = new Set<QueuedCheckpoint>();
  private readonly stateProjection: MutableRef.MutableRef<ReviewQueueState>;
  private checkpointFiber: Fiber.Fiber<void, never> | undefined;
  private steeringIngress: SynchronousIngress<void> | undefined;
  private initialized = false;

  constructor(
    runtime: AdvisorRuntimeServiceShape,
    options: AdvisorReviewQueueOptions,
    resourceScope: Scope.Closeable,
    state: SynchronizedRef.SynchronizedRef<ReviewQueueState>,
    requestQueue: Queue.Queue<QueuedCheckpoint>,
  ) {
    this.runtime = runtime;
    this.options = options;
    this.resourceScope = resourceScope;
    this.state = state;
    this.requestQueue = requestQueue;
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
    const self = this;
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const target = self.observations.freezeThrough(
          request.targetSequence ?? self.observations.sequence,
        );
        const waiter: QueuedCheckpoint = {
          request,
          target,
          epoch: MutableRef.get(self.stateProjection).epoch,
          done: yield* Deferred.make<AdvisorCheckpoint, AdvisorReviewQueueError>(),
          phase: "queued",
          cancelled: false,
        };
        yield* self.admit(waiter);
        return yield* restore(Deferred.await(waiter.done)).pipe(
          Effect.onInterrupt(() => self.cancelWaiterEffect(waiter)),
        );
      }),
    );
  }

  resetEffect(seed: string, stateSummary?: string) {
    const self = this;
    return Effect.gen(function* () {
      const before = MutableRef.get(self.stateProjection);
      if (before.disposed) return;
      const error = new AdvisorQueueResetRequiredError({
        message: "Advisor review queue was reset.",
      });
      const active = self.findActive(before);
      yield* self.transition((state) => resetReviewQueue(state));
      yield* self.rejectAll(error);
      const worker = self.checkpointFiber;
      self.checkpointFiber = undefined;
      if (worker) yield* interruptFiberWithin(worker);
      else
        yield* self.runtime
          .abort()
          .pipe(Effect.mapError(toQueueError("Advisor runtime abort failed.")));
      if (active) {
        self.requests.delete(active);
        isolate(() => self.options.onCheckpointSettled?.(active.request));
      }
      yield* self.clearRequestQueue();
      self.observations.reset(MutableRef.get(self.stateProjection).epoch);
      const current = MutableRef.get(self.stateProjection);
      if (current.disposed || current.epoch !== before.epoch + 1) return;
      yield* self.runtime
        .reprime(seed, stateSummary)
        .pipe(Effect.mapError(toQueueError("Advisor runtime re-prime failed.")));
      yield* self.startCheckpointWorker();
    });
  }

  disposeEffect() {
    return Scope.close(this.resourceScope, Exit.void);
  }

  private shutdownEffect() {
    const self = this;
    return Effect.gen(function* () {
      const before = MutableRef.get(self.stateProjection);
      if (before.disposed) return;
      const active = self.findActive(before);
      yield* self.transition(disposeReviewQueue);
      yield* self.rejectAll(
        new AdvisorQueueDisposedError({ message: "Advisor review queue was disposed." }),
      );
      yield* self.clearRequestQueue();
      if (self.checkpointFiber) yield* interruptFiberWithin(self.checkpointFiber);
      self.checkpointFiber = undefined;
      if (active) self.requests.delete(active);
      const steeringIngress = self.steeringIngress;
      self.steeringIngress = undefined;
      if (steeringIngress) {
        yield* steeringIngress.shutdown;
        yield* steeringIngress.awaitShutdown;
      }
      yield* Queue.shutdown(self.requestQueue);
      yield* self.runtime.dispose();
    });
  }

  cancelCheckpointEffect(checkpointId: string) {
    const self = this;
    return Effect.gen(function* () {
      const waiter = [...self.requests].find(
        (candidate) => candidate.request.checkpointId === checkpointId,
      );
      if (!waiter) return;
      yield* self.cancelWaiterEffect(waiter);
    });
  }

  private cancelWaiterEffect(waiter: QueuedCheckpoint) {
    const self = this;
    return Effect.uninterruptible(
      Effect.gen(function* () {
        const checkpointId = waiter.request.checkpointId;
        const error = new AdvisorQueueCancelledError({
          message: "Advisor checkpoint was cancelled.",
        });
        const disposition = yield* SynchronizedRef.modifyEffect(self.state, (current) =>
          Effect.gen(function* () {
            if (!self.requests.has(waiter) || waiter.phase === "settled" || waiter.cancelled)
              return ["settled" as const, current] as const;
            if (waiter.phase === "active") {
              waiter.phase = "settled";
              waiter.cancelled = true;
              self.requests.delete(waiter);
              yield* Deferred.fail(waiter.done, error);
              return ["active" as const, current] as const;
            }
            waiter.phase = "settled";
            waiter.cancelled = true;
            self.requests.delete(waiter);
            self.observations.releaseBarrier(waiter.target);
            yield* Deferred.fail(waiter.done, error);
            yield* self.compactRequestQueue();
            const next = cancelQueuedCheckpoint(current);
            self.publish(next);
            return ["queued" as const, next] as const;
          }),
        );
        if (disposition !== "active") return;

        const worker = self.checkpointFiber;
        self.checkpointFiber = undefined;
        if (worker) yield* interruptFiberWithin(worker);
        self.observations.releaseBarrier(waiter.target);
        yield* self.transition((state) => settleCheckpoint(state, checkpointId));
        isolate(() => self.options.onCheckpointSettled?.(waiter.request));
        if (!MutableRef.get(self.stateProjection).disposed) yield* self.startCheckpointWorker();
      }),
    );
  }

  initializeEffect() {
    const self = this;
    return Effect.suspend(() => {
      if (self.initialized) return Effect.void;
      self.initialized = true;
      return Effect.gen(function* () {
        self.steeringIngress = yield* makeSynchronousIngress<void, never, never>({
          capacity: 1,
          overflow: "coalesce-latest",
          handle: () => self.flushActiveSteering(),
        }).pipe(Effect.provideService(Scope.Scope, self.resourceScope), Effect.orDie);
        yield* self.startCheckpointWorker();
        yield* Scope.addFinalizer(self.resourceScope, self.shutdownEffect());
      }).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? Scope.close(self.resourceScope, exit).pipe(Effect.andThen(self.runtime.dispose()))
            : Effect.void,
        ),
      );
    });
  }

  private startCheckpointWorker() {
    const self = this;
    return Effect.gen(function* () {
      if (self.checkpointFiber || MutableRef.get(self.stateProjection).disposed) return;
      self.checkpointFiber = yield* Effect.forkIn(
        Effect.forever(
          Queue.take(self.requestQueue).pipe(Effect.flatMap((item) => self.consume(item))),
        ),
        self.resourceScope,
        { startImmediately: true },
      );
    });
  }

  private admit(waiter: QueuedCheckpoint) {
    const self = this;
    return SynchronizedRef.modifyEffect(self.state, (current) =>
      Effect.gen(function* () {
        if (current.disposed) {
          waiter.phase = "settled";
          self.observations.releaseBarrier(waiter.target);
          return yield* new AdvisorQueueDisposedError({
            message: "Advisor review queue is disposed.",
          });
        }
        let next = current;
        const queuedLimit = MAX_PENDING_CHECKPOINTS + (current.active ? 0 : 1);
        const mustEvict = current.pendingCount >= queuedLimit;
        if (mustEvict) {
          const evicted = Option.getOrUndefined(yield* Queue.poll(self.requestQueue));
          if (evicted) {
            evicted.phase = "settled";
            self.requests.delete(evicted);
            self.observations.releaseBarrier(evicted.target);
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
        self.requests.add(waiter);
        if (!(yield* Queue.offer(self.requestQueue, waiter))) {
          waiter.phase = "settled";
          self.requests.delete(waiter);
          self.observations.releaseBarrier(waiter.target);
          return yield* new AdvisorQueueBacklogExceededError({
            message: "Advisor checkpoint backlog exceeded its bound.",
          });
        }
        next = enqueueCheckpoint(next);
        self.publish(next);
        return [undefined, next] as const;
      }),
    );
  }

  private consume(waiter: QueuedCheckpoint) {
    const self = this;
    return Effect.gen(function* () {
      const claim = yield* SynchronizedRef.modify(self.state, (current) => {
        if (waiter.cancelled || waiter.phase !== "queued" || !self.requests.has(waiter))
          return ["cancelled", current] as const;
        if (current.disposed || current.epoch !== waiter.epoch) {
          waiter.phase = "settled";
          self.requests.delete(waiter);
          self.observations.releaseBarrier(waiter.target);
          return ["stale", current] as const;
        }
        waiter.phase = "active";
        const next = beginCheckpoint(
          current,
          waiter.request.checkpointId,
          waiter.target,
          waiter.epoch,
        );
        self.publish(next);
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
      isolate(() => self.options.onCheckpointStart?.(waiter.request));
      const batch = self.observations.peekThrough(waiter.target);
      const runtimeRequest: AdvisorCheckpointRequest = {
        checkpointId: waiter.request.checkpointId,
        processedThrough: waiter.target,
        observations: batch?.rendered ?? renderPreviouslyProcessed(waiter.target),
        focus: waiter.request.focus,
        ...(waiter.request.verificationReview
          ? { verificationReview: waiter.request.verificationReview }
          : {}),
      };
      const result = yield* self
        .checkpointWithBoundedRecovery(runtimeRequest, waiter.epoch)
        .pipe(Effect.exit);
      let settled = false;
      if (result._tag === "Success") {
        const checkpoint = result.value;
        const latest = MutableRef.get(self.stateProjection);
        if (waiter.epoch !== latest.epoch || latest.disposed) {
          settled = yield* self.settleClaimedWaiterEffect(waiter);
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
          settled = yield* self.settleClaimedWaiterEffect(waiter);
          if (settled)
            yield* Deferred.fail(
              waiter.done,
              new AdvisorQueueCorrelationMismatchError({
                message: "Advisor checkpoint correlation mismatch.",
              }),
            );
        } else {
          settled = yield* self.settleClaimedWaiterEffect(waiter, checkpoint.processedThrough);
          if (settled) yield* Deferred.succeed(waiter.done, checkpoint);
        }
      } else {
        const failure = Option.getOrUndefined(Cause.findErrorOption(result.cause));
        const error = isAdvisorReviewQueueError(failure)
          ? failure
          : new AdvisorQueueError({ message: "Advisor checkpoint failed." });
        settled = yield* self.settleClaimedWaiterEffect(waiter);
        if (settled) yield* Deferred.fail(waiter.done, error);
      }
      if (settled) isolate(() => self.options.onCheckpointSettled?.(waiter.request));
    });
  }

  private checkpointWithBoundedRecovery(request: AdvisorCheckpointRequest, expectedEpoch: number) {
    const self = this;
    return Effect.gen(function* () {
      let retried = false;
      while (true) {
        yield* self.assertRecoveryCurrentEffect(expectedEpoch);
        const attempt = yield* self.runtime.checkpoint(request).pipe(
          Effect.mapError(toQueueError("Advisor checkpoint failed.")),
          Effect.onInterrupt(() => self.runtime.abort()),
          Effect.exit,
        );
        if (attempt._tag === "Success") return attempt.value;
        yield* self.assertRecoveryCurrentEffect(expectedEpoch);
        const failure = Option.getOrUndefined(Cause.findErrorOption(attempt.cause));
        if (classifyAdvisorRuntimeFailure(failure) !== "reset-required")
          return yield* new AdvisorQueueError({
            message: failureMessage(failure, "Advisor checkpoint failed."),
          });
        const state = self.options.getReprimeState?.();
        if (!state)
          return yield* new AdvisorQueueResetRequiredError({
            message: "Advisor checkpoint requires a fresh context.",
          });
        isolate(() => self.options.onRuntimeReset?.("Advisor runtime requires a fresh context."));
        yield* self.runtime
          .reprime(state.seed, state.stateSummary)
          .pipe(Effect.mapError(toQueueError("Advisor runtime re-prime failed.")));
        yield* self.assertRecoveryCurrentEffect(expectedEpoch);
        if (retried) {
          self.observations.commitThrough(request.processedThrough);
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
    const self = this;
    return Effect.gen(function* () {
      const state = MutableRef.get(self.stateProjection);
      const active = state.active;
      if (!active || state.disposed || active.epoch !== state.epoch) return;
      const through = self.observations.sequence;
      const batch = self.observations.peekRange(active.steeredThrough, through);
      if (!batch) return;
      yield* self.transition((current) => attemptSteering(current, active.checkpointId, through));
      const accepted = yield* self.runtime.steer(batch.rendered).pipe(
        Effect.mapError(toQueueError("Advisor steering failed.")),
        Effect.catch(() => Effect.succeed(false)),
      );
      const latest = MutableRef.get(self.stateProjection);
      if (
        accepted &&
        latest.active?.checkpointId === active.checkpointId &&
        latest.epoch === active.epoch &&
        !latest.disposed
      )
        yield* self.transition((current) => acceptSteering(current, active.checkpointId, through));
      const after = MutableRef.get(self.stateProjection);
      if (
        after.active?.checkpointId === active.checkpointId &&
        self.observations.sequence > after.active.steeringAttemptedThrough
      )
        self.steeringIngress?.offer(undefined);
    });
  }

  private transition(update: (state: ReviewQueueState) => ReviewQueueState) {
    const self = this;
    return SynchronizedRef.modify(self.state, (current) => {
      const next = update(current);
      self.publish(next);
      return [undefined, next] as const;
    });
  }

  private settleClaimedWaiterEffect(waiter: QueuedCheckpoint, processedThrough?: number) {
    const self = this;
    return SynchronizedRef.modify(self.state, (current) => {
      if (waiter.phase !== "active" || !self.requests.has(waiter)) return [false, current] as const;
      waiter.phase = "settled";
      self.requests.delete(waiter);
      if (processedThrough !== undefined) self.observations.commitThrough(processedThrough);
      const next = settleCheckpoint(current, waiter.request.checkpointId, processedThrough);
      self.publish(next);
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
    const self = this;
    return Effect.forEach(
      [...self.requests],
      (waiter) =>
        Effect.gen(function* () {
          self.observations.releaseBarrier(waiter.target);
          waiter.phase = "settled";
          waiter.cancelled = true;
          yield* Deferred.fail(waiter.done, error);
        }),
      { discard: true },
    );
  }

  private compactRequestQueue() {
    const self = this;
    return Effect.gen(function* () {
      const live: QueuedCheckpoint[] = [];
      while (true) {
        const next = yield* Queue.poll(self.requestQueue);
        if (Option.isNone(next)) break;
        if (next.value.phase === "queued" && !next.value.cancelled && self.requests.has(next.value))
          live.push(next.value);
      }
      for (const waiter of live) {
        if (!(yield* Queue.offer(self.requestQueue, waiter))) {
          return yield* Effect.die("Advisor request queue compaction exceeded its bound.");
        }
      }
    });
  }

  private clearRequestQueue() {
    const self = this;
    return Effect.gen(function* () {
      while (true) {
        const next = yield* Queue.poll(self.requestQueue);
        if (Option.isNone(next)) break;
        next.value.phase = "settled";
        self.requests.delete(next.value);
      }
    });
  }
}

export interface AdvisorReviewQueueServiceShape {
  readonly make: (
    runtime: AdvisorRuntimeServiceShape,
    options?: AdvisorReviewQueueOptions,
  ) => Effect.Effect<AdvisorReviewQueue>;
}
export class AdvisorReviewQueueService extends Context.Service<
  AdvisorReviewQueueService,
  AdvisorReviewQueueServiceShape
>()("pi-advisor/queue/service/AdvisorReviewQueueService") {}

export const advisorReviewQueueServiceLayer = Layer.effect(
  AdvisorReviewQueueService,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    return AdvisorReviewQueueService.of({
      make: (runtime, options = {}) =>
        Effect.gen(function* () {
          const state = yield* SynchronizedRef.make(initialReviewQueueState());
          const requestQueue = yield* Queue.dropping<QueuedCheckpoint>(MAX_PENDING_CHECKPOINTS + 1);
          const resourceScope = yield* Scope.fork(scope);
          const queue = new AdvisorReviewQueue(
            runtime,
            options,
            resourceScope,
            state,
            requestQueue,
          );
          yield* queue.initializeEffect();
          return queue;
        }),
    });
  }),
);

/** Interrupts and joins the queue worker, including all interruption finalizers. */
const interruptFiberWithin = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Fiber.interrupt(fiber).pipe(Effect.asVoid);

const toQueueError =
  (fallback: string) =>
  (error: unknown): AdvisorReviewQueueError =>
    error instanceof AdvisorRuntimeResetRequiredError
      ? new AdvisorQueueResetRequiredError({ message: failureMessage(error, fallback) })
      : new AdvisorQueueError({ message: failureMessage(error, fallback) });
function failureMessage(error: unknown, fallback: string): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
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
