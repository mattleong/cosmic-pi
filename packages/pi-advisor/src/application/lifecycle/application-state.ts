import * as Effect from "effect/Effect";
import type { ResolvedAdvisorConfig } from "../../config/options.ts";
import {
  advisorFindingLifecycleCounts,
  emptyAdvisorFindingLifecycle,
} from "../../review/finding-lifecycle.ts";
import { latchAdvisorCancellation } from "../../review/routing.ts";
import type { AdvisorControllerSnapshot } from "../../ui/projection.ts";
import {
  makeAdvisorApplicationStateStore,
  recordAdvisorReceipt,
  resetAdvisorRequestDomain,
  type AdvisorActiveTrajectoryState,
  type AdvisorApplicationState,
} from "../state.ts";
import { cloneSessionMetrics } from "./metrics.ts";
import type { createSessionRefs } from "./session-refs.ts";

export const makeLifecycleApplicationState = (options: {
  readonly store: ReturnType<typeof makeAdvisorApplicationStateStore>;
  readonly refs: ReturnType<typeof createSessionRefs>;
  readonly publish: (next: AdvisorControllerSnapshot) => Effect.Effect<void>;
  readonly publishNow: (next: AdvisorControllerSnapshot) => void;
}) => {
  const { store, refs, publish, publishNow } = options;
  const controllerSnapshot = (state: AdvisorApplicationState): AdvisorControllerSnapshot => ({
    config: state.config,
    metrics: {
      ...state.metrics,
      ...state.resourceSummary,
      childResets: state.metrics.childResets ?? 0,
      guidancePaths: state.guidancePaths,
      hasLastCandidate: state.hasLastCandidate,
      findingLifecycle: advisorFindingLifecycleCounts(state.findingLifecycle),
      interventionBudget: state.interventionBudget,
      paused: state.paused,
      reviewNext: state.reviewNext,
    },
    paused: state.paused,
    started: state.started,
  });
  const refreshResourceSummary = (): AdvisorApplicationState =>
    store.transition((state) => ({
      ...state,
      resourceSummary: {
        activeToolNames: refs.queue?.activeToolNames ?? [],
        backlog: refs.queue?.backlog ?? 0,
        backgroundState: refs.queue?.hasActiveCheckpoint
          ? "reviewing"
          : refs.queue && refs.queue.pendingCheckpoints > 0
            ? "queued"
            : "idle",
        processedSequence: refs.queue?.processedThrough ?? 0,
        queuedReviews: refs.queue?.pendingCheckpoints ?? 0,
        sequence: refs.queue?.sequence ?? 0,
      },
    }));
  const publishControllerSnapshotNow = (): void => {
    const state = refreshResourceSummary();
    publishNow(controllerSnapshot(state));
  };
  const publishControllerSnapshot = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      const state = refreshResourceSummary();
      return publish(controllerSnapshot(state));
    });
  const updateApplicationState = (
    update: (state: AdvisorApplicationState) => AdvisorApplicationState,
  ): void => {
    store.transition(update);
    publishControllerSnapshotNow();
  };
  const mutateMetrics = (mutate: (next: ReturnType<typeof cloneSessionMetrics>) => void): void => {
    updateApplicationState((state) => {
      const next = cloneSessionMetrics(state.metrics);
      mutate(next);
      return { ...state, metrics: next };
    });
  };
  const currentConfig = (): ResolvedAdvisorConfig => store.get().config;
  const isPaused = (): boolean => store.get().paused;
  const isStarted = (): boolean => store.get().started;
  const mutateTrajectory = (
    id: number,
    mutate: (next: AdvisorActiveTrajectoryState) => AdvisorActiveTrajectoryState,
  ): AdvisorActiveTrajectoryState | undefined => {
    let result: AdvisorActiveTrajectoryState | undefined;
    updateApplicationState((state) => {
      if (!state.activeTrajectory || state.activeTrajectory.id !== id) return state;
      result = mutate({ ...state.activeTrajectory });
      return { ...state, activeTrajectory: result };
    });
    return result;
  };
  const setDomainCounter = (
    key: "epoch" | "cancellationEpoch" | "parentTurnId" | "requestSequence",
    value: number,
  ): number => {
    updateApplicationState((state) => ({ ...state, [key]: value }));
    return value;
  };
  const advanceDomainCounter = (
    key: "epoch" | "cancellationEpoch" | "parentTurnId" | "requestSequence",
  ): number => setDomainCounter(key, store.get()[key] + 1);
  const recordReceipt = (ids: readonly string[]): void => {
    updateApplicationState((state) => recordAdvisorReceipt(state, ids));
  };
  const clearPendingReceipt = (): void => {
    updateApplicationState((state) => ({ ...state, pendingReceipt: undefined }));
  };
  const latchCancellation = (): void => {
    updateApplicationState((state) => ({
      ...state,
      routing: latchAdvisorCancellation(state.routing),
    }));
  };
  const resetRequestDomain = (resetLifecycle = false): void => {
    updateApplicationState((state) => {
      const reset = resetAdvisorRequestDomain(state);
      return {
        ...reset,
        cancellationEpoch: state.cancellationEpoch,
        requestSequence: state.requestSequence,
        findingLifecycle: resetLifecycle ? emptyAdvisorFindingLifecycle() : state.findingLifecycle,
      };
    });
    refs.perspectiveCheckpointUsed = false;
  };

  return {
    publishControllerSnapshotNow,
    publishControllerSnapshot,
    updateApplicationState,
    mutateMetrics,
    currentConfig,
    isPaused,
    isStarted,
    mutateTrajectory,
    setDomainCounter,
    advanceDomainCounter,
    recordReceipt,
    clearPendingReceipt,
    latchCancellation,
    resetRequestDomain,
  } as const;
};
