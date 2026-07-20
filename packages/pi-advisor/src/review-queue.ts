/* oxlint-disable typescript/no-this-alias -- Effect.gen uses an explicit stable class receiver. */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeServiceShape,
} from "./advisor-runtime.ts";
import { AdvisorRuntimeResetRequiredError, MAX_ADVISOR_ABORT_MS } from "./advisor-runtime.ts";
import {
  AdvisorObservationBuffer,
  renderObservations,
  type AdvisorObservation,
  type AdvisorObservationInput,
} from "./observation-protocol.ts";
import type { AdvisorReview, AdvisorReviewFocus } from "./review.ts";

export const MAX_PENDING_CHECKPOINTS = 16;
export interface ReviewQueueCheckpointRequest {
  checkpointId: string;
  focus: AdvisorReviewFocus;
  parentTurnId: number;
  targetSequence?: number | undefined;
  verificationReview?: AdvisorReview | undefined;
}
export class AdvisorQueueError extends Schema.TaggedErrorClass<AdvisorQueueError>()(
  "AdvisorQueueError",
  { message: Schema.String },
) {}
class AdvisorBatchDroppedError extends AdvisorQueueError {}
interface Waiter {
  request: ReviewQueueCheckpointRequest;
  target: number;
  epoch: number;
  done: Deferred.Deferred<AdvisorCheckpoint, AdvisorQueueError>;
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
  private readonly observations = new AdvisorObservationBuffer();
  private readonly waiters: Waiter[] = [];
  private readonly steeringLock: Semaphore.Semaphore;
  private readonly initializationLock: Semaphore.Semaphore;
  private epoch = 0;
  private pumping = false;
  private pumpMailbox: Queue.Queue<void> | undefined;
  private pumpFiber: Fiber.Fiber<void, never> | undefined;
  private steeringMailbox: Queue.Queue<void> | undefined;
  private steeringFiber: Fiber.Fiber<void, never> | undefined;
  private activeWaiter: Waiter | undefined;
  private activeSteeredThrough = 0;
  private steeringAttemptedThrough = 0;
  private steeringScheduled = false;
  private disposed = false;
  private readonly processedThroughRef: Ref.Ref<number>;
  private processedThroughProjection = 0;
  private readonly runtime: AdvisorRuntimeServiceShape;
  private readonly options: AdvisorReviewQueueOptions;
  private readonly resourceScope: Scope.Scope;
  constructor(
    runtime: AdvisorRuntimeServiceShape,
    options: AdvisorReviewQueueOptions,
    resourceScope: Scope.Scope,
    steeringLock: Semaphore.Semaphore,
    initializationLock: Semaphore.Semaphore,
    processedThroughRef: Ref.Ref<number>,
  ) {
    this.runtime = runtime;
    this.options = options;
    this.resourceScope = resourceScope;
    this.steeringLock = steeringLock;
    this.initializationLock = initializationLock;
    this.processedThroughRef = processedThroughRef;
  }
  get processedThrough() {
    return this.processedThroughProjection;
  }
  get sequence() {
    return this.observations.sequence;
  }
  get backlog() {
    return this.observations.size;
  }
  get pendingCheckpoints() {
    return this.waiters.length + (this.activeWaiter ? 1 : 0);
  }
  get hasActiveCheckpoint() {
    return Boolean(this.activeWaiter);
  }
  get activeToolNames() {
    return this.runtime.activeToolNames();
  }
  ingest(parentTurnId: number, input: AdvisorObservationInput): AdvisorObservation {
    if (this.disposed)
      throw new AdvisorQueueError({ message: "Advisor review queue is disposed." });
    const record = this.observations.ingest(parentTurnId, input);
    if (this.activeWaiter && record.sequence > this.activeWaiter.target)
      this.scheduleActiveSteering();
    return record;
  }
  checkpointEffect(request: ReviewQueueCheckpointRequest) {
    const self = this;
    return Effect.gen(function* () {
      if (self.disposed)
        return yield* new AdvisorQueueError({ message: "Advisor review queue is disposed." });
      const target = self.observations.freezeThrough(
        request.targetSequence ?? self.observations.sequence,
      );
      const done = yield* Deferred.make<AdvisorCheckpoint, AdvisorQueueError>();
      const queuedLimit = MAX_PENDING_CHECKPOINTS + (self.activeWaiter ? 0 : 1);
      if (self.waiters.length >= queuedLimit) {
        const dropped = self.waiters.shift();
        if (dropped)
          yield* Deferred.fail(
            dropped.done,
            new AdvisorQueueError({ message: "Advisor checkpoint backlog exceeded its bound." }),
          );
      }
      self.waiters.push({ request, target, epoch: self.epoch, done });
      yield* self.initializeEffect();
      self.schedulePump();
      return yield* Deferred.await(done);
    });
  }
  resetEffect(seed: string, stateSummary?: string) {
    const self = this;
    return Effect.gen(function* () {
      const resetEpoch = ++self.epoch;
      const error = new AdvisorQueueError({ message: "Advisor review queue was reset." });
      yield* self.releaseWaitersEffect(error);
      yield* self.rejectActiveEffect(error);
      self.activeSteeredThrough = 0;
      self.steeringAttemptedThrough = 0;
      self.steeringScheduled = false;
      self.observations.reset(resetEpoch);
      yield* Ref.set(self.processedThroughRef, 0);
      self.processedThroughProjection = 0;
      const pumpFiber = self.pumpFiber;
      const steeringFiber = self.steeringFiber;
      self.pumpFiber = undefined;
      self.pumpMailbox = undefined;
      self.steeringFiber = undefined;
      self.steeringMailbox = undefined;
      if (pumpFiber) yield* interruptFiberWithin(pumpFiber);
      if (steeringFiber) yield* interruptFiberWithin(steeringFiber);
      yield* self.runtime
        .abort()
        .pipe(Effect.mapError(toQueueError("Advisor runtime abort failed.")));
      if (resetEpoch !== self.epoch || self.disposed) return;
      yield* self.runtime
        .reprime(seed, stateSummary)
        .pipe(Effect.mapError(toQueueError("Advisor runtime re-prime failed.")));
      yield* self.initializeEffect();
    });
  }
  disposeEffect() {
    const self = this;
    return Effect.gen(function* () {
      if (self.disposed) return;
      self.disposed = true;
      self.epoch++;
      const error = new AdvisorQueueError({ message: "Advisor review queue was disposed." });
      yield* self.releaseWaitersEffect(error);
      yield* self.rejectActiveEffect(error);
      const pumpFiber = self.pumpFiber;
      const steeringFiber = self.steeringFiber;
      self.pumpFiber = undefined;
      self.pumpMailbox = undefined;
      self.steeringFiber = undefined;
      self.steeringMailbox = undefined;
      if (pumpFiber) yield* interruptFiberWithin(pumpFiber);
      if (steeringFiber) yield* interruptFiberWithin(steeringFiber);
      yield* self.runtime.dispose();
    });
  }
  cancelCheckpointEffect(checkpointId: string) {
    const self = this;
    return Effect.gen(function* () {
      const queuedIndex = self.waiters.findIndex(
        (waiter) => waiter.request.checkpointId === checkpointId,
      );
      if (queuedIndex >= 0) {
        const [waiter] = self.waiters.splice(queuedIndex, 1);
        if (waiter) {
          self.observations.releaseBarrier(waiter.target);
          yield* Deferred.fail(
            waiter.done,
            new AdvisorQueueError({ message: "Advisor checkpoint was cancelled." }),
          );
        }
        return;
      }
      const active = self.activeWaiter;
      if (!active || active.request.checkpointId !== checkpointId) return;
      self.observations.releaseBarrier(active.target);
      yield* Deferred.fail(
        active.done,
        new AdvisorQueueError({ message: "Advisor checkpoint was cancelled." }),
      );
      self.activeWaiter = undefined;
      const pump = self.pumpFiber;
      const steering = self.steeringFiber;
      self.pumpFiber = undefined;
      self.pumpMailbox = undefined;
      self.steeringFiber = undefined;
      self.steeringMailbox = undefined;
      if (steering) yield* interruptFiberWithin(steering);
      if (pump) yield* interruptFiberWithin(pump);
      else {
        yield* self.runtime.abort();
      }
      if (!self.disposed) {
        yield* self.initializeEffect();
        self.schedulePump();
      }
    });
  }
  initializeEffect() {
    const self = this;
    return self.initializationLock.withPermits(1)(
      Effect.gen(function* () {
        if (self.disposed || self.pumpFiber) return;
        const pumpMailbox = yield* Queue.dropping<void>(1);
        const steeringMailbox = yield* Queue.dropping<void>(1);
        self.pumpMailbox = pumpMailbox;
        self.steeringMailbox = steeringMailbox;
        const pumpWorker = Effect.gen(function* () {
          while (!self.disposed) {
            yield* self.pumpEffect();
            if (self.disposed) break;
            yield* Queue.take(pumpMailbox);
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (self.pumpMailbox === pumpMailbox) self.pumpMailbox = undefined;
              self.pumpFiber = undefined;
            }),
          ),
        );
        const steeringWorker = Effect.gen(function* () {
          while (!self.disposed) {
            yield* Queue.take(steeringMailbox);
            if (self.disposed) break;
            yield* self.steeringLock.withPermits(1)(self.flushActiveSteering());
            self.steeringScheduled = false;
            if (self.activeWaiter && self.observations.sequence > self.steeringAttemptedThrough) {
              self.scheduleActiveSteering();
            }
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (self.steeringMailbox === steeringMailbox) self.steeringMailbox = undefined;
              self.steeringFiber = undefined;
            }),
          ),
        );
        self.pumpFiber = yield* Effect.forkIn(pumpWorker, self.resourceScope, {
          startImmediately: true,
        });
        self.steeringFiber = yield* Effect.forkIn(steeringWorker, self.resourceScope, {
          startImmediately: true,
        });
      }),
    );
  }
  private schedulePump() {
    if (!this.disposed && this.pumpMailbox) Queue.offerUnsafe(this.pumpMailbox, undefined);
  }
  private pumpEffect() {
    const self = this;
    let ownsPump = false;
    return Effect.gen(function* () {
      if (self.pumping || self.disposed) return;
      self.pumping = true;
      ownsPump = true;
      while (!self.disposed && self.waiters.length > 0) {
        const waiter = self.waiters.shift();
        if (!waiter || waiter.epoch !== self.epoch) continue;
        self.activeWaiter = waiter;
        self.activeSteeredThrough = waiter.target;
        self.steeringAttemptedThrough = waiter.target;
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
        if (result._tag === "Success") {
          const checkpoint = result.value;
          if (waiter.epoch !== self.epoch || self.disposed) {
            yield* Deferred.fail(
              waiter.done,
              new AdvisorQueueError({
                message: "Advisor checkpoint completed for a stale queue epoch.",
              }),
            );
          } else if (
            checkpoint.checkpointId !== waiter.request.checkpointId ||
            checkpoint.processedThrough !== waiter.target
          ) {
            yield* Deferred.fail(
              waiter.done,
              new AdvisorQueueError({ message: "Advisor checkpoint correlation mismatch." }),
            );
          } else {
            self.observations.commitThrough(checkpoint.processedThrough);
            yield* Ref.update(self.processedThroughRef, (processed) =>
              Math.max(processed, checkpoint.processedThrough),
            );
            self.processedThroughProjection = Math.max(
              self.processedThroughProjection,
              checkpoint.processedThrough,
            );
            yield* Deferred.succeed(waiter.done, checkpoint);
          }
        } else {
          const failure = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          const error =
            failure instanceof AdvisorQueueError
              ? failure
              : new AdvisorQueueError({ message: "Advisor checkpoint failed." });
          yield* Deferred.fail(waiter.done, error);
        }
        if (self.activeWaiter === waiter) {
          self.activeWaiter = undefined;
          self.activeSteeredThrough = 0;
          self.steeringAttemptedThrough = 0;
        }
        isolate(() => self.options.onCheckpointSettled?.(waiter.request));
      }
      self.pumping = false;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (ownsPump) self.pumping = false;
        }),
      ),
    );
  }
  private checkpointWithBoundedRecovery(request: AdvisorCheckpointRequest, expectedEpoch: number) {
    const self = this;
    return Effect.gen(function* () {
      let retried = false;
      while (true) {
        yield* self.assertRecoveryCurrentEffect(expectedEpoch);
        const checkpointEffect = self.runtime
          .checkpoint(request)
          .pipe(Effect.mapError(toQueueError("Advisor checkpoint failed.")));
        const attempt = yield* checkpointEffect.pipe(
          Effect.onInterrupt(() => self.runtime.abort()),
          Effect.exit,
        );
        if (attempt._tag === "Success") return attempt.value;
        yield* self.assertRecoveryCurrentEffect(expectedEpoch);
        const failure = Option.getOrUndefined(Cause.findErrorOption(attempt.cause));
        if (!isReprimeRequired(failure))
          return yield* new AdvisorQueueError({
            message: failureMessage(failure, "Advisor checkpoint failed."),
          });
        const state = self.options.getReprimeState?.();
        if (!state)
          return yield* new AdvisorQueueError({
            message: "Advisor checkpoint requires a fresh context.",
          });
        isolate(() => self.options.onRuntimeReset?.("Advisor runtime requires a fresh context."));
        yield* self.runtime
          .reprime(state.seed, state.stateSummary)
          .pipe(Effect.mapError(toQueueError("Advisor runtime re-prime failed.")));
        yield* self.assertRecoveryCurrentEffect(expectedEpoch);
        if (retried) {
          self.observations.commitThrough(request.processedThrough);
          return yield* new AdvisorBatchDroppedError({
            message: "Advisor batch failed again after one fresh-context retry and was dropped.",
          });
        }
        retried = true;
      }
    });
  }
  private assertRecoveryCurrentEffect(expectedEpoch: number) {
    return this.disposed || expectedEpoch !== this.epoch
      ? Effect.fail(new AdvisorQueueError({ message: "Advisor checkpoint recovery became stale." }))
      : Effect.void;
  }
  private scheduleActiveSteering() {
    if (this.steeringScheduled || this.disposed || !this.steeringMailbox) return;
    this.steeringScheduled = true;
    Queue.offerUnsafe(this.steeringMailbox, undefined);
  }
  private flushActiveSteering() {
    const self = this;
    return Effect.gen(function* () {
      const waiter = self.activeWaiter;
      if (!waiter || waiter.epoch !== self.epoch || self.disposed) return;
      const through = self.observations.sequence;
      const batch = self.observations.peekRange(self.activeSteeredThrough, through);
      if (!batch) return;
      self.steeringAttemptedThrough = Math.max(self.steeringAttemptedThrough, through);
      const accepted = yield* self.runtime.steer(batch.rendered).pipe(
        Effect.mapError(toQueueError("Advisor steering failed.")),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (accepted && self.activeWaiter === waiter && waiter.epoch === self.epoch && !self.disposed)
        self.activeSteeredThrough = Math.max(self.activeSteeredThrough, through);
    });
  }
  private releaseWaitersEffect(error: AdvisorQueueError) {
    return Effect.forEach(this.waiters.splice(0), (waiter) => Deferred.fail(waiter.done, error), {
      discard: true,
    });
  }
  private rejectActiveEffect(error: AdvisorQueueError) {
    const active = this.activeWaiter;
    this.activeWaiter = undefined;
    return active ? Deferred.fail(active.done, error).pipe(Effect.asVoid) : Effect.void;
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
>()("pi-advisor/review-queue/AdvisorReviewQueueService") {}

export const advisorReviewQueueServiceLayer = Layer.effect(
  AdvisorReviewQueueService,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    return AdvisorReviewQueueService.of({
      make: (runtime, options = {}) =>
        Effect.gen(function* () {
          const steeringLock = yield* Semaphore.make(1);
          const initializationLock = yield* Semaphore.make(1);
          const processedThroughRef = yield* Ref.make(0);
          const queue = new AdvisorReviewQueue(
            runtime,
            options,
            scope,
            steeringLock,
            initializationLock,
            processedThroughRef,
          );
          yield* Scope.addFinalizer(scope, queue.disposeEffect());
          yield* queue.initializeEffect();
          return queue;
        }),
    });
  }),
);

const interruptFiberWithin = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Fiber.interrupt(fiber).pipe(
    Effect.timeout(Duration.millis(MAX_ADVISOR_ABORT_MS)),
    Effect.catch(() => Effect.void),
    Effect.asVoid,
  );

const toQueueError = (fallback: string) => (error: unknown) =>
  error instanceof AdvisorRuntimeResetRequiredError
    ? error
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
function isReprimeRequired(error: unknown): boolean {
  if (error instanceof AdvisorRuntimeResetRequiredError) return true;
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return /(?:context|overflow|too large|maximum response size|malformed checkpoint|compaction)/.test(
    message,
  );
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
