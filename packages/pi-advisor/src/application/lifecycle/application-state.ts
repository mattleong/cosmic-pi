import type { ResolvedAdvisorConfig } from "../../config/options.ts";
import { emptyAdvisorFindingLifecycle } from "../../review/finding-lifecycle.ts";
import type { AdvisorCommandSnapshot } from "../../settings/types.ts";
import {
  beginAdvisorUserRequest,
  cancelAdvisorRequest,
  clearAdvisorPendingRecovery,
  commitAdvisorConfig,
  initializeAdvisorSession,
  makeAdvisorApplicationStateStore,
  recordAdvisorReceipt,
  resetAdvisorRequestDomain,
  type AdvisorActiveTrajectoryState,
  type AdvisorApplicationState,
} from "../state.ts";
import type { createSessionRefs } from "./session-refs.ts";

export const makeLifecycleApplicationState = (options: {
  readonly store: ReturnType<typeof makeAdvisorApplicationStateStore>;
  readonly refs: ReturnType<typeof createSessionRefs>;
  readonly activeCheckpointCount: () => number;
}) => {
  const { store, refs } = options;
  const captureCommandSnapshot = (): AdvisorCommandSnapshot => {
    const state = store.get();
    const queue = refs.queue;
    const active = (queue?.hasActiveCheckpoint ?? false) || options.activeCheckpointCount() > 0;
    const pending = queue?.pendingCheckpoints ?? 0;
    return {
      config: state.config,
      metrics: state.metrics,
      activity: active ? "reviewing" : pending > 0 ? "queued" : "idle",
      hasLastCandidate: refs.lastCandidate !== undefined,
    };
  };
  const updateApplicationState = (
    update: (state: AdvisorApplicationState) => AdvisorApplicationState,
  ): void => {
    store.transition(update);
  };
  const updateMetrics = (
    update: (metrics: AdvisorApplicationState["metrics"]) => AdvisorApplicationState["metrics"],
  ): void => {
    updateApplicationState((state) => ({ ...state, metrics: update(state.metrics) }));
  };
  const currentConfig = (): ResolvedAdvisorConfig => store.get().config;
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
  const advanceDomainCounter = (key: "epoch" | "parentTurnId"): number => {
    let value = 0;
    updateApplicationState((state) => {
      value = state[key] + 1;
      return { ...state, [key]: value };
    });
    return value;
  };
  const recordReceipt = (ids: readonly string[]): void => {
    updateApplicationState((state) => recordAdvisorReceipt(state, ids));
  };
  const clearPendingReceipt = (): void => {
    updateApplicationState((state) => ({ ...state, pendingReceipt: undefined }));
  };
  const clearPendingRecovery = (): void => {
    updateApplicationState(clearAdvisorPendingRecovery);
  };
  const initializeSession = (config: ResolvedAdvisorConfig): void => {
    updateApplicationState((state) => initializeAdvisorSession(state, config));
  };
  const beginUserRequest = (): void => {
    updateApplicationState(beginAdvisorUserRequest);
  };
  const cancelRequest = (): void => {
    updateApplicationState(cancelAdvisorRequest);
  };
  const commitConfig = (config: ResolvedAdvisorConfig): void => {
    updateApplicationState((state) => commitAdvisorConfig(state, config));
  };
  const resetSessionTreeDomain = (): void => {
    updateApplicationState((state) => ({
      ...resetAdvisorRequestDomain(state),
      findingLifecycle: emptyAdvisorFindingLifecycle(),
      pendingReceipt: undefined,
    }));
  };

  return {
    captureCommandSnapshot,
    updateApplicationState,
    updateMetrics,
    currentConfig,
    mutateTrajectory,
    advanceDomainCounter,
    recordReceipt,
    clearPendingReceipt,
    clearPendingRecovery,
    initializeSession,
    beginUserRequest,
    cancelRequest,
    commitConfig,
    resetSessionTreeDomain,
  } as const;
};
