import { emptyAdvisorOutcomes, type AdvisorSessionMetrics } from "../domain/metrics.ts";
import { emptyAdvisorFindingDedupe, type AdvisorFindingDedupeState } from "../review/dedupe.ts";
import {
  createAdvisorEmissionGuardState,
  type AdvisorEmissionGuardState,
} from "../review/emission-guard.ts";
import {
  emptyAdvisorFindingLifecycle,
  type AdvisorFindingLifecycleState,
} from "../review/finding-lifecycle.ts";
import {
  emptyAdvisorInterventionBudget,
  type AdvisorInterventionBudgetSnapshot,
} from "../review/intervention-budget.ts";
import {
  emptyAdvisorPerspectiveBudget,
  type AdvisorPerspectiveBudgetState,
} from "../review/perspective-budget.ts";
import { emptyAdvisorRoutingState, type AdvisorRoutingStateSnapshot } from "../review/routing.ts";
import { normalizeAdvisorConfig, type ResolvedAdvisorConfig } from "../config/options.ts";
import type { AdvisorFindingDedupeRollback } from "../review/dedupe.ts";
import type { AdvisorEmissionRollback } from "../review/emission-guard.ts";
import type { AdvisorReview } from "../review/index.ts";
import type {
  AdvisorToolTrajectoryDetectorState,
  AdvisorTrajectoryDetectorState,
} from "../review/trajectory.ts";

export interface AdvisorInterventionReceipt {
  readonly ids: readonly string[];
  readonly count: number;
  readonly cancellationEpoch: number;
  readonly requestSequence: number;
}
export interface AdvisorSpinnerMetadata {
  readonly owner?: string;
  readonly frame: number;
}

export interface AdvisorResourceSummary {
  readonly activeToolNames: readonly string[];
  readonly backlog: number;
  readonly backgroundState: "idle" | "queued" | "reviewing";
  readonly processedSequence: number;
  readonly queuedReviews: number;
  readonly sequence: number;
}

export interface AdvisorActiveTrajectoryState {
  readonly abortAllowed: boolean;
  readonly detector: AdvisorTrajectoryDetectorState;
  readonly toolDetector: AdvisorToolTrajectoryDetectorState;
  readonly generation: number;
  readonly id: number;
  readonly loopChannel?: "thinking" | "text";
  readonly loopConfirmed: boolean;
  readonly loopReason?: string;
  readonly reviewQueued: boolean;
  readonly text: string;
  readonly thinkingChars: number;
  readonly turnIndex: number;
}

export interface AdvisorPersistentRecoveryState {
  readonly review: AdvisorReview;
  readonly config: ResolvedAdvisorConfig;
  readonly phase: "final" | "progress";
  readonly epoch: number;
  readonly parentTurnId: number;
  readonly configRevision: number;
  readonly cancellationEpoch: number;
  readonly recovering: boolean;
  readonly findingIds: readonly string[];
  readonly budgetBefore: AdvisorInterventionBudgetSnapshot;
  readonly dedupeRollback: AdvisorFindingDedupeRollback;
  readonly emission: {
    readonly checkpointId: string;
    readonly hash: string;
    readonly rollback: AdvisorEmissionRollback;
  };
}

export interface AdvisorAbortState {
  readonly epoch: number;
  readonly parentTurnId: number;
  readonly turnIndex: number;
  readonly trajectoryId: number;
  readonly cancellationEpoch: number;
}

/**
 * Pure application-domain authority. Resource handles (Queue, Fiber, Scope,
 * Deferred, runtimes and host capabilities) are intentionally excluded.
 */
export interface AdvisorApplicationState {
  readonly config: ResolvedAdvisorConfig;
  readonly started: boolean;
  readonly metrics: AdvisorSessionMetrics;
  readonly resourceSummary: AdvisorResourceSummary;
  readonly guidancePaths: readonly string[];
  readonly hasLastCandidate: boolean;
  readonly activeTrajectory: AdvisorActiveTrajectoryState | undefined;
  readonly pendingPersistentRecovery: AdvisorPersistentRecoveryState | undefined;
  readonly abortInProgress: AdvisorAbortState | undefined;
  readonly epoch: number;
  readonly cancellationEpoch: number;
  readonly parentTurnId: number;
  readonly requestSequence: number;
  readonly findingDedupe: AdvisorFindingDedupeState;
  readonly findingLifecycle: AdvisorFindingLifecycleState;
  readonly perspectiveBudget: AdvisorPerspectiveBudgetState;
  readonly interventionBudget: AdvisorInterventionBudgetSnapshot;
  readonly emissionGuard: AdvisorEmissionGuardState;
  readonly routing: AdvisorRoutingStateSnapshot;
  readonly pendingReceipt: AdvisorInterventionReceipt | undefined;
  readonly spinner: AdvisorSpinnerMetadata;
  readonly reportedFailures: readonly string[];
  readonly reportedDiagnostics: readonly string[];
}

