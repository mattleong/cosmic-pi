// Promise assertions are test-runner boundaries.
import { tmpdir } from "node:os";
import * as Effect from "effect/Effect";
import { recordingExtensionHost } from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import { sessionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, settle } from "./support/effect-test.ts";
import { nodePath } from "./support/node-builtins.ts";

/**
 * Pi 1.0's tool loadout: registration activates a new tool unless it declares `defaultActive:
 * false`, a pending restore list activates restored tools when they register, and any call that
 * deactivates a tool drops that list.
 */
const piToolLoadout = (pending: ReadonlyArray<string>) => {
  let active: ReadonlyArray<string> = ["read"];
  const restoring = new Set(pending);
  const registered = new Set(["read"]);
  return {
    active: () => [...active],
    restoring,
    overrides: {
      registerTool: vi.fn((tool: { readonly name: string; readonly defaultActive?: boolean }) => {
        const fresh = !registered.has(tool.name) && tool.defaultActive !== false;
        registered.add(tool.name);
        if (restoring.delete(tool.name) || fresh) active = [...new Set([...active, tool.name])];
      }),
      getActiveTools: vi.fn(() => [...active]),
      setActiveTools: vi.fn((names: ReadonlyArray<string>) => {
        if (active.some((name) => !names.includes(name))) restoring.clear();
        active = names.filter((name) => registered.has(name));
      }),
    },
  };
};

/**
 * One registered subagents instance over a Pi loadout that starts with `pending` restoring; the
 * test's scope quits its session.
 */
const restoringApplication = (pending: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const loadout = piToolLoadout(pending);
    const host = recordingExtensionHost({}, loadout.overrides);
    registerSubagentApplication(host.pi, {
      getAgentDirectory: () => nodePath.join(tmpdir(), "pi-subagents-tool-restore-tests"),
      loadSettings: () => Promise.resolve(),
    });
    const ctx = sessionContextFixture({ isProjectTrusted: () => false }, "tool-restore-session");
    const emit = (name: string, event: { readonly reason?: string }) =>
      settle(() => host.emit(name, ctx, event));
    yield* Effect.addFinalizer(() => emit("session_shutdown", { reason: "quit" }));
    return { loadout, emit };
  });

describe("subagent tool activation", () => {
  effectTest(
    "keeps tools Pi is still restoring when subagent tools register after reload",
    function* () {
      const { loadout, emit } = yield* restoringApplication(["mcp__docs__search"]);
      yield* emit("session_start", { reason: "reload" });
      expect(loadout.active()).toEqual(expect.arrayContaining(["read", "subagent_start"]));
      // The workflow runner registers inactive while ultracode is off.
      expect(loadout.active()).not.toContain("subagent_workflow");
      // The MCP server reconnects later; its tool must still be restored then.
      expect(loadout.restoring.has("mcp__docs__search")).toBe(true);
    },
  );

  effectTest(
    "keeps tools Pi is still restoring when the old instance shuts down for reload",
    function* () {
      const { loadout, emit } = yield* restoringApplication([]);
      yield* emit("session_start", { reason: "startup" });
      loadout.restoring.add("mcp__docs__search");
      yield* emit("session_shutdown", { reason: "reload" });
      expect(loadout.restoring.has("mcp__docs__search")).toBe(true);
    },
  );

  effectTest(
    "leaves a restored workflow runner active until the next agent run starts",
    function* () {
      const { loadout, emit } = yield* restoringApplication([
        "subagent_workflow",
        "mcp__docs__search",
      ]);
      yield* emit("session_start", { reason: "reload" });
      // Removing it now would drop the MCP tool Pi is still restoring.
      expect(loadout.active()).toContain("subagent_workflow");
      expect(loadout.restoring.has("mcp__docs__search")).toBe(true);
      yield* emit("agent_start", {});
      expect(loadout.active()).not.toContain("subagent_workflow");
      expect(loadout.active()).toEqual(expect.arrayContaining(["read", "subagent_start"]));
    },
  );

  effectTest("keeps the restored branch loadout through tree navigation", function* () {
    const { loadout, emit } = yield* restoringApplication([]);
    yield* emit("session_start", { reason: "startup" });
    const registered = loadout.active();
    // Pi restores the target branch's loadout, then emits session_tree.
    loadout.restoring.add("mcp__docs__search");
    yield* emit("session_tree", {});
    expect(loadout.restoring.has("mcp__docs__search")).toBe(true);
    expect(loadout.active()).toEqual(registered);
  });
});
