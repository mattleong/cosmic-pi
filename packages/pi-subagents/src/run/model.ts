import type * as Redacted from "effect/Redacted";
import type {
  SubagentContextMode,
  SubagentEffort,
  SubagentHost,
  SubagentRuntime,
  SubagentWriteIntent,
} from "../domain/routing.ts";
import type { SubagentNestingPolicy, WriterWorkspaceMode } from "../config/schema.ts";
import type { WorkspaceHandle } from "../workspace/model.ts";
import type {
  ProfileId,
  ProfileRouteContinuation,
  SubagentSelectionProvenance,
} from "../profiles/model.ts";
import type { ResultContract } from "../domain/result-contract.ts";

export type RuntimeApiKey = Redacted.Redacted<string>;

export const SUBAGENT_RUN_STATES = [
  "starting",
  "running",
  "waiting_for_parent",
  "paused",
  "reported",
  "completed",
  "failed",
  "stopping",
  "stopped",
] as const;
export type SubagentRunState = (typeof SUBAGENT_RUN_STATES)[number];

/** Pi supports every capability; other backends declare subsets of this list. */
export const PI_SUBAGENT_CAPABILITIES = [
  "steer",
  "interrupt",
  "resume",
  "rename-display",
  "parent-contact",
  "peer-notice",
  "native-fork",
] as const;
export type SubagentCapability = (typeof PI_SUBAGENT_CAPABILITIES)[number];

export interface SubagentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  /**
   * Known client-side cost estimate in USD. Absent means the backend never
   * reported a known cost; it is never presented as a known `$0`.
   */
  readonly cost?: number | undefined;
}

export type SubagentSessionEvent =
  | {
      readonly type: "assistant";
      readonly text: string;
      readonly createdAt: number;
    }
  | {
      readonly type: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly target?: string | undefined;
      readonly state: "running" | "completed" | "failed";
      readonly startedAt: number;
      readonly endedAt?: number | undefined;
    }
  | {
      readonly type: "notice";
      readonly kind: "parent" | "progress" | "warning" | "question";
      readonly text: string;
      readonly createdAt: number;
    };

export interface PendingParentQuestion {
  readonly requestId: string;
  readonly message: string;
  readonly createdAt: number;
}

export interface WriteClaimViolation {
  readonly path: string;
  readonly toolName: string;
  readonly observedAt: number;
}

export interface SubagentNativeActivity {
  readonly active: number;
  readonly total: number;
  readonly latest?:
    | {
        readonly id?: string | undefined;
        readonly kind: string;
        readonly state: "running" | "activity" | "completed" | "failed" | "stopped";
        readonly updatedAt: number;
      }
    | undefined;
}

export interface SubagentWriteAudit {
  readonly observedFileWrites: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<WriteClaimViolation>;
  readonly bashWriteHints: number;
}

/** Native guidance delivery only; never evidence that the model incorporated it. */
export const STEERING_DELIVERY_STATES = [
  "pending",
  "confirmed",
  "not-sent",
  "report-unconfirmed",
  "unresolved",
] as const;
export type SteeringDeliveryState = (typeof STEERING_DELIVERY_STATES)[number];

/** Delivery uncertainty blocks replacement even after process cleanup is confirmed. */
export const hasUnresolvedSteeringDelivery = (run: {
  readonly steeringDelivery?: SteeringDeliveryState | undefined;
}): boolean => run.steeringDelivery === "pending" || run.steeringDelivery === "unresolved";

/** Trusted workflow placement of an owned run; never accepted from tool or proxy schemas. */
export interface SubagentWorkflowMembership {
  readonly workflowId: string;
  /** Workflow display name for parent-facing notices. */
  readonly name?: string | undefined;
  readonly phase?: string | undefined;
}

