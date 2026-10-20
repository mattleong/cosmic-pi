import type * as Redacted from "effect/Redacted";
import type {
  SubagentContextMode,
  SubagentEffort,
  SubagentRuntime,
  SubagentWriteIntent,
} from "../domain/routing.ts";
import type { SubagentNestingPolicy, WriterWorkspaceMode } from "../config/schema.ts";
import type { WorkspaceHandle } from "../workspace/model.ts";
import type {
  ProfileId,
  ProfileRouteContinuation,
  SubagentModelOverride,
  SubagentSelectionProvenance,
} from "../profiles/model.ts";

export type RuntimeApiKey = Redacted.Redacted;

export const SUBAGENT_RUN_STATES = [
  "starting",
  "running",
  "waiting_for_parent",
  "paused",
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
    }
  | {
      readonly type: "notice";
      readonly kind: "message";
      /** `in` for a message this run received, `out` for one it sent. */
      readonly direction: "in" | "out";
      /** The other agent: a run ID or `main`. */
      readonly peer: string;
      readonly text: string;
      readonly createdAt: number;
    };

interface PendingParentQuestion {
  readonly requestId: string;
  readonly message: string;
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

interface SubagentCleanup {
  readonly disposition: "pending" | "confirmed" | "quarantined";
  readonly recovery?: "stop" | "manual" | undefined;
  readonly diagnostic?: SubagentCleanupDiagnostic | undefined;
}

/**
 * What became of a completed worktree writer's workspace once its cleanup was confirmed. Absent
 * while unknown, including when inspection failed or a run still used the tree.
 */
/** A finished worktree writer's workspace: its proposal, or how the workspace was resolved. */
export type SubagentWorkspaceOutcome =
  | { readonly status: "auto-discarded" | "integrated" | "discarded" }
  | {
      readonly status: "proposal";
      readonly changedFileCount: number;
      /** Writer-created files the proposal cannot carry, such as `.env`; gitignored files don't count. */
      readonly uncapturedFileCount?: number | undefined;
      readonly diffStat?: SubagentWorkspaceDiffStat | undefined;
    };

export const MAX_OUTCOME_DIFFSTAT_FILES = 20;

/** A proposal's changed-line totals and its first changed files' counts. */
export interface SubagentWorkspaceDiffStat {
  readonly addedLines: number;
  readonly deletedLines: number;
  /** At most `MAX_OUTCOME_DIFFSTAT_FILES`; `changedFileCount` counts every file. */
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly addedLines: number;
    readonly deletedLines: number;
    readonly binary?: true | undefined;
  }>;
}

/** A captured report longer than the in-memory cap; `finalText` keeps only its start. */
export interface SubagentReportTruncation {
  readonly retainedChars: number;
  readonly originalChars: number;
  readonly originalLines: number;
}

/**
 * A completed assignment's report, saved to a private file: the report the parent reads. A failure
 * longer than its preview is saved the same way.
 */
export interface SubagentReportArchive {
  readonly path: string;
  /** The saved text's size. */
  readonly chars: number;
  readonly lines: number;
  /** False when the report exceeded the archive cap, so the file holds only its start. */
  readonly complete: boolean;
}

export interface SubagentRunView {
  readonly cleanup?: SubagentCleanup | undefined;
  readonly writerCleanupQuarantined?: boolean | undefined;
  readonly steeringDelivery?: SteeringDeliveryState | undefined;
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly profile?: ProfileId | undefined;
  /** The custom agent launched; `profile` is the profile it routes through. */
  readonly agent?: string | undefined;
  readonly selection: SubagentSelectionProvenance;
  readonly modelOverride?: SubagentModelOverride | undefined;
  readonly parentRunId?: string | undefined;
  readonly depth?: number | undefined;
  readonly directChildCount?: number | undefined;
  readonly descendantCount?: number | undefined;
  readonly nativeActivity?: SubagentNativeActivity | undefined;
  readonly predecessorRunId?: string | undefined;
  readonly supersededByRunId?: string | undefined;
  /** Labels the agent whose message resumed the run for its current or last assignment. */
  readonly resumedBy?: string | undefined;
  readonly remainingCandidateCount?: number | undefined;
  readonly retryExhausted?: boolean | undefined;
  readonly retryBlocked?: boolean | undefined;
  readonly cwd: string;
  readonly writerWorkspaceMode?: WriterWorkspaceMode | undefined;
  readonly workspaceId?: string | undefined;
  readonly workspaceOutcome?: SubagentWorkspaceOutcome | undefined;
  readonly sourceCwd?: string | undefined;
  readonly state: SubagentRunState;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly openaiFastMode: boolean;
  readonly runtime: SubagentRuntime;
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
  /** The latest warning from either source. */
  readonly warning?: string | undefined;
  readonly warningSource?: "child" | "system" | undefined;
  /** The latest child warning and the latest system warning, each kept for this assignment. */
  readonly childWarning?: string | undefined;
  readonly systemWarning?: string | undefined;
  readonly question?: PendingParentQuestion | undefined;
  readonly sessionEvents: ReadonlyArray<SubagentSessionEvent>;
  readonly finalText?: string | undefined;
  readonly finalTextTruncation?: SubagentReportTruncation | undefined;
  readonly reportArchive?: SubagentReportArchive | undefined;
  readonly reportStatus?: "available" | "claimed" | "delivered" | "missing" | undefined;
  readonly error?: string | undefined;
  /** The saved failure, when `error` is longer than the model-facing preview. */
  readonly errorArchive?: SubagentReportArchive | undefined;
  readonly usage: SubagentUsage;
  readonly toolUses?: number | undefined;
  /** Agent messages this run sent or received; `sessionEvents` keeps only the newest. */
  readonly messageCount?: number | undefined;
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

/** A parent message answers the target's pending question, or otherwise steers its turn. */
export type SubagentSendDelivery = "answered" | "guided";

export interface SubagentSendOutcome {
  readonly delivery: SubagentSendDelivery;
  readonly run: SubagentRunView;
}

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
  readonly runtime: SubagentRuntime;
  readonly task: string;
  readonly profile?: ProfileId | undefined;
  /** A custom agent's name; its instructions arrive as `profileGuidance`. */
  readonly agent?: string | undefined;
  readonly profileGuidance?: string | undefined;
  readonly selection?: SubagentSelectionProvenance | undefined;
  readonly modelOverride?: SubagentModelOverride | undefined;
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
  run: Pick<SubagentRunView, "state" | "cleanup" | "writerCleanupQuarantined"> & {
    readonly question?: unknown;
  },
): boolean =>
  run.cleanup?.disposition === "quarantined" ||
  run.writerCleanupQuarantined === true ||
  (run.state === "waiting_for_parent" && run.question !== undefined) ||
  run.state === "paused";

const ACTIVE_RUN_STATES: ReadonlySet<SubagentRunState> = new Set([
  "starting",
  "running",
  "waiting_for_parent",
  "paused",
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

/** A run in one of these states may resume when its backend kept continuation state. */
const RESUMABLE_RUN_STATES: ReadonlySet<SubagentRunState> = new Set([
  "paused",
  "completed",
  "failed",
  "stopped",
]);

export const isResumableRunState = (state: SubagentRunState): boolean =>
  RESUMABLE_RUN_STATES.has(state);

export const emptyUsage = (): SubagentUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
});
