import type { PersistedHerdrRun } from "../config/schema.ts";
import type {
  HerdrAgentKind,
  HerdrAgentState,
  HerdrAgentView,
  HerdrRemoteAgentInfo,
  HerdrRemoteStatus,
  HerdrSnapshot,
  HerdrWorkspaceInfo,
} from "./model.ts";

const MAX_TASK_CHARS = 32_768;
const MAX_NAME_CHARS = 60;
const MAX_MODEL_CHARS = 200;

export const normalizeTask = (task: string): string => task.trim().slice(0, MAX_TASK_CHARS);

export const normalizeModel = (model: string): string | undefined => {
  const value = model.trim().slice(0, MAX_MODEL_CHARS);
  return value &&
    !value.startsWith("-") &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
    ? value
    : undefined;
};

export const agentKindLabel = (kind: HerdrAgentKind): string =>
  kind === "claude" ? "Claude" : kind === "pi" ? "Pi" : "Codex";

export const nextDisplayOrdinal = (
  kind: HerdrAgentKind,
  runs: Iterable<HerdrAgentView>,
): number => {
  let maximum = 0;
  const pattern = new RegExp(`^${agentKindLabel(kind)} (\\d+)$`);
  for (const run of runs) {
    if (run.kind !== kind) continue;
    const match = pattern.exec(run.name);
    const ordinal = match?.[1] ? Number.parseInt(match[1], 10) : 0;
    if (ordinal > maximum) maximum = ordinal;
  }
  return maximum + 1;
};

export const displayName = (
  kind: HerdrAgentKind,
  requested: string | undefined,
  ordinal: number,
): string => {
  const value = requested?.trim().replaceAll(/\s+/g, " ").slice(0, MAX_NAME_CHARS);
  return value || `${agentKindLabel(kind)} ${ordinal}`;
};

export const paneLabel = (kind: HerdrAgentKind, name: string): string =>
  `${agentKindLabel(kind)} · ${name}`.slice(0, 80);

const reportInstruction = (kind: HerdrAgentKind): string =>
  kind === "pi"
    ? "call herdr_report_submit exactly once"
    : kind === "claude"
      ? "call mcp__herdr_report__submit_report exactly once"
      : "call the submit_report tool from the private herdr_report MCP server exactly once";

export const taskPrompt = (
  kind: HerdrAgentKind,
  task: string,
): string => `Complete this delegated task with read-only project access:

${task}

Do not modify project files, request elevated permissions, or create subagents. Before your final response, ${reportInstruction(kind)} with the complete report and status completed, blocked, or failed. The report must be self-contained and must not ask the user to manage an artifact.`;

export const guidancePrompt = (
  kind: HerdrAgentKind,
  message: string,
): string => `Additional guidance for the current delegated task:

${message.trim()}

Continue the same task. When finished, ${reportInstruction(kind)} with one complete final report.`;

const samePath = (left: string | undefined, right: string): boolean =>
  left !== undefined && left === right;

export const matchingWorkspaces = (
  snapshot: HerdrSnapshot,
  cwd: string,
): ReadonlyArray<HerdrWorkspaceInfo> =>
  snapshot.workspaces.filter((workspace) => {
    if (
      samePath(workspace.worktree?.checkoutPath, cwd) ||
      samePath(workspace.worktree?.repoRoot, cwd)
    )
      return true;
    return snapshot.panes.some(
      (pane) =>
        pane.workspaceId === workspace.workspaceId &&
        (samePath(pane.cwd, cwd) || samePath(pane.foregroundCwd, cwd)),
    );
  });

export const selectWorkspace = (
  snapshot: HerdrSnapshot,
  cwd: string,
): HerdrWorkspaceInfo | undefined => {
  const matches = matchingWorkspaces(snapshot, cwd);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 && snapshot.focusedWorkspaceId) {
    const focused = matches.filter(
      (workspace) => workspace.workspaceId === snapshot.focusedWorkspaceId,
    );
    if (focused.length === 1) return focused[0];
  }
  return undefined;
};

export const splitTarget = (
  snapshot: HerdrSnapshot,
  tabId: string,
  fallbackPaneId: string,
): { readonly paneId: string; readonly direction: "right" | "down" } => {
  const layout = snapshot.layouts.find((candidate) => candidate.tabId === tabId);
  const largest = layout?.panes.reduce<
    { readonly paneId: string; readonly width: number; readonly height: number } | undefined
  >((selected, pane) => {
    if (!selected || pane.width * pane.height > selected.width * selected.height) return pane;
    return selected;
  }, undefined);
  if (!largest) return { paneId: fallbackPaneId, direction: "right" };
  return {
    paneId: largest.paneId,
    direction: largest.width >= largest.height * 2 ? "right" : "down",
  };
};

export const remoteState = (status: HerdrRemoteStatus): HerdrAgentState => {
  switch (status) {
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "idle":
    case "done":
      return "awaiting_report";
    case "unknown":
      return "unknown";
  }
};

export const matchesOwnedAgent = (run: HerdrAgentView, remote: HerdrRemoteAgentInfo): boolean =>
  remote.paneId === run.paneId &&
  remote.tabId === run.tabId &&
  remote.workspaceId === run.workspaceId &&
  remote.name === run.agentName &&
  remote.agent === run.kind &&
  (run.terminalId === undefined || remote.terminalId === run.terminalId);

export const persistedRun = (run: HerdrAgentView): PersistedHerdrRun => ({
  id: run.id,
  kind: run.kind,
  ...(run.model === undefined ? {} : { model: run.model }),
  name: run.name,
  agentName: run.agentName,
  task: run.task,
  cwd: run.cwd,
  state: run.state,
  ...(run.remoteStatus === undefined ? {} : { remoteStatus: run.remoteStatus }),
  workspaceId: run.workspaceId,
  tabId: run.tabId,
  paneId: run.paneId,
  ...(run.terminalId ? { terminalId: run.terminalId } : {}),
  reportGeneration: run.reportGeneration,
  ...(run.report === undefined ? {} : { report: run.report }),
  ...(run.error === undefined ? {} : { error: run.error }),
  startedAt: run.startedAt,
  updatedAt: run.updatedAt,
  ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
});
