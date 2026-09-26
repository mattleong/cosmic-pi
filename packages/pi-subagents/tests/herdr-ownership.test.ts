import { describe, expect, it } from "vitest";
import {
  agentOwnershipEvidence,
  matchingAgentIdentity,
  matchingPaneIdentity,
  sameAgentOwnership,
  sameStartedAgent,
} from "../src/backend/herdr-ownership.ts";
import type { HerdrAgent, HerdrPane, HerdrSnapshot } from "../src/boundary/herdr-cli.ts";

const pane: HerdrPane = {
  paneId: "w:p1",
  terminalId: "term-1",
  workspaceId: "w",
  tabId: "w:t",
  cwd: "/project",
  foregroundCwd: "/project",
  agentStatus: "working",
};

const agent: HerdrAgent = {
  ...pane,
  name: "psa-pi-review",
  runtime: "pi",
  stateChangeSequence: 1,
  interactiveReady: true,
  agentSession: { source: "fixture", agent: "pi", kind: "id", value: "native-1" },
};

const snapshot = (panes: ReadonlyArray<HerdrPane>, agents: ReadonlyArray<HerdrAgent>) =>
  ({
    protocol: 20,
    workspaces: [{ workspaceId: "w" }],
    tabs: [{ tabId: "w:t", workspaceId: "w" }],
    panes,
    agents,
  }) satisfies HerdrSnapshot;

describe("Herdr ownership classifiers", () => {
  it("requires globally unique pane and terminal selectors", () => {
    expect(matchingPaneIdentity(pane, snapshot([pane], []))).toEqual(pane);
    expect(
      matchingPaneIdentity(
        pane,
        snapshot(
          [pane, { ...pane, paneId: "other:p", workspaceId: "other:w", tabId: "other:t" }],
          [],
        ),
      ),
    ).toBeUndefined();
  });

  it("requires one exact agent name/session identity and validates atomic start evidence", () => {
    const identity = agentOwnershipEvidence(agent)!;
    expect(sameAgentOwnership(identity, agent)).toBe(true);
    expect(sameStartedAgent(pane, agent.name!, "pi", "/project", agent)).toBe(true);
    expect(matchingAgentIdentity(identity, agent.name!, snapshot([pane], [agent]))).toEqual(agent);

    const escaped = {
      ...agent,
      paneId: "escaped:p",
      terminalId: "escaped:t",
      workspaceId: "escaped:w",
      tabId: "escaped:t",
    };
    expect(
      matchingAgentIdentity(identity, agent.name!, snapshot([pane], [agent, escaped])),
    ).toBeUndefined();
  });
});
