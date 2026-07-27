export type SubagentRunState =
  | "starting"
  | "running"
  | "waiting_for_parent"
  | "paused"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped";

export type SubagentExecution = "foreground" | "background";
export type SubagentContextMode = "fresh" | "fork";
export type SubagentWriteIntent = "writer" | "read-only";
export type SubagentBackend = "pi" | "claude-cli";
export type SubagentCapability =
  | "steer"
  | "interrupt"
  | "resume"
  | "rename-display"
  | "parent-contact"
  | "peer-notice"
  | "native-fork";
export type SubagentEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const PI_SUBAGENT_CAPABILITIES = [
  "steer",
  "interrupt",
  "resume",
  "rename-display",
  "parent-contact",
  "peer-notice",
  "native-fork",
] as const satisfies ReadonlyArray<SubagentCapability>;

export const CLAUDE_CLI_SUBAGENT_CAPABILITIES = [
  "resume",
  "rename-display",
] as const satisfies ReadonlyArray<SubagentCapability>;

const CLAUDE_MODEL_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLAUDE_MODEL_ALIASES: ReadonlySet<string> = new Set(["fable", "sonnet", "opus", "haiku"]);

export const isClaudeModelSelector = (value: string): boolean => {
  const trimmed = value.trim();
  return (
    CLAUDE_MODEL_SELECTOR.test(trimmed) &&
    (CLAUDE_MODEL_ALIASES.has(trimmed) || trimmed.toLowerCase().startsWith("claude"))
  );
};

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
  readonly cwd: string;
  readonly state: SubagentRunState;
  readonly execution: SubagentExecution;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
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
  readonly backend: SubagentBackend;
  readonly task: string;
  readonly cwd: string;
  readonly execution: SubagentExecution;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
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

export interface SubagentModelView {
  readonly backend: SubagentBackend;
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
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

export const emptyUsage = (): SubagentUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
});
