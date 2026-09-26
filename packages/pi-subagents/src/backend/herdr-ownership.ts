import type {
  HerdrAgent,
  HerdrAgentSession,
  HerdrPane,
  HerdrSnapshot,
} from "../boundary/herdr-cli.ts";
import type { SubagentRuntime } from "../domain/routing.ts";

export interface HerdrAgentOwnershipEvidence {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly name: string;
  readonly runtime: string;
  readonly agentSession: HerdrAgentSession;
  readonly cwd?: string | undefined;
  readonly foregroundCwd?: string | undefined;
}

export const agentOwnershipEvidence = (
  agent: HerdrAgent,
): HerdrAgentOwnershipEvidence | undefined =>
  agent.name && agent.runtime && agent.agentSession
    ? {
        workspaceId: agent.workspaceId,
        tabId: agent.tabId,
        paneId: agent.paneId,
        terminalId: agent.terminalId,
        name: agent.name,
        runtime: agent.runtime,
        agentSession: { ...agent.agentSession },
        ...(agent.cwd !== undefined && { cwd: agent.cwd }),
        ...(agent.foregroundCwd !== undefined && { foregroundCwd: agent.foregroundCwd }),
      }
    : undefined;

export const sameStartedAgent = (
  pane: HerdrPane,
  agentName: string,
  runtime: SubagentRuntime,
  cwd: string,
  agent: HerdrAgent,
): boolean =>
  agent.paneId === pane.paneId &&
  agent.terminalId === pane.terminalId &&
  agent.workspaceId === pane.workspaceId &&
  agent.tabId === pane.tabId &&
  agent.name === agentName &&
  agent.runtime === runtime &&
  (agent.cwd === cwd || agent.foregroundCwd === cwd) &&
  (agent.agentSession === undefined || agent.agentSession.agent === runtime);

export const sameAgentSession = (
  expected: HerdrAgentSession,
  actual: HerdrAgentSession | undefined,
): boolean =>
  actual !== undefined &&
  actual.source === expected.source &&
  actual.agent === expected.agent &&
  actual.kind === expected.kind &&
  actual.value === expected.value;

/** One comparator is used for prompt, inspect, rollback, and close ownership decisions. */
export const sameAgentOwnership = (
  expected: HerdrAgentOwnershipEvidence,
  agent: HerdrAgent,
): boolean => {
  const actual = agentOwnershipEvidence(agent);
  return (
    actual !== undefined &&
    actual.workspaceId === expected.workspaceId &&
    actual.tabId === expected.tabId &&
    actual.paneId === expected.paneId &&
    actual.terminalId === expected.terminalId &&
    actual.name === expected.name &&
    actual.runtime === expected.runtime &&
    actual.cwd === expected.cwd &&
    actual.foregroundCwd === expected.foregroundCwd &&
    sameAgentSession(expected.agentSession, actual.agentSession)
  );
};

export const matchingPaneIdentity = (
  expected: Pick<HerdrPane, "paneId" | "terminalId" | "workspaceId" | "tabId">,
  snapshot: HerdrSnapshot,
): HerdrPane | undefined => {
  const exact = snapshot.panes.filter(
    (pane) =>
      pane.paneId === expected.paneId &&
      pane.terminalId === expected.terminalId &&
      pane.workspaceId === expected.workspaceId &&
      pane.tabId === expected.tabId,
  );
  const paneIds = snapshot.panes.filter((pane) => pane.paneId === expected.paneId);
  const terminalIds = snapshot.panes.filter((pane) => pane.terminalId === expected.terminalId);
  return exact.length === 1 && paneIds.length === 1 && terminalIds.length === 1
    ? exact[0]
    : undefined;
};

/** The exact unique pane, provided its workspace and tab are also unique and consistent. */
export const exactPaneContext = (
  expected: Pick<HerdrPane, "paneId" | "terminalId" | "workspaceId" | "tabId">,
  snapshot: HerdrSnapshot,
): HerdrPane | undefined => {
  const pane = matchingPaneIdentity(expected, snapshot);
  if (!pane) return undefined;
  const workspaces = snapshot.workspaces.filter(
    (candidate) => candidate.workspaceId === expected.workspaceId,
  );
  const tabs = snapshot.tabs.filter((candidate) => candidate.tabId === expected.tabId);
  return workspaces.length === 1 &&
    tabs.length === 1 &&
    tabs[0]?.workspaceId === expected.workspaceId
    ? pane
    : undefined;
};

export const matchingAgentIdentity = (
  expected: HerdrAgentOwnershipEvidence,
  agentName: string,
  snapshot: HerdrSnapshot,
): HerdrAgent | undefined => {
  if (!matchingPaneIdentity(expected, snapshot)) return undefined;
  const selectors = snapshot.agents.filter(
    (agent) =>
      agent.paneId === expected.paneId ||
      agent.terminalId === expected.terminalId ||
      agent.name === agentName ||
      sameAgentSession(expected.agentSession, agent.agentSession),
  );
  return selectors.length === 1 && sameAgentOwnership(expected, selectors[0]!)
    ? selectors[0]
    : undefined;
};
