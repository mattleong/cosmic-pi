import { describe, expect, it } from "vitest";
import { matchingWorkspaces, selectWorkspace, splitTarget } from "../src/herd/coordination.ts";
import type { HerdrSnapshot } from "../src/herd/model.ts";

const snapshot = (focusedWorkspaceId?: string): HerdrSnapshot => ({
  version: "0.7.5",
  protocol: 17,
  ...(focusedWorkspaceId ? { focusedWorkspaceId } : {}),
  workspaces: [
    { workspaceId: "w1", label: "one", focused: false, activeTabId: "w1:t1" },
    { workspaceId: "w2", label: "two", focused: true, activeTabId: "w2:t1" },
  ],
  tabs: [],
  panes: [
    {
      paneId: "w1:p1",
      terminalId: "term-1",
      workspaceId: "w1",
      tabId: "w1:t1",
      cwd: "/repo",
      focused: false,
      agentStatus: "idle",
    },
    {
      paneId: "w2:p1",
      terminalId: "term-2",
      workspaceId: "w2",
      tabId: "w2:t1",
      cwd: "/repo",
      focused: true,
      agentStatus: "idle",
    },
  ],
  agents: [],
  layouts: [
    {
      workspaceId: "w2",
      tabId: "w2:t1",
      panes: [
        { paneId: "w2:p1", width: 50, height: 40 },
        { paneId: "w2:p2", width: 120, height: 20 },
      ],
    },
  ],
});

describe("Herdr coordination", () => {
  it("uses the focused matching workspace when Pi's cwd appears more than once", () => {
    const current = snapshot("w2");
    expect(matchingWorkspaces(current, "/repo").map((workspace) => workspace.workspaceId)).toEqual([
      "w1",
      "w2",
    ]);
    expect(selectWorkspace(current, "/repo")?.workspaceId).toBe("w2");
  });

  it("returns no workspace for an unresolved ambiguous match", () => {
    expect(selectWorkspace(snapshot(), "/repo")).toBeUndefined();
  });

  it("splits the largest pane using its aspect ratio", () => {
    expect(splitTarget(snapshot("w2"), "w2:t1", "w2:p1")).toEqual({
      paneId: "w2:p2",
      direction: "right",
    });
  });
});
