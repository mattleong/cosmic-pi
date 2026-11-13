import { initTheme } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { CodePreviewSettings } from "pi-code-previews";
import {
  applyPresentationSettings,
  drawToolRow,
  hostToolRow,
  toolRowFrames,
} from "pi-code-previews/testing";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { deferredPromise } from "pi-cosmic-core/testing";
import { afterEach, beforeAll, vi } from "vitest";
import { applicationHost, sessionContext } from "./support/application-host.ts";
import { taskStatus } from "./support/task-service-double.ts";

beforeAll(() => initTheme("dark", false));

const restoreSettings = applyPresentationSettings({});
afterEach(() => {
  restoreSettings();
  vi.unstubAllEnvs();
});

const args = { action: "status", id: "task-0000000001" };
const text = "task-0000000001 failed (exit 2)\ncause: FULL_CAUSE recovery /tmp/task-0000000001.log";
const details = {
  action: "status",
  snapshot: taskStatus({
    id: "task-0000000001",
    name: "replay-task",
    command: "run",
    cwd: "/task-working-directory",
    pid: 87654,
    state: "failed",
    exitCode: 2,
    endedAt: 2,
    logCursor: 10,
  }),
};

const context = (signal?: AbortSignal) => sessionContext({ signal });

const loads = (settings: Partial<CodePreviewSettings>) => () => {
  applyPresentationSettings(settings);
  return Promise.resolve();
};

const host = (load: () => Promise<void>) =>
  Effect.map(applicationHost(load), (app) => ({
    ...app,
    row: () =>
      hostToolRow("background_task", args, app.resolve("background_task"), {
        id: "background-task-call",
        result: { content: [{ type: "text", text }], details, isError: false },
      }),
  }));

layer(nodeFilePlatformLayer)("background task history replay", (it) => {
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
      expect(toolRowFrames(row)).toEqual(toolRowFrames(h.row()));
      const expanded = drawToolRow(row, true);
      // The registered renderer shows the task's facts from its details.
      expect(expanded).toContain("task-0000000001");
      expect(expanded).toContain(details.snapshot.cwd);
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
          const first = h.emit("session_start", context());
          yield* Effect.promise(() => entered.promise);
          yield* Effect.promise(() => h.emit("session_tree", context()));
          yield* Effect.promise(() => first);
        }
        yield* Effect.promise(() => h.emit("session_tree", context()));
        yield* Effect.promise(() => h.emit("session_start", context()));
        expect(h.registered.has("background_task")).toBe(true);
        expect(toolRowFrames(row)).toEqual(cold);
        yield* Effect.promise(() => h.emit("session_shutdown", context()));
      }),
    );
});
