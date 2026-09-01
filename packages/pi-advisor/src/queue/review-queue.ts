import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  hasObjectRuntimeType,
  invokeHostCallback,
  makeSynchronousIngress,
  type SynchronousIngress,
} from "pi-cosmic-core";
import { classifyAdvisorRuntimeFailure } from "../domain/runtime-error-classifier.ts";
import {
  AdvisorObservationBuffer,
  type AdvisorObservation,
  type AdvisorObservationInput,
} from "../review/observation-protocol.ts";
import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeServiceContract,
} from "../runtime/runtime.ts";
import {
  AdvisorQueueBatchDroppedError,
  AdvisorQueueCancelledError,
  AdvisorQueueCorrelationMismatchError,
  AdvisorQueueDisposedError,
  AdvisorQueueError,
  AdvisorQueueResetRequiredError,
  isAdvisorReviewQueueError,
  type AdvisorReviewQueueError,
} from "./errors.ts";
import {
  acceptSteering,
  admitCheckpoint,
  cancelCheckpointById,
  cancelCheckpointByToken,
  claimNextCheckpoint,
  claimSteering,
  disposeReviewQueue,
  finishActiveCancellation,
  initialReviewQueueState,
  isRunningCheckpoint,
  settleRunningCheckpoint,
  type AdmissionDecision,
  type CancellationDecision,
  type ReviewQueueCheckpointRequest,
  type ReviewQueueEntry,
  type ReviewQueueEntryToken,
  type ReviewQueueState,
  type RunningReviewCheckpoint,
} from "./state.ts";

export const MAX_PENDING_CHECKPOINTS = 16;
export type { ReviewQueueCheckpointRequest } from "./state.ts";

export interface AdvisorReprimeState {
  readonly seed: string;
  readonly stateSummary?: string | undefined;
}

export interface AdvisorReviewQueueOptions {
  readonly onCheckpointStart?: ((request: ReviewQueueCheckpointRequest) => void) | undefined;
  readonly onCheckpointSettled?: ((request: ReviewQueueCheckpointRequest) => void) | undefined;
  readonly getReprimeState?: (() => AdvisorReprimeState) | undefined;
}

export interface AdvisorReviewQueue {
  readonly processedThrough: number;
  readonly backlog: number;
  readonly pendingCheckpoints: number;
  readonly hasActiveCheckpoint: boolean;
  readonly ingest: (parentTurnId: number, input: AdvisorObservationInput) => AdvisorObservation;
  readonly checkpointEffect: (
    request: ReviewQueueCheckpointRequest,
  ) => Effect.Effect<AdvisorCheckpoint, AdvisorReviewQueueError>;
  readonly disposeEffect: () => Effect.Effect<void>;
  readonly cancelCheckpointEffect: (checkpointId: string) => Effect.Effect<void>;
}

type CheckpointCompletion =
  | { readonly _tag: "Success"; readonly checkpoint: AdvisorCheckpoint }
  | {
      readonly _tag: "Failure";
      readonly error: AdvisorReviewQueueError;
      readonly commitEvidence: boolean;
    };

class AdvisorReviewQueueImpl implements AdvisorReviewQueue {
  private readonly observations = new AdvisorObservationBuffer();
  private readonly runtime: AdvisorRuntimeServiceContract;
  private readonly options: AdvisorReviewQueueOptions;
  private readonly resourceScope: Scope.Closeable;
  private readonly state: SynchronizedRef.SynchronizedRef<ReviewQueueState>;
  private readonly checkpointWorker: FiberHandle.FiberHandle<void, never>;
  private readonly steeringIngress: SynchronousIngress<void>;

  constructor(
    runtime: AdvisorRuntimeServiceContract,
    options: AdvisorReviewQueueOptions,
    resourceScope: Scope.Closeable,
    state: SynchronizedRef.SynchronizedRef<ReviewQueueState>,
    checkpointWorker: FiberHandle.FiberHandle<void, never>,
    steeringIngress: SynchronousIngress<void>,
  ) {
    this.runtime = runtime;
    this.options = options;
    this.resourceScope = resourceScope;
    this.state = state;
    this.checkpointWorker = checkpointWorker;
    this.steeringIngress = steeringIngress;
  }

  get processedThrough(): number {
    return SynchronizedRef.getUnsafe(this.state).processedThrough;
  }

  get backlog(): number {
    return this.observations.size;
  }

  get pendingCheckpoints(): number {
    const state = SynchronizedRef.getUnsafe(this.state);
    return state.disposed ? 0 : state.queued.length + (state.active ? 1 : 0);
  }

