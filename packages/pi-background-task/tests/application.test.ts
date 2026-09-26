// Promise assertions characterize the Pi lifecycle boundary.
import { tmpdir } from "node:os";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  deferredPromise,
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
} from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { vi } from "vitest";
import {
  BACKGROUND_TASK_CODE_MODE_BOUNDS,
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  normalizeBackgroundTaskCodeModeCapability,
  type BackgroundTaskCodeModeCapability,
  type BackgroundTaskCodeModeInput,
} from "../src/code-mode/protocol.ts";
import {
  registerBackgroundTaskApplication,
  type BackgroundTaskApplicationBoundaries,
} from "../src/application.ts";
import type { BackgroundTaskProjectionBridge } from "../src/boundary/host-ui.ts";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "../src/config/schema.ts";
import {
  registerTaskManagerCommand,
  type TaskManagerCommandActions,
} from "../src/settings/controller.ts";
import type { BackgroundTaskState, BackgroundTaskView } from "../src/task/model.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";

type Handler = ExtensionHandler<any, any>;
type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

const nodeFs = process.getBuiltinModule("node:fs");
const nodePath = process.getBuiltinModule("node:path");
if (!nodeFs || !nodePath) throw new Error("Node fs/path builtins are unavailable.");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = nodeFs;
const { join } = nodePath;
const processEnv: NodeJS.ProcessEnv = process.env;

interface CapturedBackgroundTool {
  readonly name: string;
  readonly execute: (
    id: string,
    input: BackgroundTaskToolInput,
    signal: AbortSignal,
    onUpdate: undefined,
    context: ExtensionContext,
  ) => Promise<object>;
}

const context = (cwd: string) =>
  extensionContextFixture({
    cwd,
    signal: undefined,
    isProjectTrusted: () => false,
    hasUI: false,
    mode: "rpc",
  });

const harness = (loadSettings: BackgroundTaskApplicationBoundaries["loadSettings"]) => {
  const handlers = new Map<string, Handler>();
  const events = createEventBus();
  let command: RegisteredCommand | undefined;
  const tools: CapturedBackgroundTool[] = [];
  const activeTools: string[] = [];
  const registerTool = vi.fn((tool: CapturedBackgroundTool) => {
    tools.push(tool);
    if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
  });
  const fixture = {
    events,
    registerCommand: vi.fn((_name: string, definition: RegisteredCommand) => {
      command = definition;
    }),
    registerTool,
    getActiveTools: () => [...activeTools],
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  };
  registerBackgroundTaskApplication(extensionApiFixture(fixture), { loadSettings });
  return {
    tools,
    registerTool,
    events,
    activeTools,
    emit: (name: "session_start" | "turn_end" | "session_shutdown", ctx: ExtensionContext) =>
      Promise.resolve(handlers.get(name)?.({}, ctx)),
    runCommand: (args: string, ctx: ExtensionCommandContext) => {
      if (!command) return Promise.reject(new Error("task command was not registered"));
      return Promise.resolve(command.handler(args, ctx));
    },
  };
};

const managerTask = (state: BackgroundTaskState): BackgroundTaskView => {
  const activeOrSettled = {
    id: "manager-task",
    name: "manager-task",
    command: "manager-command",
    cwd: "/tmp",
    state,
    startedAt: 0,
    logCursor: 0,
    droppedLogBytes: 0,
    logs: [],
  };
  return state === "running" ? activeOrSettled : { ...activeOrSettled, endedAt: 1 };
};