export interface SubagentRunView {
  readonly steeringDelivery?: SteeringDeliveryState | undefined;
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly profile?: ProfileId | undefined;
  readonly selection: SubagentSelectionProvenance;
  /** Immutable ancestry. Top-level runs name the root virtual node. */
  readonly parentRunId?: string | undefined;
  /** Root Pi is depth 0; top-level runs are depth 1. */
  readonly depth?: number | undefined;
  /** Bounded tree counts projected from the root-owned registry. */
  readonly directChildCount?: number | undefined;
  readonly descendantCount?: number | undefined;
  /** Runtime-native agents remain internal activity and never become Pi run nodes. */
  readonly nativeActivity?: SubagentNativeActivity | undefined;
  /** Failed predecessor continued explicitly through the remaining frozen profile route. */
  readonly predecessorRunId?: string | undefined;
  /** Successor admitted from this failed run's explicit retry claim. */
  readonly supersededByRunId?: string | undefined;
  /** Configured candidates after the selected candidate, before dynamic retry-time checks. */
  readonly remainingCandidateCount?: number | undefined;
  /** Remaining candidates were checked and none could be admitted. */
  readonly retryExhausted?: boolean | undefined;
  /** Continuation encountered ownership uncertainty and is permanently fail-closed. */
  readonly retryBlocked?: boolean | undefined;
  readonly cwd: string;
  /** Frozen session writer mode and private artifact identity, never a per-worker override. */
  readonly writerWorkspaceMode?: WriterWorkspaceMode | undefined;
  readonly workspaceId?: string | undefined;
  readonly sourceCwd?: string | undefined;
  readonly workflow?: SubagentWorkflowMembership | undefined;
  readonly state: SubagentRunState;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  /** Exact cooperative file claims. Absent on a writer means exclusive whole-cwd ownership. */
  readonly writeClaims?: ReadonlyArray<string> | undefined;
  readonly writeAudit?: SubagentWriteAudit | undefined;
  readonly writeAdmissionPaused?: boolean | undefined;
  /** This run is in the current pool pause's authoritative offender set. */
  readonly writeViolationOffender?: boolean | undefined;
  readonly openaiFastMode: boolean;
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly closeOnReport: boolean;
  /** Current assignment/report generation. Zero means no report has been accepted yet. */
  readonly reportGeneration: number;
  readonly capabilities: ReadonlyArray<SubagentCapability>;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly pid?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionFile?: string | undefined;
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
  readonly lastActivityAt: number;
  readonly currentTool?: string | undefined;
  readonly progress?: string | undefined;
  readonly warning?: string | undefined;
  readonly warningSource?: "child" | "system" | undefined;
  readonly systemWarning?: string | undefined;
  readonly question?: PendingParentQuestion | undefined;
  readonly sessionEvents: ReadonlyArray<SubagentSessionEvent>;
  readonly finalText?: string | undefined;
  /** Observed before report redaction. Absent historical metadata means unknown. */
  readonly reportStatus?: "available" | "claimed" | "delivered" | "missing" | undefined;
  readonly error?: string | undefined;
  readonly usage: SubagentUsage;
  /** Tool calls the run started across its assignments; only grows. Absent before the first. */
  readonly toolUses?: number | undefined;
}

export const SUBAGENT_ROOT_RUN_ID = "root";

export interface SubagentTreeRootView {
  readonly id: typeof SUBAGENT_ROOT_RUN_ID;
  readonly depth: 0;
  readonly directChildCount: number;
  readonly descendantCount: number;
}

export interface SubagentProjection {
  readonly revision: number;
  readonly root?: SubagentTreeRootView | undefined;
  readonly runs: ReadonlyArray<SubagentRunView>;
}

export const FAILED_START_CLEANUP_DISPOSITIONS = ["pending", "confirmed", "quarantined"] as const;
export type FailedStartCleanupDisposition = (typeof FAILED_START_CLEANUP_DISPOSITIONS)[number];

export const FAILED_START_RETRY_DISPOSITIONS = [
  "eligible",
  "pending",
  "blocked",
  "exhausted",
  "unavailable",
] as const;
export type FailedStartRetryDisposition = (typeof FAILED_START_RETRY_DISPOSITIONS)[number];

