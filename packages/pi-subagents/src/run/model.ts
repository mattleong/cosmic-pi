import type * as Redacted from "effect/Redacted";
import type {
  SubagentContextMode,
  SubagentEffort,
  SubagentHost,
  SubagentRuntime,
  SubagentWriteIntent,
} from "../domain/routing.ts";
import type {
  ProfileId,
  ProfileRouteContinuation,
  SubagentSelectionProvenance,
} from "../profiles/model.ts";

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

export type SubagentCapability =
  | "steer"
  | "interrupt"
  | "resume"
  | "rename-display"
  | "parent-contact"
  | "peer-notice"
  | "native-fork";

export const PI_SUBAGENT_CAPABILITIES = [
  "steer",
  "interrupt",
  "resume",
  "rename-display",
  "parent-contact",
  "peer-notice",
  "native-fork",
] as const satisfies ReadonlyArray<SubagentCapability>;

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

export interface SubagentWriteAudit {
  readonly observedFileWrites: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<WriteClaimViolation>;
  readonly bashWriteHints: number;
}

export interface SubagentRunView {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly profile?: ProfileId | undefined;
  readonly selection: SubagentSelectionProvenance;
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
  readonly state: SubagentRunState;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  /** Exact cooperative file claims. Absent on a writer means exclusive whole-cwd ownership. */
  readonly writeClaims?: ReadonlyArray<string> | undefined;
  readonly writeAudit?: SubagentWriteAudit | undefined;
  readonly writeAdmissionPaused?: boolean | undefined;
  readonly fastMode: boolean;
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
  readonly question?: PendingParentQuestion | undefined;
  readonly sessionEvents: ReadonlyArray<SubagentSessionEvent>;
  readonly finalText?: string | undefined;
  readonly error?: string | undefined;
  readonly usage: SubagentUsage;
}

export interface SubagentProjection {
  readonly revision: number;
  readonly runs: ReadonlyArray<SubagentRunView>;
}

export interface SubagentRetrySupersession {
  readonly runId: string;
  readonly claimToken: string;
}

export interface StartSubagentRequest {
  readonly name?: string | undefined;
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
  readonly cwd: string;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly fastMode: boolean;
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
