import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeDriver,
} from "./advisor-runtime.ts";
import { AdvisorRuntimeResetRequiredError } from "./advisor-runtime.ts";
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
  targetSequence?: number;
  verificationReview?: AdvisorReview;
}

class AdvisorBatchDroppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisorBatchDroppedError";
  }
}

interface Waiter {
  request: ReviewQueueCheckpointRequest;
  target: number;
  epoch: number;
  resolve: (result: AdvisorCheckpoint) => void;
  reject: (error: unknown) => void;
}

export interface AdvisorReprimeState {
  seed: string;
  stateSummary?: string;
}

export interface AdvisorReviewQueueOptions {
  onCheckpointStart?: (request: ReviewQueueCheckpointRequest) => void;
  onCheckpointSettled?: (request: ReviewQueueCheckpointRequest) => void;
  onRuntimeReset?: (reason: string) => void;
  getReprimeState?: () => AdvisorReprimeState;
}

/** The only controller allowed to call the child runtime. */
export class AdvisorReviewQueue {
  private readonly observations = new AdvisorObservationBuffer();
  private readonly waiters: Waiter[] = [];
  private epoch = 0;
  private pumping = false;
  private activeWaiter: Waiter | undefined;
  private activeSteeredThrough = 0;
  private steeringScheduled = false;
  private steeringPromise: Promise<void> = Promise.resolve();
  private disposed = false;
  private _processedThrough = 0;

  private readonly runtime: AdvisorRuntimeDriver;
  private readonly options: AdvisorReviewQueueOptions;

  constructor(runtime: AdvisorRuntimeDriver, options: AdvisorReviewQueueOptions = {}) {
    this.runtime = runtime;
    this.options = options;
  }

  get processedThrough(): number {
    return this._processedThrough;
  }

  get sequence(): number {
    return this.observations.sequence;
  }

  get backlog(): number {
    return this.observations.size;
  }

  get pendingCheckpoints(): number {
    return this.waiters.length + (this.activeWaiter ? 1 : 0);
  }

  get hasActiveCheckpoint(): boolean {
    return Boolean(this.activeWaiter);
  }

  get activeToolNames(): readonly string[] {
    return this.runtime.activeToolNames;
  }

  ingest(parentTurnId: number, input: AdvisorObservationInput): AdvisorObservation {
    if (this.disposed) throw new Error("Advisor review queue is disposed.");
    const record = this.observations.ingest(parentTurnId, input);
    if (this.activeWaiter && record.sequence > this.activeWaiter.target) {
      this.scheduleActiveSteering();
    }
    return record;
  }

  checkpoint(request: ReviewQueueCheckpointRequest): Promise<AdvisorCheckpoint> {
    if (this.disposed) return Promise.reject(new Error("Advisor review queue is disposed."));
    const target = this.observations.freezeThrough(
      request.targetSequence ?? this.observations.sequence,
    );
    return new Promise<AdvisorCheckpoint>((resolve, reject) => {
      if (this.waiters.length >= MAX_PENDING_CHECKPOINTS) {
        const dropped = this.waiters.shift();
        dropped?.reject(new Error("Advisor checkpoint backlog exceeded its bound."));
      }
      this.waiters.push({ request, target, epoch: this.epoch, resolve, reject });
      this.schedulePump();
    });
  }

  async reset(seed: string, stateSummary?: string): Promise<void> {
    const resetEpoch = ++this.epoch;
    const resetError = new Error("Advisor review queue was reset.");
    this.releaseWaiters(resetError);
    this.activeWaiter?.reject(resetError);
    this.activeWaiter = undefined;
    this.activeSteeredThrough = 0;
    this.steeringScheduled = false;
    this.observations.reset(resetEpoch);
    this._processedThrough = 0;
    await this.runtime.abort();
    if (resetEpoch !== this.epoch || this.disposed) return;
    await this.runtime.reprime(seed, stateSummary);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    ++this.epoch;
    const disposeError = new Error("Advisor review queue was disposed.");
    this.releaseWaiters(disposeError);
    this.activeWaiter?.reject(disposeError);
    this.activeWaiter = undefined;
    await this.runtime.dispose();
  }

