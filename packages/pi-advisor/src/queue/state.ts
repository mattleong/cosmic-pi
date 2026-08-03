export interface ActiveReviewCheckpoint {
  readonly checkpointId: string;
  readonly target: number;
  readonly epoch: number;
  readonly steeredThrough: number;
  readonly steeringAttemptedThrough: number;
}

export interface ReviewQueueState {
  readonly epoch: number;
  readonly disposed: boolean;
  readonly pendingCount: number;
  readonly processedThrough: number;
  readonly active: ActiveReviewCheckpoint | undefined;
}

export const initialReviewQueueState = (): ReviewQueueState => ({
  epoch: 0,
  disposed: false,
  pendingCount: 0,
  processedThrough: 0,
  active: undefined,
});

export const enqueueCheckpoint = (state: ReviewQueueState): ReviewQueueState => ({
  ...state,
  pendingCount: state.pendingCount + 1,
});

export const dropQueuedCheckpoint = (state: ReviewQueueState): ReviewQueueState => ({
  ...state,
  pendingCount: Math.max(0, state.pendingCount - 1),
});

export const beginCheckpoint = (
  state: ReviewQueueState,
  checkpointId: string,
  target: number,
  epoch: number,
): ReviewQueueState => ({
  ...state,
  pendingCount: Math.max(0, state.pendingCount - 1),
  active: {
    checkpointId,
    target,
    epoch,
    steeredThrough: target,
    steeringAttemptedThrough: target,
  },
});

export const attemptSteering = (
  state: ReviewQueueState,
  checkpointId: string,
  through: number,
): ReviewQueueState =>
  state.active?.checkpointId === checkpointId
    ? {
        ...state,
        active: {
          ...state.active,
          steeringAttemptedThrough: Math.max(state.active.steeringAttemptedThrough, through),
        },
      }
    : state;

export const acceptSteering = (
  state: ReviewQueueState,
  checkpointId: string,
  through: number,
): ReviewQueueState =>
  state.active?.checkpointId === checkpointId
    ? {
        ...state,
        active: {
          ...state.active,
          steeredThrough: Math.max(state.active.steeredThrough, through),
        },
      }
    : state;

export const settleCheckpoint = (
  state: ReviewQueueState,
  checkpointId: string,
  processedThrough?: number,
): ReviewQueueState =>
  state.active?.checkpointId === checkpointId
    ? {
        ...state,
        processedThrough:
          processedThrough === undefined
            ? state.processedThrough
            : Math.max(state.processedThrough, processedThrough),
        active: undefined,
      }
    : state;

export const cancelQueuedCheckpoint = (state: ReviewQueueState): ReviewQueueState =>
  dropQueuedCheckpoint(state);

export const disposeReviewQueue = (state: ReviewQueueState): ReviewQueueState => ({
  epoch: state.epoch + 1,
  disposed: true,
  pendingCount: 0,
  processedThrough: 0,
  active: undefined,
});