export const emptyAdvisorSessionMetrics = (): AdvisorSessionMetrics => ({
  attempted: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  discarded: 0,
  failure: 0,
  inputTokens: 0,
  modelResponses: 0,
  outputTokens: 0,
  outcomes: emptyAdvisorOutcomes(),
  pass: 0,
  revise: 0,
  skippedReviews: {},
  suppressedFindings: 0,
  settledReviews: 0,
  totalDurationMs: 0,
  totalTokens: 0,
  usageByModel: {},
});

/**
 * Synchronous atomic domain boundary required by Pi's immediate callbacks. Transitions replace one
 * immutable state snapshot before any renderer projection is published; resources are never stored.
 */
export const makeAdvisorApplicationStateStore = (initial: AdvisorApplicationState) => {
  let current = initial;
  return {
    get: () => current,
    transition: (update: (state: AdvisorApplicationState) => AdvisorApplicationState) => {
      current = update(current);
      return current;
    },
  };
};

export const initialAdvisorApplicationState = (
  config: ResolvedAdvisorConfig = normalizeAdvisorConfig({}, ""),
): AdvisorApplicationState => ({
  config,
  started: false,
  metrics: emptyAdvisorSessionMetrics(),
  resourceSummary: {
    activeToolNames: [],
    backlog: 0,
    backgroundState: "idle",
    processedSequence: 0,
    queuedReviews: 0,
    sequence: 0,
  },
  guidancePaths: [],
  hasLastCandidate: false,
  activeTrajectory: undefined,
  pendingPersistentRecovery: undefined,
  abortInProgress: undefined,
  epoch: 0,
  cancellationEpoch: 0,
  parentTurnId: 0,
  requestSequence: 0,
  findingDedupe: emptyAdvisorFindingDedupe(),
  findingLifecycle: emptyAdvisorFindingLifecycle(),
  perspectiveBudget: emptyAdvisorPerspectiveBudget(),
  interventionBudget: emptyAdvisorInterventionBudget(),
  emissionGuard: createAdvisorEmissionGuardState(),
  routing: emptyAdvisorRoutingState(),
  pendingReceipt: undefined,
  spinner: { frame: 0 },
  reportedFailures: [],
  reportedDiagnostics: [],
});

export const resetAdvisorRequestDomain = (
  state: AdvisorApplicationState,
): AdvisorApplicationState => ({
  ...state,
  cancellationEpoch: state.cancellationEpoch + 1,
  requestSequence: state.requestSequence + 1,
  findingDedupe: emptyAdvisorFindingDedupe(state.findingDedupe.capacity),
  perspectiveBudget: emptyAdvisorPerspectiveBudget(),
  interventionBudget: emptyAdvisorInterventionBudget(),
  emissionGuard: createAdvisorEmissionGuardState([], state.emissionGuard.capacity),
  pendingReceipt: undefined,
});

export const recordAdvisorReceipt = (
  state: AdvisorApplicationState,
  ids: readonly string[],
): AdvisorApplicationState => {
  const prior = state.pendingReceipt;
  return {
    ...state,
    pendingReceipt: {
      ids:
        prior?.requestSequence === state.requestSequence
          ? [...new Set([...prior.ids, ...ids])].slice(0, 5)
          : [...ids],
      count: prior?.requestSequence === state.requestSequence ? prior.count + 1 : 1,
      cancellationEpoch: state.cancellationEpoch,
      requestSequence: state.requestSequence,
    },
  };
};

export const setAdvisorSpinnerOwner = (
  state: AdvisorApplicationState,
  owner?: string,
): AdvisorApplicationState => ({
  ...state,
  spinner: owner === undefined ? { frame: 0 } : { owner, frame: 0 },
});
