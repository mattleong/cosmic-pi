import type * as Deferred from "effect/Deferred";
import type { AdvisorReview, AdvisorReviewFocus } from "../review/schema.ts";
import type { AdvisorCheckpoint } from "../runtime/runtime.ts";
import type { AdvisorReviewQueueError } from "./errors.ts";

export interface ReviewQueueCheckpointRequest {
  readonly checkpointId: string;
  readonly focus: AdvisorReviewFocus;
  readonly verificationReview?: AdvisorReview | undefined;
}

export type ReviewQueueEntryToken = symbol;

export interface ReviewQueueEntry {
  readonly token: ReviewQueueEntryToken;
  readonly request: ReviewQueueCheckpointRequest;
  readonly target: number;
  readonly done: Deferred.Deferred<AdvisorCheckpoint, AdvisorReviewQueueError>;
}

export interface RunningReviewCheckpoint extends ReviewQueueEntry {
  readonly phase: "running";
  readonly steeredThrough: number;
  readonly steeringClaimedThrough: number;
}

export interface CancellingReviewCheckpoint extends ReviewQueueEntry {
  readonly phase: "cancelling";
  readonly steeredThrough: number;
  readonly steeringClaimedThrough: number;
}

export type ActiveReviewCheckpoint = RunningReviewCheckpoint | CancellingReviewCheckpoint;

export interface ReviewQueueState {
  readonly disposed: boolean;
  readonly processedThrough: number;
  readonly active: ActiveReviewCheckpoint | undefined;
  readonly queued: readonly ReviewQueueEntry[];
  readonly wake: Deferred.Deferred<void>;
}

export const initialReviewQueueState = (wake: Deferred.Deferred<void>): ReviewQueueState => ({
  disposed: false,
  processedThrough: 0,
  active: undefined,
  queued: [],
  wake,
});

export type AdmissionDecision =
  | { readonly _tag: "Disposed"; readonly entry: ReviewQueueEntry }
  | {
      readonly _tag: "Admitted";
      readonly entry: ReviewQueueEntry;
      readonly evicted: ReviewQueueEntry | undefined;
      readonly wake: Deferred.Deferred<void> | undefined;
    };

export const admitCheckpoint = (
  state: ReviewQueueState,
  entry: ReviewQueueEntry,
  nextWake: Deferred.Deferred<void>,
  queuedCapacity: number,
): readonly [AdmissionDecision, ReviewQueueState] => {
  if (state.disposed) return [{ _tag: "Disposed", entry }, state];
  const evicted = state.queued.length >= queuedCapacity ? state.queued[0] : undefined;
  const survivors = evicted ? state.queued.slice(1) : state.queued;
  const shouldWake = state.active === undefined && survivors.length === 0;
  return [
    {
      _tag: "Admitted",
      entry,
      evicted,
      wake: shouldWake ? state.wake : undefined,
    },
    {
      ...state,
      queued: [...survivors, entry],
      wake: shouldWake ? nextWake : state.wake,
    },
  ];
};

export type WorkerDecision =
  | { readonly _tag: "Stop" }
  | { readonly _tag: "Wait"; readonly wake: Deferred.Deferred<void> }
  | { readonly _tag: "Run"; readonly entry: RunningReviewCheckpoint };

export const claimNextCheckpoint = (
  state: ReviewQueueState,
): readonly [WorkerDecision, ReviewQueueState] => {
  if (state.disposed) return [{ _tag: "Stop" }, state];
  if (state.active !== undefined || state.queued.length === 0)
    return [{ _tag: "Wait", wake: state.wake }, state];
  const queued = state.queued[0]!;
  const active: RunningReviewCheckpoint = {
    ...queued,
    phase: "running",
    steeredThrough: queued.target,
    steeringClaimedThrough: queued.target,
  };
  return [
    { _tag: "Run", entry: active },
    { ...state, active, queued: state.queued.slice(1) },
  ];
};

export interface SettlementDecision {
  readonly settled: boolean;
  readonly entry: RunningReviewCheckpoint | undefined;
  readonly wake: Deferred.Deferred<void> | undefined;
}

export const settleRunningCheckpoint = (
  state: ReviewQueueState,
  token: ReviewQueueEntryToken,
  nextWake: Deferred.Deferred<void>,
  processedThrough?: number,
): readonly [SettlementDecision, ReviewQueueState] => {
  const active = state.active;
  if (state.disposed || active?.phase !== "running" || active.token !== token)
    return [{ settled: false, entry: undefined, wake: undefined }, state];
  return [
    { settled: true, entry: active, wake: state.wake },
    {
      ...state,
      processedThrough:
        processedThrough === undefined
          ? state.processedThrough
          : Math.max(state.processedThrough, processedThrough),
      active: undefined,
      wake: nextWake,
    },
  ];
};

