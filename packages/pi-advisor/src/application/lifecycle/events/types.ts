import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { CheckpointOrchestratorContract } from "../../../checkpoint/orchestrator.ts";
import type { ResolvedAdvisorConfig } from "../../../config/options.ts";
import type { ConfigStoreContract } from "../../../config/store.ts";
import type { AdvisorReviewQueue } from "../../../queue/review-queue.ts";
import type { AdvisorReviewFocus } from "../../../review/schema.ts";
import type {
  AdvisorCheckpointHandle,
  ParentAnchor,
  ReviewPhase,
  ReviewSource,
} from "../../controller.ts";
import type { AdvisorActiveTrajectoryState, AdvisorApplicationState } from "../../state.ts";
import type { SessionRefs } from "../session-refs.ts";

export interface EventsDeps {
  readonly refs: SessionRefs;
  readonly pi: ExtensionAPI;
  readonly applicationScope: Scope.Scope;
  readonly getState: () => AdvisorApplicationState;
  readonly updateApplicationState: (
    update: (state: AdvisorApplicationState) => AdvisorApplicationState,
  ) => void;
  readonly updateMetrics: (
    update: (metrics: AdvisorApplicationState["metrics"]) => AdvisorApplicationState["metrics"],
  ) => void;
  readonly currentConfig: () => ResolvedAdvisorConfig;
  readonly advanceDomainCounter: (key: "epoch" | "parentTurnId") => number;
  readonly clearPersistentTrajectory: () => void;
  readonly clearPersistentTrajectoryResources: () => void;
  readonly clearPendingRecovery: () => void;
  readonly clearPendingReceipt: () => void;
  readonly initializeSession: (config: ResolvedAdvisorConfig) => void;
  readonly beginUserRequest: () => void;
  readonly cancelRequest: () => void;
  readonly resetSessionTreeDomain: () => void;
  readonly persistCurrentLedger: (ctx: ExtensionContext) => void;
  readonly persistLedger: (anchor: ParentAnchor) => void;
  readonly ingest: (input: Parameters<AdvisorReviewQueue["ingest"]>[1]) => void;
  readonly recordReceipt: (ids: readonly string[]) => void;
  readonly mutateTrajectory: (
    id: number,
    mutate: (next: AdvisorActiveTrajectoryState) => AdvisorActiveTrajectoryState,
  ) => AdvisorActiveTrajectoryState | undefined;
  readonly scheduleDelay: (milliseconds: number, task: () => void) => () => void;
  readonly notifyBestEffort: (
    ctx: Pick<ExtensionContext, "ui">,
    message: string,
    level: "info" | "warning" | "error",
  ) => void;
  readonly startRuntimeEffect: (
    ctx: ExtensionContext,
    restoration?: "preserve-live" | "restore-branch",
    allowDisabled?: boolean,
  ) => Effect.Effect<number | undefined>;
  readonly stopRuntimeEffect: () => Effect.Effect<void>;
  readonly stopRuntimeUnlockedEffect: () => Effect.Effect<void>;
  readonly runWithExplicitRuntimeEffect: <T>(
    ctx: ExtensionContext,
    action: () => T,
  ) => Effect.Effect<T | undefined>;
  readonly requestCheckpoint: (options: {
    ctx: ExtensionContext;
    focus: AdvisorReviewFocus;
    phase: ReviewPhase;
    source: ReviewSource;
    requiresEnabled: boolean;
    trajectoryId?: number;
    abortOnBlocker?: boolean;
  }) => AdvisorCheckpointHandle | undefined;
  readonly awaitCatchUpEffectOwned: (
    handle: AdvisorCheckpointHandle,
    ctx: ExtensionContext,
  ) => Effect.Effect<void>;
  readonly parentAnchor: (ctx: ExtensionContext) => ParentAnchor;
  readonly checkpointOrchestrator: CheckpointOrchestratorContract;
  readonly configStore: ConfigStoreContract;
  readonly persistCommandConfig: (
    patch: Parameters<ConfigStoreContract["patch"]>[0],
    path: string,
  ) => ReturnType<ConfigStoreContract["patch"]>;
}
