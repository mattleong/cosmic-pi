import { normalizeAdvisorConfig, type ResolvedAdvisorConfig } from "../config/options.ts";
import { emptyAdvisorSessionMetrics, type AdvisorSessionMetrics } from "../domain/metrics.ts";
import {
  emptyAdvisorFindingDedupe,
  rollbackAdvisorFindingDedupe,
  type AdvisorFindingDedupeRollback,
  type AdvisorFindingDedupeState,
} from "../review/dedupe.ts";
import {
  createAdvisorEmissionGuardState,
  rollbackAdvisorEmission,
  type AdvisorEmissionGuardState,
  type AdvisorEmissionRollback,
} from "../review/emission-guard.ts";
import {
  acknowledgeAdvisorFindings,
  emptyAdvisorFindingLifecycle,
  type AdvisorFindingLifecycleState,
} from "../review/finding-lifecycle.ts";
import {
  emptyAdvisorInterventionBudget,
  sanitizeInterventionBudgetSnapshot,
  type AdvisorInterventionBudgetSnapshot,
} from "../review/intervention-budget.ts";
import {
  armAdvisorInterruption,
  clearAdvisorCancellation,
  emptyAdvisorRoutingState,
  latchAdvisorCancellation,
  type AdvisorRoutingStateSnapshot,
} from "../review/routing.ts";
import type { AdvisorReview } from "../review/schema.ts";
import type {
  AdvisorToolTrajectoryDetectorState,
  AdvisorTrajectoryDetectorState,
} from "../review/trajectory.ts";

export interface AdvisorInterventionReceipt {
  readonly ids: readonly string[];
  readonly cancellationEpoch: number;
  readonly requestSequence: number;
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
  readonly epoch: number;
  readonly parentTurnId: number;
  readonly turnIndex: number;
  readonly trajectoryId: number;
  readonly cancellationEpoch: number;
  readonly findingIds: readonly string[];
  readonly budgetBefore: AdvisorInterventionBudgetSnapshot;
  readonly dedupeRollback: AdvisorFindingDedupeRollback;
  readonly emissionRollback: AdvisorEmissionRollback;
}

export type AdvisorRecoveryOutcome = "guidance" | "card-only" | "none";

/**
 * Pure application-domain authority. Resource handles (Queue, Fiber, Scope,
 * Deferred, runtimes and host capabilities) are intentionally excluded.
 */
export interface AdvisorApplicationState {
  readonly config: ResolvedAdvisorConfig;
  readonly metrics: AdvisorSessionMetrics;
  readonly activeTrajectory: AdvisorActiveTrajectoryState | undefined;
  readonly pendingPersistentRecovery: AdvisorPersistentRecoveryState | undefined;
  readonly epoch: number;
  readonly cancellationEpoch: number;
  readonly parentTurnId: number;
  readonly requestSequence: number;
  readonly findingDedupe: AdvisorFindingDedupeState;
  readonly findingLifecycle: AdvisorFindingLifecycleState;
  readonly interventionBudget: AdvisorInterventionBudgetSnapshot;
  readonly emissionGuard: AdvisorEmissionGuardState;
  readonly routing: AdvisorRoutingStateSnapshot;
  readonly pendingReceipt: AdvisorInterventionReceipt | undefined;
  readonly reportedFailures: readonly string[];
  readonly reportedDiagnostics: readonly string[];
}

/**
 * Synchronous atomic domain boundary required by Pi's immediate callbacks. Transitions replace one
 * immutable state snapshot; resources are never stored.
 */
export const makeAdvisorApplicationStateStore = (initial: AdvisorApplicationState) => {
  let current = initial;
  return {
    get: () => current,
    transition: (update: (state: AdvisorApplicationState) => AdvisorApplicationState): void => {
      current = update(current);
    },
  };
};

export const initialAdvisorApplicationState = (
  config: ResolvedAdvisorConfig = normalizeAdvisorConfig({}, ""),
): AdvisorApplicationState => ({
  config,
  metrics: emptyAdvisorSessionMetrics(),
  activeTrajectory: undefined,
  pendingPersistentRecovery: undefined,
  epoch: 0,
  cancellationEpoch: 0,
  parentTurnId: 0,
  requestSequence: 0,
  findingDedupe: emptyAdvisorFindingDedupe(),
  findingLifecycle: emptyAdvisorFindingLifecycle(),
  interventionBudget: emptyAdvisorInterventionBudget(),
  emissionGuard: createAdvisorEmissionGuardState(),
  routing: emptyAdvisorRoutingState(),
  pendingReceipt: undefined,
  reportedFailures: [],
  reportedDiagnostics: [],
});

