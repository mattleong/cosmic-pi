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

export type RuntimeApiKey = Redacted.Redacted;

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
  readonly cost?: number | undefined;
  /** Latest share of the child's context window in use, when the runtime reports it. */
  readonly contextPercent?: number | undefined;
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
      readonly outputPreview?: string | undefined;
    }
  | {
      readonly type: "notice";
      readonly kind: "parent" | "progress" | "warning" | "question";
      readonly text: string;
      readonly createdAt: number;
    };

interface PendingParentQuestion {
  readonly requestId: string;
  readonly message: string;
}

interface WriteClaimViolation {
  readonly path: string;
  readonly toolName: string;
  readonly observedAt: number;
}

interface SubagentNativeActivity {
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

interface SubagentWriteAudit {
  readonly observedFileWrites: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<WriteClaimViolation>;
  readonly bashWriteHints: number;
}

export const STEERING_DELIVERY_STATES = [
  "pending",
  "confirmed",
  "not-sent",
  "report-unconfirmed",
  "unresolved",
] as const;
export type SteeringDeliveryState = (typeof STEERING_DELIVERY_STATES)[number];

export const hasUnresolvedSteeringDelivery = (run: {
  readonly steeringDelivery?: SteeringDeliveryState | undefined;
}): boolean => run.steeringDelivery === "pending" || run.steeringDelivery === "unresolved";

export interface SubagentCleanupDiagnostic {
  readonly phase:
    | "backend-scope"
    | "process-exit"
    | "process-group"
    | "descendant-snapshot"
    | "descendant-groups"
    | "writer-lease";
  readonly code?: string | undefined;
  readonly message: string;
}

export interface SubagentCleanup {
  readonly disposition: "pending" | "confirmed" | "quarantined";
  readonly recovery?: "stop" | "manual" | undefined;
  readonly diagnostic?: SubagentCleanupDiagnostic | undefined;
}

export interface SubagentRunView {
  readonly cleanup?: SubagentCleanup | undefined;
  readonly writerCleanupQuarantined?: boolean | undefined;
  readonly steeringDelivery?: SteeringDeliveryState | undefined;
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly profile?: ProfileId | undefined;
  readonly selection: SubagentSelectionProvenance;
  readonly parentRunId?: string | undefined;
  readonly depth?: number | undefined;
  readonly directChildCount?: number | undefined;
  readonly descendantCount?: number | undefined;
  readonly nativeActivity?: SubagentNativeActivity | undefined;
  readonly predecessorRunId?: string | undefined;
  readonly supersededByRunId?: string | undefined;
  readonly remainingCandidateCount?: number | undefined;
  readonly retryExhausted?: boolean | undefined;
  readonly retryBlocked?: boolean | undefined;
  readonly cwd: string;
  readonly writerWorkspaceMode?: WriterWorkspaceMode | undefined;
  readonly workspaceId?: string | undefined;
  readonly sourceCwd?: string | undefined;
  readonly state: SubagentRunState;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly writeClaims?: ReadonlyArray<string> | undefined;
  readonly writeAudit?: SubagentWriteAudit | undefined;
  readonly writeAdmissionPaused?: boolean | undefined;
  readonly writeViolationOffender?: boolean | undefined;
  readonly openaiFastMode: boolean;
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly closeOnReport: boolean;
  readonly reportGeneration: number;
  readonly assignmentEpoch: number;
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
  readonly reportStatus?: "available" | "claimed" | "delivered" | "missing" | undefined;
  readonly error?: string | undefined;
  readonly usage: SubagentUsage;
  readonly toolUses?: number | undefined;
}

export type SubagentControlExpectation = Pick<
  SubagentRunView,
  "assignmentEpoch" | "sessionId" | "state"
> & { readonly questionRequestId?: string | undefined };

export const captureSubagentControlExpectation = (
  run: SubagentRunView,
): SubagentControlExpectation => ({
  assignmentEpoch: run.assignmentEpoch,
  sessionId: run.sessionId,
  state: run.state,
  questionRequestId: run.question?.requestId,
});

export const SUBAGENT_ROOT_RUN_ID = "root";

export interface SubagentProjection {
  readonly revision: number;
  readonly runs: ReadonlyArray<SubagentRunView>;
  /** Every run this session started, including runs already evicted from `runs`. */
  readonly sessionUsage?: SubagentUsage | undefined;
}

export const FAILED_START_CLEANUP_DISPOSITIONS = ["pending", "confirmed", "quarantined"] as const;
type FailedStartCleanupDisposition = (typeof FAILED_START_CLEANUP_DISPOSITIONS)[number];

export const FAILED_START_RETRY_DISPOSITIONS = [
  "eligible",
  "pending",
  "blocked",
  "exhausted",
  "unavailable",
] as const;
type FailedStartRetryDisposition = (typeof FAILED_START_RETRY_DISPOSITIONS)[number];

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

/** Native facts captured by the immediate Pi parent, never launch authority or credentials. */
export interface SubagentParentContext {
  readonly sessionId: string;
  readonly sessionFile?: string | undefined;
  readonly leafId?: string | undefined;
  readonly model?: string | undefined;
  readonly effort: SubagentEffort;
  readonly contextTokens?: number | undefined;
}

export interface SubagentLaunchParent {
  readonly cwd: string;
  readonly parentContext: SubagentParentContext;
}

export interface StartSubagentRequest {
  readonly name?: string | undefined;
  readonly parentRunId?: string | undefined;
  readonly nestingPolicy?: SubagentNestingPolicy | undefined;
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly closeOnReport: boolean;
  readonly task: string;
  readonly profile?: ProfileId | undefined;
  readonly profileGuidance?: string | undefined;
  readonly writes?: ReadonlyArray<string> | undefined;
  readonly selection?: SubagentSelectionProvenance | undefined;
  readonly routeContinuation?: ProfileRouteContinuation | undefined;
  readonly supersedes?: SubagentRetrySupersession | undefined;
  readonly workspace?: WorkspaceHandle | undefined;
  readonly writerWorkspaceMode?: WriterWorkspaceMode | undefined;
  readonly writerWorkspaceModeOverride?: WriterWorkspaceMode | undefined;
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
  /** A same-model fork whose requests can reuse the parent's cached prompt prefix. */
  readonly sharesParentPromptCache?: boolean | undefined;
}

export const hasSubagentCapability = (
  run: Pick<SubagentRunView, "capabilities">,
  capability: SubagentCapability,
): boolean => run.capabilities.includes(capability);

export const isParentActionRequiredRun = (
  run: Pick<
    SubagentRunView,
    | "state"
    | "writeAdmissionPaused"
    | "writeViolationOffender"
    | "cleanup"
    | "writerCleanupQuarantined"
  > & {
    readonly question?: unknown;
  },
): boolean =>
  run.cleanup?.disposition === "quarantined" ||
  run.writerCleanupQuarantined === true ||
  (run.state === "waiting_for_parent" && run.question !== undefined) ||
  run.state === "paused" ||
  (run.writeAdmissionPaused === true &&
    (run.writeViolationOffender !== true || isTerminalRunState(run.state)));

const ACTIVE_RUN_STATES: ReadonlySet<SubagentRunState> = new Set([
  "starting",
  "running",
  "waiting_for_parent",
  "paused",
  "reported",
  "stopping",
]);

export const isActiveRunState = (state: SubagentRunState): boolean => ACTIVE_RUN_STATES.has(state);

const TERMINAL_RUN_STATES: ReadonlySet<SubagentRunState> = new Set([
  "completed",
  "failed",
  "stopped",
]);

export const isTerminalRunState = (state: SubagentRunState): boolean =>
  TERMINAL_RUN_STATES.has(state);

export const isAssignmentFinishedRunState = (state: SubagentRunState): boolean =>
  state === "reported" || isTerminalRunState(state);

export const emptyUsage = (): SubagentUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
});