export type CancellationDecision =
  | { readonly _tag: "None" }
  | { readonly _tag: "Queued"; readonly entry: ReviewQueueEntry }
  | { readonly _tag: "ActiveOwner"; readonly entry: CancellingReviewCheckpoint }
  | { readonly _tag: "ActiveWait"; readonly entry: CancellingReviewCheckpoint }
  | { readonly _tag: "DisposalWait"; readonly entry: ReviewQueueEntry };

const cancelEntry = (
  state: ReviewQueueState,
  entry: ReviewQueueEntry | ActiveReviewCheckpoint | undefined,
): readonly [CancellationDecision, ReviewQueueState] => {
  if (!entry) return [{ _tag: "None" }, state];
  if (state.disposed) return [{ _tag: "DisposalWait", entry }, state];
  if (state.active?.token === entry.token) {
    if (state.active.phase === "cancelling")
      return [{ _tag: "ActiveWait", entry: state.active }, state];
    const active: CancellingReviewCheckpoint = { ...state.active, phase: "cancelling" };
    return [
      { _tag: "ActiveOwner", entry: active },
      { ...state, active },
    ];
  }
  const index = state.queued.findIndex((candidate) => candidate.token === entry.token);
  if (index < 0) return [{ _tag: "None" }, state];
  const queued = state.queued[index]!;
  return [
    { _tag: "Queued", entry: queued },
    { ...state, queued: [...state.queued.slice(0, index), ...state.queued.slice(index + 1)] },
  ];
};

export const cancelCheckpointById = (
  state: ReviewQueueState,
  checkpointId: string,
): readonly [CancellationDecision, ReviewQueueState] => {
  if (state.active?.request.checkpointId === checkpointId) return cancelEntry(state, state.active);
  return cancelEntry(
    state,
    state.queued.find((candidate) => candidate.request.checkpointId === checkpointId),
  );
};

export const cancelCheckpointByToken = (
  state: ReviewQueueState,
  token: ReviewQueueEntryToken,
): readonly [CancellationDecision, ReviewQueueState] => {
  if (state.active?.token === token) return cancelEntry(state, state.active);
  return cancelEntry(
    state,
    state.queued.find((candidate) => candidate.token === token),
  );
};

export const finishActiveCancellation = (
  state: ReviewQueueState,
  token: ReviewQueueEntryToken,
): readonly [boolean, ReviewQueueState] => {
  if (state.disposed || state.active?.phase !== "cancelling" || state.active.token !== token)
    return [false, state];
  return [true, { ...state, active: undefined }];
};

export type DisposalDecision =
  | { readonly _tag: "AlreadyDisposed" }
  | {
      readonly _tag: "Dispose";
      readonly active: ActiveReviewCheckpoint | undefined;
      readonly queued: readonly ReviewQueueEntry[];
    };

export const disposeReviewQueue = (
  state: ReviewQueueState,
): readonly [DisposalDecision, ReviewQueueState] => {
  if (state.disposed) return [{ _tag: "AlreadyDisposed" }, state];
  return [
    { _tag: "Dispose", active: state.active, queued: state.queued },
    { ...state, disposed: true },
  ];
};

export interface SteeringClaim {
  readonly token: ReviewQueueEntryToken;
  readonly after: number;
  readonly through: number;
}

export const claimSteering = (
  state: ReviewQueueState,
  through: number,
): readonly [SteeringClaim | undefined, ReviewQueueState] => {
  const active = state.active;
  if (state.disposed || active?.phase !== "running" || through <= active.steeringClaimedThrough)
    return [undefined, state];
  return [
    { token: active.token, after: active.steeredThrough, through },
    {
      ...state,
      active: { ...active, steeringClaimedThrough: through },
    },
  ];
};

export const acceptSteering = (
  state: ReviewQueueState,
  claim: SteeringClaim,
): readonly [boolean, ReviewQueueState] => {
  const active = state.active;
  if (
    state.disposed ||
    active?.phase !== "running" ||
    active.token !== claim.token ||
    active.steeringClaimedThrough < claim.through
  )
    return [false, state];
  return [
    true,
    {
      ...state,
      active: { ...active, steeredThrough: Math.max(active.steeredThrough, claim.through) },
    },
  ];
};

export const isRunningCheckpoint = (
  state: ReviewQueueState,
  token: ReviewQueueEntryToken,
): readonly [boolean, ReviewQueueState] => [
  !state.disposed && state.active?.phase === "running" && state.active.token === token,
  state,
];
