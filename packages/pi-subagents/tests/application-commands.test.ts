import * as Effect from "effect/Effect";
import { recordingExtensionHost, temporaryDirectory } from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import { sessionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, settle, step } from "./support/effect-test.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";

/** A registered application over its own agent directory and project, and its `/subagents` command. */
const commandFixture = Effect.fnUntraced(function* (isProjectTrusted: () => boolean) {
  const agentDirectory = yield* temporaryDirectory("pi-subagents-commands-agent-");
  const cwd = yield* temporaryDirectory("pi-subagents-commands-project-");
  const host = recordingExtensionHost();
  registerSubagentApplication(host.pi, {
    getAgentDirectory: () => agentDirectory,
    loadSettings: () => Promise.resolve(),
  });
  const notify = vi.fn();
  const ctx = sessionContextFixture({ cwd, ui: { notify }, isProjectTrusted });
  return {
    agentDirectory,
    notify,
    emit: (event: "session_start" | "session_tree" | "session_shutdown") =>
      settle(() => host.emit(event, ctx)),
    command: (args: string) =>
      step(
        () =>
          host.commands.get("subagents")?.handler(args, ctx) ??
          Promise.reject(new Error("Missing /subagents command")),
      ),
  };
});

describe("application settings commands", () => {
  effectTest(
    "a writer workspace change treats an unreadable trust check as an untrusted project",
    function* () {
      let trustReadable = true;
      const { agentDirectory, notify, emit, command } = yield* commandFixture(() => {
        if (!trustReadable) throw new Error("This extension ctx is stale.");
        return true;
      });
      yield* emit("session_start");
      trustReadable = false;
      yield* command("settings writerWorkspace worktree");
      const saved: unknown = JSON.parse(
        yield* step(() =>
          nodeFsPromises.readFile(nodePath.join(agentDirectory, "pi-subagents.json"), "utf8"),
        ),
      );
      expect(saved).toMatchObject({ writerWorkspaceMode: "worktree" });
      expect(notify).not.toHaveBeenCalledWith(expect.any(String), "error");
      yield* emit("session_shutdown");
    },
  );

  effectTest("a writer workspace change made mid-session survives /tree", function* () {
    const { notify, emit, command } = yield* commandFixture(() => false);
    yield* emit("session_start");
    yield* command("settings writerWorkspace worktree");
    // /tree keeps the session's base configuration instead of rereading it.
    yield* emit("session_tree");
    // Status and help both show the value in effect.
    for (const args of ["settings status", "settings help"]) {
      notify.mockClear();
      yield* command(args);
      expect(notify).toHaveBeenCalledWith(
        expect.stringMatching(/\(writerWorkspace\): Worktree/u),
        expect.anything(),
      );
    }
    yield* emit("session_shutdown");
  });
});
