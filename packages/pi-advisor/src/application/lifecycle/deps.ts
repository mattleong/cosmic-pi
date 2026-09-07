/** Shared type-only dependency rooms for the lifecycle factories. No runtime behavior. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { CheckpointOrchestratorContract } from "../../checkpoint/orchestrator.ts";
import type { ResolvedAdvisorConfig } from "../../config/options.ts";
import type { AdvisorReviewQueue } from "../../queue/review-queue.ts";
import type { AdvisorReviewFocus } from "../../review/schema.ts";
import type { ParentAnchor, ReviewPhase, ReviewSource } from "../controller.ts";
import type { AdvisorApplicationState } from "../state.ts";

/** Pi host API handle shared by event, command, and delivery workflows. */
export interface HostApi {
  readonly pi: ExtensionAPI;
}

/** Read side of the immutable application-state authority. */
export interface StateRead {
  readonly getState: () => AdvisorApplicationState;
  readonly currentConfig: () => ResolvedAdvisorConfig;
}

/** Write side of the immutable application-state authority. */
export interface StateWrite {
  readonly updateApplicationState: (
    update: (state: AdvisorApplicationState) => AdvisorApplicationState,
  ) => void;
  readonly updateMetrics: (
    update: (metrics: AdvisorApplicationState["metrics"]) => AdvisorApplicationState["metrics"],
  ) => void;
}

/** Ledger persistence shared by event and checkpoint flows. */
export interface LedgerPersistence {
  readonly persistCurrentLedger: (ctx: ExtensionContext) => void;
  readonly persistLedger: (anchor: ParentAnchor) => void;
}

/** Child runtime start/stop and request-cancellation controls. */
export interface RuntimeControls {
  readonly startRuntimeEffect: (
    ctx: ExtensionContext,
    restoration?: "preserve-live" | "restore-branch",
    allowDisabled?: boolean,
  ) => Effect.Effect<number | undefined>;
  readonly stopRuntimeEffect: () => Effect.Effect<void>;
  readonly cancelRequest: () => void;
}

/** Checkpoint orchestrator plus the application scope its work runs in. */
export interface CheckpointOrchestration {
  readonly applicationScope: Scope.Scope;
  readonly checkpointOrchestrator: CheckpointOrchestratorContract;
}

/** Single admission contract for checkpoint requests shared by commands and lifecycle events. */
export interface CheckpointRequestOptions {
  ctx: ExtensionContext;
  focus: AdvisorReviewFocus;
  phase: ReviewPhase;
  source: ReviewSource;
  requiresEnabled: boolean;
  trajectoryId?: number;
  abortOnBlocker?: boolean;
}

/** Intervention evidence ingest and receipt recording shared by events and delivery. */
export interface InterventionIngress {
  readonly ingest: (input: Parameters<AdvisorReviewQueue["ingest"]>[1]) => void;
  readonly recordReceipt: (ids: readonly string[]) => void;
}