  get hasActiveCheckpoint(): boolean {
    const state = SynchronizedRef.getUnsafe(this.state);
    return !state.disposed && state.active !== undefined;
  }

  ingest(parentTurnId: number, input: AdvisorObservationInput): AdvisorObservation {
    const state = SynchronizedRef.getUnsafe(this.state);
    if (state.disposed)
      throw new AdvisorQueueDisposedError({ message: "Advisor review queue is disposed." });
    const record = this.observations.ingest(parentTurnId, input);
    if (state.active?.phase === "running" && record.sequence > state.active.steeringClaimedThrough)
      this.steeringIngress.offer(undefined);
    return record;
  }

  checkpointEffect(request: ReviewQueueCheckpointRequest) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        const done = yield* Deferred.make<AdvisorCheckpoint, AdvisorReviewQueueError>();
        const entry: ReviewQueueEntry = {
          token: Symbol("advisor-review-checkpoint"),
          request,
          target: this.observations.sequence,
          done,
        };
        const nextWake = yield* Deferred.make<void>();
        const decision = yield* SynchronizedRef.modify(this.state, (current) =>
          admitCheckpoint(current, entry, nextWake, MAX_PENDING_CHECKPOINTS),
        );
        yield* this.afterAdmissionCommit(decision);
        return yield* restore(Deferred.await(done)).pipe(
          Effect.onInterrupt(() => this.cancelTokenEffect(entry.token)),
        );
      }),
    );
  }

  disposeEffect(): Effect.Effect<void> {
    return Scope.close(this.resourceScope, Exit.void);
  }

  cancelCheckpointEffect(checkpointId: string): Effect.Effect<void> {
    return Effect.uninterruptible(
      SynchronizedRef.modify(this.state, (current) =>
        cancelCheckpointById(current, checkpointId),
      ).pipe(Effect.flatMap((decision) => this.afterCancellationCommit(decision))),
    );
  }

  startCheckpointWorker(): Effect.Effect<void> {
    if (SynchronizedRef.getUnsafe(this.state).disposed) return Effect.void;
    return FiberHandle.run(this.checkpointWorker, {
      onlyIfMissing: true,
      startImmediately: true,
    })(Effect.forever(this.workerStep())).pipe(Effect.asVoid);
  }

  shutdownEffect(): Effect.Effect<void> {
    return Effect.uninterruptible(
      Effect.gen({ self: this }, function* () {
        const decision = yield* SynchronizedRef.modify(this.state, disposeReviewQueue);
        if (decision._tag === "AlreadyDisposed") return;

        yield* FiberHandle.clear(this.checkpointWorker);
        yield* this.steeringIngress.shutdown;
        yield* this.steeringIngress.awaitShutdown;
        yield* this.runtime.dispose();

        const entries = decision.active
          ? [decision.active, ...decision.queued]
          : [...decision.queued];
        for (const entry of entries) this.observations.releaseBarrier(entry.target);
        if (decision.active)
          invokeHostCallback(() => {
            this.options.onCheckpointSettled?.(decision.active!.request);
          }, undefined);

        const error = new AdvisorQueueDisposedError({
          message: "Advisor review queue was disposed.",
        });
        yield* Effect.forEach(entries, (entry) => Deferred.fail(entry.done, error), {
          discard: true,
        });
      }),
    );
  }

  flushActiveSteering(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const through = this.observations.sequence;
      const claim = yield* SynchronizedRef.modify(this.state, (current) =>
        claimSteering(current, through),
      );
      if (!claim) return;
      const batch = this.observations.peekRange(claim.after, claim.through);
      if (!batch) return;

      const accepted = yield* this.runtime
        .steer(batch.rendered)
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (accepted)
        yield* SynchronizedRef.modify(this.state, (current) => acceptSteering(current, claim));

      const latest = SynchronizedRef.getUnsafe(this.state);
      if (
        latest.active?.phase === "running" &&
        this.observations.sequence > latest.active.steeringClaimedThrough
      )
        this.steeringIngress.offer(undefined);
    });
  }

  private afterAdmissionCommit(decision: AdmissionDecision): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (decision._tag === "Disposed") {
        yield* Deferred.fail(
          decision.entry.done,
          new AdvisorQueueDisposedError({ message: "Advisor review queue is disposed." }),
        );
        return;
      }

      this.observations.freezeThrough(decision.entry.target);
      if (decision.evicted) this.observations.releaseBarrier(decision.evicted.target);
      if (decision.wake) yield* Deferred.succeed(decision.wake, undefined);
      if (decision.evicted)
        yield* Deferred.fail(
          decision.evicted.done,
          new AdvisorQueueBatchDroppedError({
            message: "Advisor checkpoint backlog exceeded its bound and was dropped.",
          }),
        );
    });
  }

  private workerStep(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const decision = yield* SynchronizedRef.modify(this.state, claimNextCheckpoint);
      if (decision._tag === "Stop") return yield* Effect.interrupt;
      if (decision._tag === "Wait") {
        yield* Deferred.await(decision.wake);
        return;
      }
      invokeHostCallback(() => {
        this.options.onCheckpointStart?.(decision.entry.request);
      }, undefined);
      yield* this.consume(decision.entry);
    });
  }

  private consume(entry: RunningReviewCheckpoint): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const batch = this.observations.peekThrough(entry.target);
      const baseRequest: AdvisorCheckpointRequest = {
        checkpointId: entry.request.checkpointId,
        processedThrough: entry.target,
        observations: batch?.rendered ?? renderPreviouslyProcessed(entry.target),
        focus: entry.request.focus,
      };
      const runtimeRequest: AdvisorCheckpointRequest =
        entry.request.verificationReview === undefined
          ? baseRequest
          : { ...baseRequest, verificationReview: entry.request.verificationReview };
      const recovered = yield* this.checkpointWithBoundedRecovery(runtimeRequest, entry);
      const completion: CheckpointCompletion =
        recovered._tag === "Success" &&
        (recovered.checkpoint.checkpointId !== entry.request.checkpointId ||
          recovered.checkpoint.processedThrough !== entry.target)
          ? {
              _tag: "Failure",
              error: new AdvisorQueueCorrelationMismatchError({
                message: "Advisor checkpoint correlation mismatch.",
              }),
              commitEvidence: false,
            }
          : recovered;
      yield* this.settleEntry(entry, completion);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : this.settleEntry(entry, {
              _tag: "Failure",
              error: new AdvisorQueueError({ message: "Advisor checkpoint failed." }),
              commitEvidence: false,
            }),
      ),
    );
  }

  private checkpointWithBoundedRecovery(
    request: AdvisorCheckpointRequest,
    entry: RunningReviewCheckpoint,
  ): Effect.Effect<CheckpointCompletion> {
    return Effect.gen({ self: this }, function* () {
      let retried = false;
      while (true) {
        if (!(yield* this.isRunning(entry.token))) return yield* Effect.interrupt;
        const attempt = yield* this.runtime.checkpoint(request).pipe(
          Effect.onInterrupt(() => this.runtime.abort()),
          Effect.exit,
        );
        if (attempt._tag === "Success")
          return { _tag: "Success", checkpoint: attempt.value } as const;
        if (!(yield* this.isRunning(entry.token))) return yield* Effect.interrupt;

        const failure = Option.getOrUndefined(Cause.findErrorOption(attempt.cause));
        if (classifyAdvisorRuntimeFailure(failure) !== "reset-required")
          return {
            _tag: "Failure",
            error: toQueueError(failure, "Advisor checkpoint failed."),
            commitEvidence: false,
          } as const;

        const reprimeState = this.options.getReprimeState?.();
        if (!reprimeState)
          return {
            _tag: "Failure",
            error: new AdvisorQueueResetRequiredError({
              message: "Advisor checkpoint requires a fresh context.",
            }),
            commitEvidence: false,
          } as const;

        if (!(yield* this.isRunning(entry.token))) return yield* Effect.interrupt;
        const reprime = yield* this.runtime
          .reprime(reprimeState.seed, reprimeState.stateSummary)
          .pipe(Effect.exit);
        if (reprime._tag === "Failure") {
          const reprimeFailure = Option.getOrUndefined(Cause.findErrorOption(reprime.cause));
          return {
            _tag: "Failure",
            error: toQueueError(reprimeFailure, "Advisor runtime re-prime failed."),
            commitEvidence: false,
          } as const;
        }
        if (!(yield* this.isRunning(entry.token))) return yield* Effect.interrupt;
        if (retried)
          return {
            _tag: "Failure",
            error: new AdvisorQueueBatchDroppedError({
              message: "Advisor batch failed again after one fresh-context retry and was dropped.",
            }),
            commitEvidence: true,
          } as const;
        retried = true;
      }
    });
  }

  private settleEntry(
    entry: RunningReviewCheckpoint,
    completion: CheckpointCompletion,
  ): Effect.Effect<void> {
    return Effect.uninterruptible(
      Effect.gen({ self: this }, function* () {
        const commitEvidence =
          completion._tag === "Success" ||
          (completion._tag === "Failure" && completion.commitEvidence);
        const nextWake = yield* Deferred.make<void>();
        const decision = yield* SynchronizedRef.modify(this.state, (current) =>
          settleRunningCheckpoint(
            current,
            entry.token,
            nextWake,
            commitEvidence ? entry.target : undefined,
          ),
        );
        if (!decision.settled) return;

        if (commitEvidence) this.observations.commitThrough(entry.target);
        else this.observations.releaseBarrier(entry.target);
        invokeHostCallback(() => {
          this.options.onCheckpointSettled?.(entry.request);
        }, undefined);
        if (decision.wake) yield* Deferred.succeed(decision.wake, undefined);

        if (completion._tag === "Success")
          yield* Deferred.succeed(entry.done, completion.checkpoint);
        else yield* Deferred.fail(entry.done, completion.error);
      }),
    );
  }

  private cancelTokenEffect(token: ReviewQueueEntryToken): Effect.Effect<void> {
    return Effect.uninterruptible(
      SynchronizedRef.modify(this.state, (current) => cancelCheckpointByToken(current, token)).pipe(
        Effect.flatMap((decision) => this.afterCancellationCommit(decision)),
      ),
    );
  }

  private afterCancellationCommit(decision: CancellationDecision): Effect.Effect<void> {
    if (decision._tag === "None") return Effect.void;
    if (decision._tag === "ActiveWait" || decision._tag === "DisposalWait")
      return Deferred.await(decision.entry.done).pipe(Effect.exit, Effect.asVoid);

    const error = new AdvisorQueueCancelledError({
      message: "Advisor checkpoint was cancelled.",
    });
    if (decision._tag === "Queued")
      return Effect.sync(() => this.observations.releaseBarrier(decision.entry.target)).pipe(
        Effect.andThen(Deferred.fail(decision.entry.done, error)),
        Effect.asVoid,
      );

    return Effect.gen({ self: this }, function* () {
      yield* FiberHandle.clear(this.checkpointWorker);
      const ownsSettlement = yield* SynchronizedRef.modify(this.state, (current) =>
        finishActiveCancellation(current, decision.entry.token),
      );
      if (!ownsSettlement) {
        yield* Deferred.await(decision.entry.done).pipe(Effect.exit);
        return;
      }

      this.observations.releaseBarrier(decision.entry.target);
      invokeHostCallback(() => {
        this.options.onCheckpointSettled?.(decision.entry.request);
      }, undefined);
      yield* this.startCheckpointWorker();
      yield* Deferred.fail(decision.entry.done, error);
    });
  }

  private isRunning(token: ReviewQueueEntryToken): Effect.Effect<boolean> {
    return SynchronizedRef.modify(this.state, (current) => isRunningCheckpoint(current, token));
  }
}

