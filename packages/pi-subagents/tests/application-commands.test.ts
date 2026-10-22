import { tmpdir } from "node:os";
import * as Effect from "effect/Effect";
import { recordingExtensionHost } from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import { sessionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, settle, step } from "./support/effect-test.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";

const temporaryDirectory = function* (prefix: string) {
  const directory = yield* step(() => nodeFsPromises.mkdtemp(nodePath.join(tmpdir(), prefix)));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => nodeFsPromises.rm(directory, { recursive: true, force: true })),
  );
  return directory;
};

describe("application settings commands", () => {
  effectTest(
    "a writer workspace change treats an unreadable trust check as an untrusted project",
    function* () {
      const agentDirectory = yield* temporaryDirectory("pi-subagents-commands-agent-");
      const cwd = yield* temporaryDirectory("pi-subagents-commands-project-");
      const host = recordingExtensionHost();
      registerSubagentApplication(host.pi, {
        getAgentDirectory: () => agentDirectory,
        loadSettings: () => Promise.resolve(),
      });
      let trustReadable = true;
      const notify = vi.fn();
      const ctx = sessionContextFixture({
        cwd,
        ui: { notify },
        isProjectTrusted: () => {
          if (!trustReadable) throw new Error("This extension ctx is stale.");
          return true;
        },
      });
      yield* settle(() => host.emit("session_start", ctx));
      trustReadable = false;
      yield* step(
        () =>
          host.commands.get("subagents")?.handler("settings writerWorkspace worktree", ctx) ??
          Promise.reject(new Error("Missing /subagents command")),
      );
      const saved: unknown = JSON.parse(
        yield* step(() =>
          nodeFsPromises.readFile(nodePath.join(agentDirectory, "pi-subagents.json"), "utf8"),
        ),
      );
      expect(saved).toMatchObject({ writerWorkspaceMode: "worktree" });
      expect(notify).not.toHaveBeenCalledWith(expect.any(String), "error");
      yield* settle(() => host.emit("session_shutdown", ctx));
    },
  );

  effectTest("a writer workspace change made mid-session survives /tree", function* () {
    const agentDirectory = yield* temporaryDirectory("pi-subagents-commands-agent-");
    const cwd = yield* temporaryDirectory("pi-subagents-commands-project-");
    const host = recordingExtensionHost();
    registerSubagentApplication(host.pi, {
      getAgentDirectory: () => agentDirectory,
      loadSettings: () => Promise.resolve(),
    });
    const notify = vi.fn();
    const ctx = sessionContextFixture({ cwd, ui: { notify }, isProjectTrusted: () => false });
    const command = (args: string) =>
      step(
        () =>
          host.commands.get("subagents")?.handler(args, ctx) ??
          Promise.reject(new Error("Missing /subagents command")),
      );
    yield* settle(() => host.emit("session_start", ctx));
    yield* command("settings writerWorkspace worktree");
    // /tree keeps the session's base configuration instead of rereading it.
    yield* settle(() => host.emit("session_tree", ctx));
    notify.mockClear();
    yield* command("settings status");
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/writerWorkspace\W+worktree\b/u),
      expect.anything(),
    );
    yield* settle(() => host.emit("session_shutdown", ctx));
  });
});