function tasksCommandHarness(
  state: BackgroundTaskState = "exited",
  actions: Partial<TaskManagerCommandActions> = {},
) {
  let command: RegisteredCommand | undefined;
  const host = fakeCustomSurfaceHost({
    rows: 8,
    keybindings: opaqueFixture({ matches: () => false }),
  });
  const notify = vi.fn();
  const ui = { notify, custom: host.ctx.ui.custom };
  const custom = vi.spyOn(ui, "custom");
  const ctx = extensionContextFixture({
    cwd: "/tmp",
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui,
  });
  const pi = extensionApiFixture({
    registerCommand: (_name: string, definition: RegisteredCommand) => {
      command = definition;
    },
  });
  const bridge: BackgroundTaskProjectionBridge = opaqueFixture({
    get: () => ({ tasks: [managerTask(state)] }),
    subscribe: () => () => {},
  });
  registerTaskManagerCommand(pi, bridge, {
    stop: () => Promise.resolve(),
    clear: () => Promise.resolve(),
    status: () => Promise.resolve(DEFAULT_BACKGROUND_TASK_CONFIG),
    ...actions,
  });
  if (!command) throw new Error("task command was not registered");
  const registered = command;
  const run = (args: string) => Promise.resolve(registered.handler(args, ctx));
  return {
    custom,
    notify,
    run,
    host,
    open: (args = "") => {
      const opened = run(args);
      host.mount();
      const openedSurface = host.overlays.at(-1);
      if (!openedSurface) throw new Error("task manager surface did not mount");
      return {
        surface: openedSurface,
        isOpen: () => host.doneCalls === 0,
        close: Effect.gen(function* () {
          openedSurface.handleInput?.("\x1b");
          yield* Effect.promise(() => opened);
        }),
      };
    },
  };
}

