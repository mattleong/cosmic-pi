import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeAgents, decodeSnapshot } from "../src/herd/protocol.ts";

const pane = {
  pane_id: "w1:p1",
  terminal_id: "term-1",
  workspace_id: "w1",
  tab_id: "w1:t1",
  cwd: "/repo",
  foreground_cwd: "/repo",
  label: null,
  focused: true,
  agent_status: "idle",
};

const agent = {
  ...pane,
  name: "pih-test",
  agent: "claude",
  state_change_seq: 4,
  interactive_ready: true,
};

describe("Herdr protocol", () => {
  it.effect("decodes the protocol-17 session snapshot", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeSnapshot({
        id: "snapshot",
        result: {
          type: "session_snapshot",
          snapshot: {
            version: "0.7.5",
            protocol: 17,
            focused_workspace_id: "w1",
            focused_tab_id: "w1:t1",
            focused_pane_id: "w1:p1",
            workspaces: [
              {
                workspace_id: "w1",
                label: "repo",
                focused: true,
                active_tab_id: "w1:t1",
                worktree: null,
              },
            ],
            tabs: [
              {
                tab_id: "w1:t1",
                workspace_id: "w1",
                label: "pi-herdr · Claude",
                pane_count: 1,
                focused: true,
              },
            ],
            panes: [pane],
            agents: [agent],
            layouts: [
              {
                workspace_id: "w1",
                tab_id: "w1:t1",
                panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 40 } }],
              },
            ],
          },
        },
      });
      expect(decoded.protocol).toBe(17);
      expect(decoded.focusedWorkspaceId).toBe("w1");
      expect(decoded.focusedTabId).toBe("w1:t1");
      expect(decoded.focusedPaneId).toBe("w1:p1");
      expect(decoded.agents[0]).toMatchObject({
        name: "pih-test",
        agent: "claude",
        paneId: "w1:p1",
        stateChangeSeq: 4,
      });
    }),
  );

  it.effect("preserves Pi and Codex agent kinds for ownership matching", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeAgents({
        id: "list",
        result: {
          type: "agent_list",
          agents: [
            { ...agent, name: "pi-agent", agent: "pi" },
            { ...agent, pane_id: "w1:p2", name: "codex-agent", agent: "codex" },
          ],
        },
      });
      expect(decoded.map((value) => value.agent)).toEqual(["pi", "codex"]);
    }),
  );

  it.effect("maps forward-compatible remote statuses to unknown", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeAgents({
        id: "list",
        result: { type: "agent_list", agents: [{ ...agent, agent_status: "future_state" }] },
      });
      expect(decoded[0]?.agentStatus).toBe("unknown");
    }),
  );

  it.effect("turns Herdr error envelopes into typed command failures", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeAgents({
          id: "list",
          error: { code: "agent_not_found", message: "agent not found" },
        }),
      );
      expect(error).toMatchObject({
        _tag: "HerdrCommandError",
        code: "agent_not_found",
        message: "agent not found",
      });
    }),
  );
});