/** Settled, privacy-bounded recovery facts for a start that already admitted a run. */
export interface FailedStartRecovery {
  readonly runId: string;
  readonly cleanupDisposition: FailedStartCleanupDisposition;
  readonly retryDisposition: FailedStartRetryDisposition;
  readonly remainingCandidateCount: number;
  readonly hasRemainingCandidate: boolean;
}

export interface SubagentRetrySupersession {
  readonly runId: string;
  readonly claimToken: string;
}

export interface StartSubagentRequest {
  readonly name?: string | undefined;
  /** Internal root-owned ancestry. This field is never accepted by public tool schemas. */
  readonly parentRunId?: string | undefined;
  /** One immutable policy revision captured by the complete start batch. */
  readonly nestingPolicy?: SubagentNestingPolicy | undefined;
  readonly nestingPolicyRevision?: number | undefined;
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly closeOnReport: boolean;
  readonly task: string;
  readonly profile?: ProfileId | undefined;
  readonly profileGuidance?: string | undefined;
  /** Exact workspace-relative file claims; absent means an exclusive writer. */
  readonly writes?: ReadonlyArray<string> | undefined;
  readonly selection?: SubagentSelectionProvenance | undefined;
  /** Frozen configured route and cursor; never accepted from the public start schema. */
  readonly routeContinuation?: ProfileRouteContinuation | undefined;
  /** Internal exclusive predecessor claim consumed atomically by successor admission. */
  readonly supersedes?: SubagentRetrySupersession | undefined;
  /** Coordinator-only prepared artifact. Public and proxy schemas cannot supply this. */
  readonly workspace?: WorkspaceHandle | undefined;
  readonly writerWorkspaceMode?: WriterWorkspaceMode | undefined;
  /** Internal per-run writer mode chosen by a trusted owner; a retry keeps its predecessor's mode. */
  readonly writerWorkspaceModeOverride?: WriterWorkspaceMode | undefined;
  /** Internal workflow membership, projected to the run view. */
  readonly workflow?: SubagentWorkflowMembership | undefined;
  /** Internal structured-result contract; a completed run's final text is the result's canonical JSON. */
  readonly resultContract?: ResultContract | undefined;
  readonly cwd: string;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly openaiFastMode: boolean;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly effortWasExplicit: boolean;
  readonly runtimeApiKey?: RuntimeApiKey | undefined;
  readonly activeTools: ReadonlyArray<string>;
  readonly projectTrusted: boolean;
  readonly parentSessionId: string;
  readonly parentSessionFile?: string | undefined;
  readonly parentLeafId?: string | undefined;
}

export const hasSubagentCapability = (
  run: Pick<SubagentRunView, "capabilities">,
  capability: SubagentCapability,
): boolean => run.capabilities.includes(capability);

/** Parent orchestration must act before an await can make useful progress. */
export const isParentActionRequiredRun = (
  run: Pick<SubagentRunView, "state" | "writeAdmissionPaused" | "writeViolationOffender"> & {
    readonly question?: unknown;
  },
): boolean =>
  (run.state === "waiting_for_parent" && run.question !== undefined) ||
  run.state === "paused" ||
  (run.writeAdmissionPaused === true &&
    (run.writeViolationOffender !== true || isTerminalRunState(run.state)));

export const ACTIVE_RUN_STATES: ReadonlySet<SubagentRunState> = new Set([
  "starting",
  "running",
  "waiting_for_parent",
  "paused",
  "reported",
  "stopping",
]);

export const isActiveRunState = (state: SubagentRunState): boolean => ACTIVE_RUN_STATES.has(state);

export const TERMINAL_RUN_STATES: ReadonlySet<SubagentRunState> = new Set([
  "completed",
  "failed",
  "stopped",
]);

export const isTerminalRunState = (state: SubagentRunState): boolean =>
  TERMINAL_RUN_STATES.has(state);

/** Finished refers to the current assignment, not necessarily to backend resource closure. */
export const isAssignmentFinishedRunState = (state: SubagentRunState): boolean =>
  state === "reported" || isTerminalRunState(state);

export const emptyUsage = (): SubagentUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
});