describe("background-task Pi lifecycle", () => {
  it.effect("skips superseded settings loads so only the latest generation activates", () =>
    Effect.gen(function* () {
      const settings = deferredPromise();
      const loads: Array<readonly [string, boolean]> = [];
      const app = harness((cwd, trusted) => {
        loads.push([cwd, trusted]);
        return settings.promise;
      });

      const firstStart = app.emit("session_start", context(`${process.cwd()}/first`));
      const secondContext = context(`${process.cwd()}/second`);
      const secondStart = app.emit("session_start", secondContext);

      settings.resolve();
      yield* Effect.promise(() => Promise.all([firstStart, secondStart]));
      expect(app.tools.map((tool) => tool.name)).toEqual(["background_task"]);
      // The superseded first start never reaches the settings boundary.
      expect(loads).toEqual([[`${process.cwd()}/second`, false]]);
      yield* Effect.promise(() => app.emit("session_shutdown", secondContext));
    }),
  );

  it.effect("interrupts a never-settling settings load on replacement", () =>
    Effect.gen(function* () {
      const firstCwd = `${process.cwd()}/first-pending`;
      const secondCwd = `${process.cwd()}/second-ready`;
      const entered = deferredPromise();
      let firstSignal: AbortSignal | undefined;
      const app = harness((cwd, _trusted, signal) => {
        if (cwd !== firstCwd) return Promise.resolve();
        firstSignal = signal;
        entered.resolve();
        return Promise.race([]);
      });

      const firstStart = app.emit("session_start", context(firstCwd));
      yield* Effect.promise(() => entered.promise);
      const secondContext = context(secondCwd);
      const secondStart = app.emit("session_start", secondContext);
      yield* Effect.promise(() => Promise.all([firstStart, secondStart]));

      expect(firstSignal?.aborted).toBe(true);
      expect(app.tools.map((tool) => tool.name)).toEqual(["background_task"]);
      yield* Effect.promise(() => app.emit("session_shutdown", secondContext));
    }),
  );

  it.effect("reports the active generation's normalized config without rereading it", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const agentDirectory = mkdtempSync(join(tmpdir(), "pi-background-task-agent-"));
          const cwd = mkdtempSync(join(tmpdir(), "pi-background-task-project-"));
          const configDirectory = join(cwd, ".pi", "extensions");
          const configPath = join(configDirectory, "pi-background-task.json");
          const previousAgentDirectory = processEnv.PI_CODING_AGENT_DIR;
          mkdirSync(configDirectory, { recursive: true });
          writeFileSync(configPath, '{"maxRunning":100,"maxWaitSeconds":300}');
          processEnv.PI_CODING_AGENT_DIR = agentDirectory;
          return { agentDirectory, configPath, cwd, previousAgentDirectory };
        }),
        (current) =>
          Effect.sync(() => {
            if (current.previousAgentDirectory === undefined) delete processEnv.PI_CODING_AGENT_DIR;
            else processEnv.PI_CODING_AGENT_DIR = current.previousAgentDirectory;
            rmSync(current.agentDirectory, { recursive: true, force: true });
            rmSync(current.cwd, { recursive: true, force: true });
          }),
      );
      const app = harness(() => Promise.resolve());
      const notify = vi.fn();
      const ctx = extensionContextFixture({
        cwd: fixture.cwd,
        signal: undefined,
        isProjectTrusted: () => true,
        hasUI: true,
        mode: "rpc",
        ui: { notify },
      });

      yield* Effect.gen(function* () {
        yield* Effect.promise(() => app.emit("session_start", ctx));
        writeFileSync(fixture.configPath, '{"maxRunning":2,"maxWaitSeconds":4}');

        yield* Effect.promise(() => app.runCommand("status", ctx));
        const firstMessage = notify.mock.calls[0]?.[0];
        expect(firstMessage).toEqual(expect.stringContaining("maxRunning: 64"));
        expect(firstMessage).toEqual(expect.stringContaining("maxWaitSeconds: 120"));

        notify.mockClear();
        yield* Effect.promise(() => app.emit("session_start", ctx));
        yield* Effect.promise(() => app.runCommand("status", ctx));
        const replacementMessage = notify.mock.calls[0]?.[0];
        expect(replacementMessage).toEqual(expect.stringContaining("maxRunning: 2"));
        expect(replacementMessage).toEqual(expect.stringContaining("maxWaitSeconds: 4"));
      }).pipe(Effect.ensuring(Effect.promise(() => app.emit("session_shutdown", ctx))));
    }).pipe(Effect.scoped),
  );

  it.effect("ignores turn_end while the runtime slot is inactive", () =>
    Effect.gen(function* () {
      const settings = deferredPromise();
      const setStatus = vi.fn();
      const app = harness(() => settings.promise);
      const ctx: ExtensionContext = {
        ...context(process.cwd()),
        hasUI: true,
        mode: "tui",
        ui: opaqueFixture({ setStatus }),
      };

      const starting = app.emit("session_start", ctx);
      yield* Effect.promise(() => app.emit("turn_end", ctx));
      expect(setStatus).not.toHaveBeenCalled();

      settings.resolve();
      yield* Effect.promise(() => starting);
      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
    }),
  );

  it.effect("rejects a stale tool call typed while replacement settings are still loading", () =>
    Effect.gen(function* () {
      const entered = deferredPromise();
      const replacement = deferredPromise();
      let loadCount = 0;
      const app = harness(() => {
        if (++loadCount === 1) return Promise.resolve();
        entered.resolve();
        return replacement.promise;
      });
      const ctx = context(process.cwd());
      yield* Effect.promise(() => app.emit("session_start", ctx));
      const tool = app.tools[0];
      if (!tool) throw new Error("background tool registration was not captured");

      const replacing = app.emit("session_start", ctx);
      // The replacement loader has signalled entry and stays blocked: the prior runtime is
      // already deactivated and the next one is not yet active, so the activation-1 tool
      // must fail typed instead of reaching the unactivated replacement runtime.
      yield* Effect.promise(() => entered.promise);
      yield* Effect.promise(() =>
        expect(
          tool.execute(
            "replacement-check",
            { action: "list" },
            new AbortController().signal,
            undefined,
            ctx,
          ),
        ).rejects.toMatchObject({ _tag: "PiSessionRuntimeError" }),
      );

      replacement.resolve();
      yield* Effect.promise(() => replacing);
      // Tool activation still happens once settings resolve for the replacement generation.
      expect(app.tools.map((tool) => tool.name)).toEqual(["background_task", "background_task"]);
      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
    }),
  );

  it.effect("invalidates pending settings preparation when the captured session aborts", () =>
    Effect.gen(function* () {
      const settings = deferredPromise();
      const app = harness(() => settings.promise);
      const controller = new AbortController();
      const ctx = { ...context(process.cwd()), signal: controller.signal };

      const starting = app.emit("session_start", ctx);
      controller.abort();
      settings.resolve();
      yield* Effect.promise(() => starting);

      expect(app.registerTool).not.toHaveBeenCalled();
      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
    }),
  );

  it.effect("publishes one current-session Code Mode capability and revokes it on shutdown", () =>
    Effect.gen(function* () {
      const app = harness(() => Promise.resolve());
      const ctx: ExtensionContext = {
        ...context(process.cwd()),
        sessionManager: opaqueFixture({
          getSessionId: () => "session-1",
          getSessionFile: () => undefined,
        }),
      };
      yield* Effect.promise(() => app.emit("session_start", ctx));

      expect(() =>
        app.events.emit(BACKGROUND_TASK_CODE_MODE_QUERY, {
          version: BACKGROUND_TASK_CODE_MODE_VERSION,
          sessionId: "session-1",
          respond: () => Promise.reject(new Error("contained response rejection")),
        }),
      ).not.toThrow();

      const discover = (sessionId: string) => {
        const found: BackgroundTaskCodeModeCapability[] = [];
        app.events.emit(BACKGROUND_TASK_CODE_MODE_QUERY, {
          version: BACKGROUND_TASK_CODE_MODE_VERSION,
          sessionId,
          respond: <Candidate>(candidate: Candidate) => {
            const capability = normalizeBackgroundTaskCodeModeCapability(candidate);
            if (capability) found.push(capability);
          },
        });
        return found;
      };
      expect(discover("other-session")).toEqual([]);
      const discovered = discover("session-1");
      expect(discovered).toHaveLength(1);
      const capability = discovered[0]!;
      const nested = (input: BackgroundTaskCodeModeInput, maxOutputBytes = 4_096) =>
        capability.execute("nested", input, new AbortController().signal, maxOutputBytes);
      const topLevel = (input: BackgroundTaskToolInput) =>
        app.tools[0]!.execute("top-level", input, new AbortController().signal, undefined, ctx);

      const command = 'node -e "setTimeout(() => {}, 10000)"';
      const { maxIdChars, maxPathChars } = BACKGROUND_TASK_CODE_MODE_BOUNDS;
      const rejectedStarts: ReadonlyArray<readonly [BackgroundTaskCodeModeInput, number]> = [
        [{ action: "start", command }, 0],
        [{ action: "start", command, cwd: "x".repeat(maxPathChars) }, 1_000_000],
        [{ action: "start", command, id: "x".repeat(maxIdChars + 1) }, 1_000_000],
      ];
      for (const [input, maxOutputBytes] of rejectedStarts)
        yield* Effect.promise(() => expect(nested(input, maxOutputBytes)).rejects.toBeDefined());

      const started = yield* Effect.promise(() => nested({ action: "start", command }));
      if (started.action !== "start") throw new Error("nested start returned the wrong action");
      const taskId = started.snapshot.id;
      expect(taskId).toBe("task-1");
      expect(yield* Effect.promise(() => nested({ action: "list", state: "all" }))).toMatchObject({
        tasks: [{ id: taskId }],
      });
      expect(yield* Effect.promise(() => topLevel({ action: "list", state: "all" }))).toMatchObject(
        { details: { action: "list", tasks: [{ id: taskId }] } },
      );

      app.activeTools.splice(0, app.activeTools.length);
      yield* Effect.promise(() =>
        expect(nested({ action: "list" })).rejects.toMatchObject({ _tag: "PiSessionRuntimeError" }),
      );

      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
      yield* Effect.promise(() =>
        expect(nested({ action: "list" }, 1_024)).rejects.toMatchObject({
          _tag: "PiSessionRuntimeError",
        }),
      );
    }),
  );

  it.effect("interrupts a never-settling settings load on shutdown", () =>
    Effect.gen(function* () {
      const entered = deferredPromise();
      let loaderSignal: AbortSignal | undefined;
      const app = harness((_cwd, _trusted, signal) => {
        loaderSignal = signal;
        entered.resolve();
        return Promise.race([]);
      });
      const ctx = context(process.cwd());

      const starting = app.emit("session_start", ctx);
      yield* Effect.promise(() => entered.promise);
      const shutdown = app.emit("session_shutdown", ctx);
      yield* Effect.promise(() => Promise.all([starting, shutdown]));

      expect(loaderSignal?.aborted).toBe(true);
      expect(app.registerTool).not.toHaveBeenCalled();
    }),
  );
});

