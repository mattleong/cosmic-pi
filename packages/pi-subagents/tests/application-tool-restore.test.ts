import { tmpdir } from "node:os";
import * as Effect from "effect/Effect";
import {
  recordingExtensionHost,
  type DefaultedEventName,
  type ExtensionEventNamed,
} from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import { sessionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, settle } from "./support/effect-test.ts";
import { nodePath } from "./support/node-builtins.ts";
import * as Arr from "effect/Array";

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
        if (Arr.some(active, (name) => !names.includes(name))) restoring.clear();
        active = Arr.filter(names, (name) => registered.has(name));
      }),
    },
  };
};

const restoringApplication = (pending: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const loadout = piToolLoadout(pending);
    const host = recordingExtensionHost({}, loadout.overrides);
    registerSubagentApplication(host.pi, {
      getAgentDirectory: () => nodePath.join(tmpdir(), "pi-subagents-tool-restore-tests"),
      loadSettings: () => Promise.resolve(),
    });
    const ctx = sessionContextFixture({ isProjectTrusted: () => false }, "tool-restore-session");
    const emit = <Name extends DefaultedEventName>(name: Name, event?: ExtensionEventNamed<Name>) =>
      settle(() => host.emit(name, ctx, event));
    yield* Effect.addFinalizer(() =>
      emit("session_shutdown", { type: "session_shutdown", reason: "quit" }),
    );
    return { loadout, emit };
  });

describe("subagent tool activation", () => {
  effectTest(
    "keeps tools Pi is still restoring when subagent tools register after reload",
    function* () {
      const { loadout, emit } = yield* restoringApplication(["mcp__docs__search"]);
      yield* emit("session_start", { type: "session_start", reason: "reload" });
      expect(loadout.active()).toEqual(expect.arrayContaining(["read", "agent_start"]));
      expect(loadout.restoring.has("mcp__docs__search")).toBe(true);
    },
  );

  effectTest(
    "keeps tools Pi is still restoring when the old instance shuts down for reload",
    function* () {
      const { loadout, emit } = yield* restoringApplication([]);
      yield* emit("session_start", { type: "session_start", reason: "startup" });
      loadout.restoring.add("mcp__docs__search");
      yield* emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
      expect(loadout.restoring.has("mcp__docs__search")).toBe(true);
    },
  );
});
