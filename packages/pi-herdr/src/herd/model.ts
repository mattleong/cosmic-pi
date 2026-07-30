export const HERDR_AGENT_STATES = [
  "starting",
  "working",
  "blocked",
  "awaiting_report",
  "completed",
  "failed",
  "stopped",
  "unknown",
] as const;

export type HerdrAgentState = (typeof HERDR_AGENT_STATES)[number];
export type HerdrRemoteStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type HerdrAwaitUntil = "all_finished" | "any_finished";
export type HerdrReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";

export interface HerdrAgentView {
  readonly id: string;
  readonly name: string;
  readonly agentName: string;
  readonly task: string;
  readonly cwd: string;
  readonly state: HerdrAgentState;
  readonly remoteStatus?: HerdrRemoteStatus | undefined;
  readonly session: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId?: string | undefined;
  readonly reportGeneration: string;
  readonly report?: string | undefined;
  readonly error?: string | undefined;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number | undefined;
}

export interface HerdrProjection {
  readonly revision: number;
  readonly agents: ReadonlyArray<HerdrAgentView>;
}

export interface StartHerdrAgentRequest {
  readonly task: string;
  readonly name?: string | undefined;
}

export interface HerdrAgentReadResult {
  readonly id: string;
  readonly source: HerdrReadSource;
  readonly text: string;
}

export interface HerdrBatchFailure {
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

export interface HerdrBatchResult {
  readonly agents: ReadonlyArray<HerdrAgentView>;
  readonly failures: ReadonlyArray<HerdrBatchFailure>;
}

export interface HerdrWorkspaceInfo {
  readonly workspaceId: string;
  readonly label: string;
  readonly focused: boolean;
  readonly activeTabId: string;
  readonly worktree?:
    | {
        readonly repoRoot?: string | undefined;
        readonly checkoutPath?: string | undefined;
      }
    | undefined;
}

export interface HerdrTabInfo {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly label: string;
  readonly paneCount: number;
  readonly focused: boolean;
}

export interface HerdrPaneInfo {
  readonly paneId: string;
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly cwd?: string | undefined;
  readonly foregroundCwd?: string | undefined;
  readonly label?: string | undefined;
  readonly focused: boolean;
  readonly agentStatus: HerdrRemoteStatus;
}

export interface HerdrRemoteAgentInfo extends HerdrPaneInfo {
  readonly name?: string | undefined;
  readonly agent?: string | undefined;
  readonly stateChangeSeq: number;
  readonly interactiveReady?: boolean | undefined;
}

export interface HerdrLayoutPane {
  readonly paneId: string;
  readonly width: number;
  readonly height: number;
}

export interface HerdrLayoutInfo {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly panes: ReadonlyArray<HerdrLayoutPane>;
}

export interface HerdrSnapshot {
  readonly version: string;
  readonly protocol: number;
  readonly focusedWorkspaceId?: string | undefined;
  readonly focusedTabId?: string | undefined;
  readonly focusedPaneId?: string | undefined;
  readonly workspaces: ReadonlyArray<HerdrWorkspaceInfo>;
  readonly tabs: ReadonlyArray<HerdrTabInfo>;
  readonly panes: ReadonlyArray<HerdrPaneInfo>;
  readonly agents: ReadonlyArray<HerdrRemoteAgentInfo>;
  readonly layouts: ReadonlyArray<HerdrLayoutInfo>;
}

export interface HerdrCreatedWorkspace {
  readonly workspace: HerdrWorkspaceInfo;
  readonly tab: HerdrTabInfo;
  readonly rootPane: HerdrPaneInfo;
}

export interface HerdrCreatedTab {
  readonly tab: HerdrTabInfo;
  readonly rootPane: HerdrPaneInfo;
}

export interface HerdrReport {
  readonly generation: string;
  readonly status: "completed" | "blocked" | "failed";
  readonly report: string;
  readonly submittedAt: number;
}

export const isHerdrAgentFinished = (state: HerdrAgentState): boolean =>
  state === "completed" || state === "failed" || state === "stopped";

export const isHerdrAgentActive = (state: HerdrAgentState): boolean => !isHerdrAgentFinished(state);