export const makeAdvisorReviewQueue = Effect.fn("AdvisorReviewQueue.make")(function* (
  runtime: AdvisorRuntimeServiceContract,
  options: AdvisorReviewQueueOptions = {},
) {
  const parentScope = yield* Effect.scope;
  const resourceScope = yield* Scope.fork(parentScope);
  const initialWake = yield* Deferred.make<void>();
  const state = yield* SynchronizedRef.make(initialReviewQueueState(initialWake));
  const checkpointWorker = yield* FiberHandle.make<void, never>().pipe(
    Effect.provideService(Scope.Scope, resourceScope),
  );
  let queue: AdvisorReviewQueueImpl | undefined;
  const steeringIngress = yield* makeSynchronousIngress<void, never, never>({
    capacity: 1,
    overflow: "coalesce-latest",
    handle: () => queue?.flushActiveSteering() ?? Effect.void,
  }).pipe(Effect.provideService(Scope.Scope, resourceScope), Effect.orDie);
  queue = new AdvisorReviewQueueImpl(
    runtime,
    options,
    resourceScope,
    state,
    checkpointWorker,
    steeringIngress,
  );
  yield* Scope.addFinalizer(resourceScope, queue.shutdownEffect());
  yield* queue.startCheckpointWorker();
  return queue satisfies AdvisorReviewQueue;
});

const toQueueError = <ErrorInput>(error: ErrorInput, fallback: string): AdvisorReviewQueueError =>
  isAdvisorReviewQueueError(error)
    ? error
    : new AdvisorQueueError({ message: failureMessage(error, fallback) });

function failureMessage<ErrorInput>(error: ErrorInput, fallback: string): string {
  return hasObjectRuntimeType(error) &&
    error !== null &&
    "message" in error &&
    Predicate.isString(error.message)
    ? error.message
    : fallback;
}

function renderPreviouslyProcessed(target: number): string {
  return `Observations through sequence ${target} were already processed by an earlier coherent checkpoint.`;
}
