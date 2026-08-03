import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import type { AdvisorEffectExecutor, AdvisorPlatform } from "../../../boundary/executor.ts";
import type { AdvisorHostBindings } from "../../../boundary/host-bindings.ts";
import type { PiCommandAdapter } from "../../../boundary/host-commands.ts";
import type { CheckpointOrchestratorShape } from "../../../checkpoint/orchestrator.ts";
import type { ResolvedAdvisorConfig } from "../../../config/options.ts";
import type { ConfigStoreShape } from "../../../config/store.ts";
import type { AdvisorReviewQueue } from "../../../queue/service.ts";
import type { AdvisorReviewFocus } from "../../../review/index.ts";
import type {
  AdvisorCheckpointHandle,
  AdvisorSkipReason,
  ParentAnchor,
  ReviewPhase,
  ReviewSource,
} from "../../controller-types.ts";
import type { AdvisorActiveTrajectoryState, AdvisorApplicationState } from "../../state.ts";
import type { SessionRefs } from "../session-refs.ts";

export interface EventsDeps {
  readonly refs: SessionRefs;
  readonly pi: ExtensionAPI;
  readonly hostBindings: AdvisorHostBindings;
  readonly getState: () => AdvisorApplicationState;
  readonly updateApplicationState: (
    update: (state: AdvisorApplicationState) => AdvisorApplicationState,
  ) => void;
  readonly mutateMetrics: (mutate: (next: AdvisorApplicationState["metrics"]) => void) => void;
  readonly currentConfig: () => ResolvedAdvisorConfig;
  readonly advanceDomainCounter: (
    key: "epoch" | "cancellationEpoch" | "parentTurnId" | "requestSequence",
  ) => number;
  readonly setDomainCounter: (
    key: "epoch" | "cancellationEpoch" | "parentTurnId" | "requestSequence",
    value: number,
  ) => number;
  readonly clearPersistentTrajectory: () => void;
  readonly clearPendingRecovery: () => void;
  readonly clearPendingReceipt: () => void;
  readonly latchCancellation: () => void;
  readonly resetRequestDomain: (resetLifecycle?: boolean) => void;
  readonly persistCurrentLedger: (ctx: ExtensionContext) => void;
  readonly persistLedger: (anchor: ParentAnchor) => void;
  readonly ingest: (input: Parameters<AdvisorReviewQueue["ingest"]>[1]) => void;
  readonly recordReceipt: (ids: readonly string[]) => void;
  readonly recordSkip: (reason: AdvisorSkipReason) => void;
  readonly mutateTrajectory: (
    id: number,
    mutate: (next: AdvisorActiveTrajectoryState) => AdvisorActiveTrajectoryState,
  ) => AdvisorActiveTrajectoryState | undefined;
  readonly runSessionEffect: <A, E>(
    effect: Effect.Effect<A, E, AdvisorPlatform | PiCommandAdapter>,
  ) => Promise<A>;
  readonly parentExecutor: AdvisorEffectExecutor;
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
  readonly awaitCatchUp: (handle: AdvisorCheckpointHandle, ctx: ExtensionContext) => Promise<void>;
  readonly parentAnchor: (ctx: ExtensionContext) => ParentAnchor;
  readonly publishControllerSnapshot: () => Effect.Effect<void>;
  readonly checkpointOrchestrator: CheckpointOrchestratorShape;
  readonly configStore: ConfigStoreShape;
}
