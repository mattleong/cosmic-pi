// Pi rebuilds history before session_start; those same rows adopt the first activation.
import { createEventBus, initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { CodePreviewSettings } from "pi-code-previews";
import {
  applyPresentationSettings,
  drawToolRow,
  hostToolRow,
  toolRowFrames,
} from "pi-code-previews/testing";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  deferredPromise,
  extensionContextFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { afterEach, beforeAll, vi } from "vitest";
import { registerBackgroundTaskApplication } from "../src/application.ts";

beforeAll(() => initTheme("dark", false));

const restoreSettings = applyPresentationSettings({});
afterEach(() => {
  restoreSettings();
  vi.unstubAllEnvs();
});

const args = { action: "status", id: "task-1" };
const text = "task-1 failed (exit 2)\ncause: FULL_CAUSE recovery /tmp/task-1.log";
const details = {
  action: "status",
  snapshot: {
    id: "task-1",
    name: "replay-task",
    command: "run",
    cwd: "/task-working-directory",
    pid: 87654,
    state: "failed",
    exitCode: 2,
    startedAt: 1,
    endedAt: 2,
    logCursor: 10,
    droppedLogBytes: 0,
  },
};

const context = (signal?: AbortSignal) =>
  extensionContextFixture({
    cwd: process.cwd(),
    signal,
    isProjectTrusted: () => false,
    hasUI: false,
    mode: "rpc",
  });

/** Trusted settings load in startup, before activation wraps the tool. */
const loads = (settings: Partial<CodePreviewSettings>) => () => {
  applyPresentationSettings(settings);
  return Promise.resolve();
};

/** Actual factory callbacks over public metadata naming one source for command and tool. */
const host = (load: () => Promise<void>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const agentDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-background-replay-" });
    yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory));
    const host = recordingExtensionHost({}, { events: createEventBus() });
    registerBackgroundTaskApplication(host.pi, { loadSettings: load });
    const row = () =>
      hostToolRow("background_task", args, host.resolve("background_task"), {
        id: "background-task-call",
        result: { content: [{ type: "text", text }], details, isError: false },
      });
    return {
      registered: host.tools,
      row,
      emit: (name: string, ctx: ExtensionContext) => host.emit(name, ctx),
    };
  });

layer(nodeFilePlatformLayer)("background task history replay", (it) => {
  // Code Previews proves every appearance; this proves the task tool adopts one.
  it.effect("history from before startup adopts the registered tool", () =>
    Effect.gen(function* () {
      const h = yield* host(
        loads({
          toolCallCollapsedStyle: "compact",
          toolCallBackground: "border",
          toolCallTiming: false,
        }),
      );
      const row = h.row();
      const cold = drawToolRow(row);
      yield* Effect.promise(() => h.emit("session_start", context()));
      expect([...h.registered.keys()]).toEqual(["background_task"]);
      expect(drawToolRow(row)).not.toBe(cold);
      // A row resolved after startup draws the registered tool's ordinary presentation.
      expect(toolRowFrames(row)).toEqual(toolRowFrames(h.row()));
      const expanded = drawToolRow(row, true);
      for (const line of text.split("\n")) expect(expanded).toContain(line);
      expect(expanded).toContain("task-1");
      yield* Effect.promise(() => h.emit("session_shutdown", context()));
    }),
  );

  for (const failure of ["aborted", "tree replacement"] as const)
    it.effect(`history stays raw after ${failure} closes the first startup`, () =>
      Effect.gen(function* () {
        const entered = deferredPromise();
        let calls = 0;
        const h = yield* host(() => {
          if (++calls > 1 || failure === "aborted") return Promise.resolve();
          entered.resolve();
          return Promise.race([]);
        });
        const row = h.row();
        const cold = toolRowFrames(row);
        if (failure === "aborted")
          yield* Effect.promise(() => h.emit("session_start", context(AbortSignal.abort())));
        else {
          // Tree navigation interrupts the first startup while trusted settings still load.
          const first = h.emit("session_start", context());
          yield* Effect.promise(() => entered.promise);
          yield* Effect.promise(() => h.emit("session_tree", context()));
          yield* Effect.promise(() => first);
        }
        // Later activations register normally but cannot publish into closed history.
        yield* Effect.promise(() => h.emit("session_tree", context()));
        yield* Effect.promise(() => h.emit("session_start", context()));
        expect(h.registered.has("background_task")).toBe(true);
        expect(toolRowFrames(row)).toEqual(cold);
        yield* Effect.promise(() => h.emit("session_shutdown", context()));
      }),
    );
});
