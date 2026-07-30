// Partial boundary fake intentionally implements only managed-tab migration.
// @effect-diagnostics effect/asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { HerdrClientShape } from "../src/boundary/herdr-client.ts";
import type { PersistedHerdrProject } from "../src/config/schema.ts";
import type { HerdrSnapshot } from "../src/herd/model.ts";
import { acquireManagedProject } from "../src/herd/workspace.ts";

const snapshot: HerdrSnapshot = {
  version: "0.7.5",
  protocol: 17,
  workspaces: [{ workspaceId: "w1", label: "repo", focused: true, activeTabId: "w1:t1" }],
  tabs: [
    {
      tabId: "w1:t1",
      workspaceId: "w1",
      label: "pi-herdr · Claude",
      paneCount: 1,
      focused: true,
    },
  ],
  panes: [
    {
      paneId: "w1:p1",
      terminalId: "term-1",
      workspaceId: "w1",
      tabId: "w1:t1",
      focused: true,
      agentStatus: "idle",
    },
  ],
  agents: [],
  layouts: [],
};

const persisted: PersistedHerdrProject = {
  key: "default\u0000/repo",
  session: "default",
  cwd: "/repo",
  workspaceId: "w1",
  workspaceOwned: false,
  tabId: "w1:t1",
  tabLabel: "pi-herdr · Claude",
  anchorPaneId: "w1:p1",
  runs: [],
};

describe("managed Herdr workspace", () => {
  it("renames only a fully revalidated legacy managed tab", async () => {
    const renames: Array<readonly [string, string]> = [];
    const client = {
      renameTab: (tabId: string, label: string) =>
        Effect.sync(() => {
          renames.push([tabId, label]);
        }),
    } as unknown as HerdrClientShape;
    const managed = await Effect.runPromise(
      acquireManagedProject({
        client,
        cwd: "/repo",
        workspaceLabel: "repo · pi-herdr",
        snapshot,
        persisted,
      }),
    );
    expect(renames).toEqual([["w1:t1", "pi-herdr · Agents"]]);
    expect(managed).toMatchObject({ tabId: "w1:t1", tabLabel: "pi-herdr · Agents" });
  });
});