export function settleAdvisorPendingRecovery(
  state: AdvisorApplicationState,
  expected: AdvisorPersistentRecoveryState,
  outcome: AdvisorRecoveryOutcome,
): AdvisorApplicationState {
  if (state.pendingPersistentRecovery !== expected) return state;
  const settled = { ...state, pendingPersistentRecovery: undefined };
  if (outcome === "guidance")
    return recordAdvisorReceipt(
      {
        ...settled,
        findingLifecycle: acknowledgeAdvisorFindings(state.findingLifecycle, expected.findingIds),
        routing: armAdvisorInterruption(state.routing),
      },
      expected.findingIds,
    );
  if (outcome === "card-only") return settled;
  return {
    ...settled,
    emissionGuard: rollbackAdvisorEmission(state.emissionGuard, expected.emissionRollback),
    findingDedupe: rollbackAdvisorFindingDedupe(state.findingDedupe, expected.dedupeRollback),
    interventionBudget: sanitizeInterventionBudgetSnapshot({
      ...expected.budgetBefore,
      correctionUsed: true,
    }),
  };
}

export const clearAdvisorPendingRecovery = (
  state: AdvisorApplicationState,
): AdvisorApplicationState => {
  const pending = state.pendingPersistentRecovery;
  return pending ? settleAdvisorPendingRecovery(state, pending, "none") : state;
};

/** Resets only policy that is scoped to one genuine user request. */
export const resetAdvisorRequestDomain = (
  state: AdvisorApplicationState,
): AdvisorApplicationState => ({
  ...state,
  findingDedupe: emptyAdvisorFindingDedupe(state.findingDedupe.capacity),
  interventionBudget: emptyAdvisorInterventionBudget(),
  emissionGuard: createAdvisorEmissionGuardState([], state.emissionGuard.capacity),
});

export const initializeAdvisorSession = (
  state: AdvisorApplicationState,
  config: ResolvedAdvisorConfig,
): AdvisorApplicationState => ({
  ...initialAdvisorApplicationState(config),
  epoch: state.epoch,
  cancellationEpoch: state.cancellationEpoch,
});

export const beginAdvisorUserRequest = (
  state: AdvisorApplicationState,
): AdvisorApplicationState => {
  const next = resetAdvisorRequestDomain(clearAdvisorPendingRecovery(state));
  return {
    ...next,
    activeTrajectory: undefined,
    pendingReceipt: undefined,
    cancellationEpoch: state.cancellationEpoch + 1,
    requestSequence: state.requestSequence + 1,
    findingLifecycle: state.findingLifecycle,
    routing: clearAdvisorCancellation(state.routing),
  };
};

export const cancelAdvisorRequest = (state: AdvisorApplicationState): AdvisorApplicationState => {
  const next = clearAdvisorPendingRecovery(state);
  return {
    ...next,
    cancellationEpoch: state.cancellationEpoch + 1,
    pendingReceipt: undefined,
    routing: latchAdvisorCancellation(state.routing),
  };
};

export const commitAdvisorConfig = (
  state: AdvisorApplicationState,
  nextConfig: ResolvedAdvisorConfig,
): AdvisorApplicationState => {
  const disabling = state.config.enabled && !nextConfig.enabled;
  const next = resetAdvisorRequestDomain(clearAdvisorPendingRecovery(state));
  return {
    ...next,
    config: nextConfig,
    cancellationEpoch: state.cancellationEpoch + 1,
    findingLifecycle: emptyAdvisorFindingLifecycle(),
    routing: disabling ? latchAdvisorCancellation(state.routing) : state.routing,
  };
};

export function recordAdvisorReceipt(
  state: AdvisorApplicationState,
  ids: readonly string[],
): AdvisorApplicationState {
  const prior = state.pendingReceipt;
  return {
    ...state,
    pendingReceipt: {
      ids:
        prior?.requestSequence === state.requestSequence
          ? [...new Set([...prior.ids, ...ids])].slice(0, 5)
          : [...ids],
      cancellationEpoch: state.cancellationEpoch,
      requestSequence: state.requestSequence,
    },
  };
}