  private schedulePump(): void {
    if (this.pumping) return;
    queueMicrotask(() => void this.pump());
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      while (!this.disposed && this.waiters.length > 0) {
        const waiter = this.waiters.shift();
        if (!waiter || waiter.epoch !== this.epoch) continue;
        this.activeWaiter = waiter;
        this.activeSteeredThrough = waiter.target;
        this.options.onCheckpointStart?.(waiter.request);
        const batch = this.observations.peekThrough(waiter.target);
        const observations = batch?.rendered ?? renderPreviouslyProcessed(waiter.target);
        const runtimeRequest: AdvisorCheckpointRequest = {
          checkpointId: waiter.request.checkpointId,
          processedThrough: waiter.target,
          observations,
          focus: waiter.request.focus,
          verificationReview: waiter.request.verificationReview,
        };
        try {
          const result = await this.checkpointWithBoundedRecovery(runtimeRequest, waiter.epoch);
          if (waiter.epoch !== this.epoch || this.disposed) {
            waiter.reject(new Error("Advisor checkpoint completed for a stale queue epoch."));
            continue;
          }
          if (
            result.checkpointId !== waiter.request.checkpointId ||
            result.processedThrough !== waiter.target
          ) {
            throw new Error("Advisor checkpoint correlation mismatch.");
          }
          this.observations.commitThrough(result.processedThrough);
          this._processedThrough = Math.max(this._processedThrough, result.processedThrough);
          waiter.resolve(result);
        } catch (error) {
          if (error instanceof AdvisorBatchDroppedError) {
            this.observations.commitThrough(waiter.target);
          }
          waiter.reject(error);
        } finally {
          if (this.activeWaiter === waiter) {
            this.activeWaiter = undefined;
            this.activeSteeredThrough = 0;
          }
          this.options.onCheckpointSettled?.(waiter.request);
        }
      }
    } finally {
      this.pumping = false;
      if (this.waiters.length > 0 && !this.disposed) this.schedulePump();
    }
  }

  private async checkpointWithBoundedRecovery(
    request: AdvisorCheckpointRequest,
    expectedEpoch: number,
  ): Promise<AdvisorCheckpoint> {
    let retried = false;
    while (true) {
      this.assertRecoveryCurrent(expectedEpoch);
      try {
        return await this.runtime.checkpoint(request);
      } catch (error) {
        this.assertRecoveryCurrent(expectedEpoch);
        if (!isReprimeRequired(error)) throw error;
        const state = this.options.getReprimeState?.();
        if (!state) throw error;
        this.options.onRuntimeReset?.(error instanceof Error ? error.message : String(error));
        this.assertRecoveryCurrent(expectedEpoch);
        await this.runtime.reprime(state.seed, state.stateSummary);
        this.assertRecoveryCurrent(expectedEpoch);
        if (retried) {
          throw new AdvisorBatchDroppedError(
            "Advisor batch failed again after one fresh-context retry and was dropped.",
          );
        }
        retried = true;
      }
    }
  }

  private assertRecoveryCurrent(expectedEpoch: number): void {
    if (this.disposed || expectedEpoch !== this.epoch) {
      throw new Error("Advisor checkpoint recovery became stale.");
    }
  }

  private scheduleActiveSteering(): void {
    if (this.steeringScheduled || this.disposed) return;
    this.steeringScheduled = true;
    queueMicrotask(() => {
      this.steeringScheduled = false;
      this.steeringPromise = this.steeringPromise
        .then(() => this.flushActiveSteering())
        .catch(() => undefined);
    });
  }

  private async flushActiveSteering(): Promise<void> {
    const waiter = this.activeWaiter;
    if (!waiter || waiter.epoch !== this.epoch || this.disposed) return;
    const through = this.observations.sequence;
    const batch = this.observations.peekRange(this.activeSteeredThrough, through);
    if (!batch) return;
    const accepted = await this.runtime.steer(batch.rendered);
    if (accepted && this.activeWaiter === waiter && waiter.epoch === this.epoch && !this.disposed) {
      this.activeSteeredThrough = Math.max(this.activeSteeredThrough, through);
    }
  }

  private releaseWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

function isReprimeRequired(error: unknown): boolean {
  if (error instanceof AdvisorRuntimeResetRequiredError) return true;
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
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
