import type { ProfileId, SubagentSelectionProvenance } from "../profiles/model.ts";

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

export type SubagentExecution = "foreground" | "background";
export type SubagentContextMode = "fresh" | "fork";
export type SubagentWriteIntent = "writer" | "read-only";
export type SubagentHost = "local" | "herdr";
export type SubagentRuntime = "pi" | "claude" | "codex";
/** Dormant local-service compatibility alias; public routing uses host + runtime. */
export type SubagentBackend = "pi";

export type SubagentCapability =
  | "steer"
  | "interrupt"
  | "resume"
  | "rename-display"
  | "parent-contact"
  | "peer-notice"
  | "native-fork";
export const SUBAGENT_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type SubagentEffort = (typeof SUBAGENT_EFFORTS)[number];

/** Runtime-native effort policy shared by config, settings, and launch preflight. */
export const SUBAGENT_RUNTIME_EFFORTS = {
  pi: SUBAGENT_EFFORTS,
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max"],
} as const satisfies Readonly<Record<SubagentRuntime, ReadonlyArray<SubagentEffort>>>;

export const subagentRuntimeEfforts = (runtime: SubagentRuntime): ReadonlyArray<SubagentEffort> =>
  SUBAGENT_RUNTIME_EFFORTS[runtime];

export const subagentRuntimeSupportsEffort = (
  runtime: SubagentRuntime,
  effort: SubagentEffort,
): boolean => subagentRuntimeEfforts(runtime).includes(effort);

/** Decodes an untyped host-reported thinking level; unknown or malformed values are rejected. */
export const decodeSubagentEffort = (value: unknown): SubagentEffort | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (SUBAGENT_EFFORTS as ReadonlyArray<string>).includes(normalized)
    ? (normalized as SubagentEffort)
    : undefined;
};

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
  readonly cost: number;
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

export interface SubagentRunView {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly profile?: ProfileId | undefined;
  readonly selection: SubagentSelectionProvenance;
  readonly cwd: string;
  readonly state: SubagentRunState;
  readonly execution: SubagentExecution;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly fastMode: boolean;
  readonly host?: SubagentHost | undefined;
  readonly runtime?: SubagentRuntime | undefined;
  readonly closeOnReport?: boolean | undefined;
  /** Current assignment/report generation. Zero means no report has been accepted yet. */
  readonly reportGeneration: number;
  /** Optional only for decoding/rendering persisted pre-v4 views. New runs always populate these. */
  readonly backend: SubagentBackend;
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

export interface StartSubagentRequest {
  readonly name?: string | undefined;
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly closeOnReport: boolean;
  /** Compatibility input for the currently implemented local Pi service. */
  readonly backend: SubagentBackend;
  readonly task: string;
  readonly profile?: ProfileId | undefined;
  readonly profileGuidance?: string | undefined;
  readonly selection?: SubagentSelectionProvenance | undefined;
  readonly cwd: string;
  readonly execution: SubagentExecution;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly fastMode: boolean;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly effortWasExplicit: boolean;
  readonly runtimeApiKey?: string | undefined;
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
  cost: 0,
});
