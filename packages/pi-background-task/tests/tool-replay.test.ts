// Pi rebuilds history before session_start; those same rows adopt the first activation.
import {
  createEventBus,
  initTheme,
  ToolExecutionComponent,
  type ExtensionContext,
  type ExtensionHandler,
  type SourceInfo,
  type ToolDefinition,
  type ToolInfo,
  type ToolRendererResolver,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { CodePreviewSettings } from "pi-code-previews";
import { applyPresentationSettings } from "pi-code-previews/testing";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  deferredPromise,
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
} from "pi-cosmic-core/testing";
import { afterEach, beforeAll, vi } from "vitest";
import { registerBackgroundTaskApplication } from "../src/application.ts";

type Handler = ExtensionHandler<any, any>;

beforeAll(() => initTheme("dark", false));

const restoreSettings = applyPresentationSettings({});
afterEach(() => {
  restoreSettings();
  vi.unstubAllEnvs();
});

const source: SourceInfo = {
  source: "local",
  path: "/extensions/pi-background-task/index.ts",
  scope: "user",
  origin: "top-level",
};
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

const draw = (row: ToolExecutionComponent, expanded = false) => {
  row.setExpanded(expanded);
  row.invalidate();
  return row.render(120).join("\n");
};
const frames = (row: ToolExecutionComponent) => [draw(row), draw(row, true)];

/** Actual factory callbacks over public metadata naming one source for command and tool. */
const host = (load: () => Promise<void>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const agentDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-background-replay-" });
    yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory));
    const handlers = new Map<string, Handler>();
    const commands = new Set<string>();
    const resolvers: ToolRendererResolver[] = [];
    const registered = new Map<string, ToolDefinition<any, any, any>>();
    registerBackgroundTaskApplication(
      extensionApiFixture({
        events: createEventBus(),
        on: (name: string, handler: Handler) => {
          handlers.set(name, handler);
        },
        registerCommand: (name: string) => {
          commands.add(name);
        },
        registerToolRenderer: (resolver: ToolRendererResolver) => {
          resolvers.push(resolver);
        },
        registerTool: (tool: ToolDefinition<any, any, any>) => {
          registered.set(tool.name, tool);
        },
        getActiveTools: () => [...registered.keys()],
        getAllTools: (): ToolInfo[] =>
          [...registered.values()].map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
            exposure: "direct",
            sourceInfo: source,
          })),
        getCommands: () =>
          [...commands].map((name) => ({
            name,
            description: name,
            source: "extension" as const,
            sourceInfo: source,
          })),
      }),
      { loadSettings: load },
    );
    // Pi consults resolvers, then the registered definition, which is absent before startup.
    const resolve = (name: string, index = 0): ToolRenderers | undefined =>
      index < resolvers.length
        ? resolvers[index]!(name, () => resolve(name, index + 1))
        : registered.get(name);
    const row = () => {
      const component = new ToolExecutionComponent(
        "background_task",
        "background-task-call",
        args,
        { showImages: false },
        resolve("background_task"),
        opaqueFixture({ requestRender() {} }),
        "/project",
      );
      component.updateResult({ content: [{ type: "text", text }], details, isError: false });
      return component;
    };
    const emit = (name: string, ctx: ExtensionContext) =>
      Promise.resolve(handlers.get(name)?.({}, ctx));
    return { registered, row, emit };
  });

layer(nodeFilePlatformLayer)("background task history replay", (it) => {
  for (const style of ["compact", "preview"] as const)
    for (const mode of ["on", "off", "border"] as const)
      it.effect(`history from before startup adopts the registered tool (${style}/${mode})`, () =>
        Effect.gen(function* () {
          const h = yield* host(
            loads({
              toolCallCollapsedStyle: style,
              toolCallBackground: mode,
              toolCallTiming: false,
            }),
          );
          const row = h.row();
          const cold = draw(row);
          yield* Effect.promise(() => h.emit("session_start", context()));
          expect([...h.registered.keys()]).toEqual(["background_task"]);
          expect(draw(row)).not.toBe(cold);
          // A row resolved after startup draws the registered tool's ordinary presentation.
          expect(frames(row)).toEqual(frames(h.row()));
          const expanded = draw(row, true);
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
        const cold = frames(row);
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
        expect(frames(row)).toEqual(cold);
        yield* Effect.promise(() => h.emit("session_shutdown", context()));
      }),
    );
});