describe("/tasks command", () => {
  it.effect("reports the current effective settings without opening the TUI manager", () => {
    const status = vi.fn(() =>
      Promise.resolve({
        ...DEFAULT_BACKGROUND_TASK_CONFIG,
        maxRunning: 64,
        maxWaitSeconds: 120,
        shellPath: "/bin/\u001b[31mzsh\nspoof",
      }),
    );
    const command = tasksCommandHarness("exited", { status });
    return Effect.gen(function* () {
      yield* Effect.promise(() => command.run("  StAtUs  "));

      expect(status).toHaveBeenCalledOnce();
      expect(command.custom).not.toHaveBeenCalled();
      expect(command.notify).toHaveBeenCalledOnce();
      const [message, level] = command.notify.mock.calls[0] ?? [];
      expect(level).toBe("info");
      expect(message).toEqual(expect.stringContaining("maxRunning: 64"));
      expect(message).toEqual(expect.stringContaining("maxWaitSeconds: 120"));
      expect(message).toEqual(expect.stringContaining("shellPath: /bin/zsh spoof"));
      expect(message).not.toContain("\u001b");
    });
  });

  it.effect("preserves the manager fallback for non-status arguments", () => {
    const manager = tasksCommandHarness().open("anything");
    return Effect.sync(() => expect(manager.isOpen()).toBe(true)).pipe(
      Effect.ensuring(manager.close),
    );
  });

  it.effect("closing keeps a hidden questionnaire dock stacked above the manager", () => {
    const command = tasksCommandHarness();
    const manager = command.open();
    const dock = { render: () => ["questionnaire"], invalidate() {} };
    const hidden = command.host.showUnrelated(dock);
    hidden.setHidden(true);
    return Effect.gen(function* () {
      yield* manager.close;
      hidden.setHidden(false);
      expect(command.host.overlays).toEqual([dock]);
    });
  });

  it.effect("reports a status lookup failure without rejecting the command", () => {
    const failure = "session settings unavailable";
    const command = tasksCommandHarness("exited", {
      status: () => Promise.reject(new Error(failure)),
    });
    return Effect.gen(function* () {
      yield* Effect.promise(() => command.run("status"));

      expect(command.custom).not.toHaveBeenCalled();
      expect(command.notify).toHaveBeenCalledWith(expect.stringContaining(failure), "error");
    });
  });
});

describe("/tasks action feedback", () => {
  it.effect.each([
    { action: "stop", state: "running", keys: ["x", "x"] },
    { action: "clear", state: "exited", keys: ["c"] },
  ] as const)(
    "shows a $action failure while leaving the manager available to close normally",
    ({ action, state, keys }) => {
      const failure = `${action} failure surfaced`;
      const command = tasksCommandHarness(state, {
        [action]: () => Promise.reject(new Error(failure)),
      });
      const manager = command.open();
      return Effect.gen(function* () {
        manager.surface.render(120);
        for (const key of keys) manager.surface.handleInput?.(key);
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(command.notify).toHaveBeenCalledWith(expect.stringContaining(failure), "error"),
          ),
        );
        expect(manager.isOpen()).toBe(true);
      }).pipe(Effect.ensuring(manager.close));
    },
  );
});
