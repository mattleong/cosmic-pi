// Promise assertions characterize the Pi lifecycle boundary.
import { tmpdir } from "node:os";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionHandler,
  type ExtensionUIContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import {
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  normalizeBackgroundTaskCodeModeCapability,
  type BackgroundTaskCodeModeCapability,
} from "../src/code-mode/protocol.ts";
import {
  registerBackgroundTaskApplication,
  type BackgroundTaskApplicationBoundaries,
} from "../src/application.ts";
import type { BackgroundTaskProjectionBridge } from "../src/boundary/host-ui.ts";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "../src/config/schema.ts";
import {
  registerTaskManagerCommand,
  type TaskManagerActions,
  type TaskManagerCommandActions,
} from "../src/settings/controller.ts";
import type { BackgroundTaskState, BackgroundTaskView } from "../src/task/model.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";

type Handler = ExtensionHandler<any, any>;
type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type TestCustomFactory<Value> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: Value) => void,
) => Component | Promise<Component>;
type ManagerSurface = Component & {
  readonly render: (width: number) => string[];
  readonly handleInput: (data: string) => void;
  readonly dispose: () => void;
};

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

const deferred = <A>() => {
  const gate = Deferred.makeUnsafe<A>();
  return {
    promise: Effect.runPromise(Deferred.await(gate)),
    resolve: (value: A) => void Deferred.doneUnsafe(gate, Effect.succeed(value)),
  };
};

const extensionContextFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionContext => {
  // SAFETY: Each test invokes only the ExtensionContext members explicitly implemented here.
  return fixture as Fixture & ExtensionContext;
};

function hostFixture<Value>(fixture: Partial<Value>): Value {
  // SAFETY: Each call constructs an owned test double for only the named host surface in use.
  return fixture as Value;
}

const context = (cwd: string): ExtensionContext =>
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
  // SAFETY: Each test invokes only the ExtensionAPI members explicitly implemented above.
  registerBackgroundTaskApplication(fixture as typeof fixture & ExtensionAPI, {
    loadSettings,
  });
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

function taskManagerHarness(state: BackgroundTaskState, actions: TaskManagerActions, args = "") {
  let command: RegisteredCommand | undefined;
  let surface: ManagerSurface | undefined;
  let closed = false;
  const notify = vi.fn();
  const custom: ExtensionUIContext["custom"] = <Value>(
    factory: TestCustomFactory<Value>,
  ): Promise<Value> => {
    const completion = Deferred.makeUnsafe<Value>();
    const created = factory(
      hostFixture<TUI>({
        terminal: hostFixture<TUI["terminal"]>({ rows: 8 }),
        requestRender: vi.fn(),
      }),
      hostFixture<Theme>({
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      }),
      hostFixture<KeybindingsManager>({ matches: () => false }),
      (value) => {
        closed = true;
        void Deferred.doneUnsafe(completion, Effect.succeed(value));
      },
    );
    if (created instanceof Promise)
      throw new Error("task manager factory unexpectedly became async");
    // SAFETY: registerTaskManagerCommand synchronously returns its complete manager surface.
    surface = created as ManagerSurface;
    return Effect.runPromise(Deferred.await(completion));
  };
  const ctx = hostFixture<ExtensionCommandContext>({
    cwd: "/tmp",
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: hostFixture<ExtensionUIContext>({ custom, notify }),
  });
  const pi = hostFixture<ExtensionAPI>({
    registerCommand: (_name: string, definition: RegisteredCommand) => {
      command = definition;
    },
  });
  const bridge = hostFixture<BackgroundTaskProjectionBridge>({
    get: () => ({ tasks: [managerTask(state)] }),
    subscribe: () => () => {},
  });
  registerTaskManagerCommand(pi, bridge, {
    ...actions,
    status: () => Promise.resolve(DEFAULT_BACKGROUND_TASK_CONFIG),
  });
  if (!command) throw new Error("task manager command was not registered");
  const opened = Promise.resolve(command.handler(args, ctx));
  if (!surface) throw new Error("task manager surface did not open synchronously");
  const openedSurface = surface;
  return {
    notify,
    surface: openedSurface,
    isOpen: () => !closed,
    close: Effect.gen(function* () {
      openedSurface.handleInput("\x1b");
      yield* Effect.promise(() => opened);
      openedSurface.dispose();
    }),
  };
}

function taskCommandHarness(status: TaskManagerCommandActions["status"], notify = vi.fn()) {
  let command: RegisteredCommand | undefined;
  const custom = vi.fn();
  const ctx = hostFixture<ExtensionCommandContext>({
    cwd: "/tmp",
    mode: "rpc",
    hasUI: true,
    signal: undefined,
    ui: hostFixture<ExtensionUIContext>({ custom, notify }),
  });
  const pi = hostFixture<ExtensionAPI>({
    registerCommand: (_name: string, definition: RegisteredCommand) => {
      command = definition;
    },
  });
  const bridge = hostFixture<BackgroundTaskProjectionBridge>({
    get: () => ({ tasks: [] }),
    subscribe: () => () => {},
  });
  registerTaskManagerCommand(pi, bridge, {
    stop: () => Promise.resolve(),
    clear: () => Promise.resolve(),
    status,
  });
  if (!command) throw new Error("task command was not registered");
  const registered = command;
  return {
    custom,
    notify,
    run: (args: string) => Promise.resolve(registered.handler(args, ctx)),
  };
}

describe("background-task Pi lifecycle", () => {
  it.effect("skips superseded settings loads so only the latest generation activates", () =>
    Effect.gen(function* () {
      const settings = deferred<void>();
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
      const entered = deferred<void>();
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
      const ctx = hostFixture<ExtensionContext & ExtensionCommandContext>({
        cwd: fixture.cwd,
        signal: undefined,
        isProjectTrusted: () => true,
        hasUI: true,
        mode: "rpc",
        ui: hostFixture<ExtensionUIContext>({ notify }),
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
      const settings = deferred<void>();
      const setStatus = vi.fn();
      const app = harness(() => settings.promise);
      const ctx = extensionContextFixture({
        ...context(process.cwd()),
        hasUI: true,
        mode: "tui",
        ui: { setStatus },
      });

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
      const entered = deferred<void>();
      const replacement = deferred<void>();
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
      const settings = deferred<void>();
      const app = harness(() => settings.promise);
      const controller = new AbortController();
      const ctx = extensionContextFixture({
        ...context(process.cwd()),
        signal: controller.signal,
      });

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
      const ctx = extensionContextFixture({
        ...context(process.cwd()),
        sessionManager: {
          getSessionId: () => "session-1",
          getSessionFile: () => undefined,
        },
      });
      yield* Effect.promise(() => app.emit("session_start", ctx));

      expect(() =>
        app.events.emit(BACKGROUND_TASK_CODE_MODE_QUERY, {
          version: BACKGROUND_TASK_CODE_MODE_VERSION,
          sessionId: "session-1",
          respond: () => Promise.reject(new Error("contained response rejection")),
        }),
      ).not.toThrow();

      const wrongSession: BackgroundTaskCodeModeCapability[] = [];
      app.events.emit(BACKGROUND_TASK_CODE_MODE_QUERY, {
        version: BACKGROUND_TASK_CODE_MODE_VERSION,
        sessionId: "other-session",
        respond: <Candidate>(candidate: Candidate) => {
          const capability = normalizeBackgroundTaskCodeModeCapability(candidate);
          if (capability) wrongSession.push(capability);
        },
      });
      expect(wrongSession).toEqual([]);

      const discovered: BackgroundTaskCodeModeCapability[] = [];
      app.events.emit(BACKGROUND_TASK_CODE_MODE_QUERY, {
        version: BACKGROUND_TASK_CODE_MODE_VERSION,
        sessionId: "session-1",
        respond: <Candidate>(candidate: Candidate) => {
          const capability = normalizeBackgroundTaskCodeModeCapability(candidate);
          if (capability) discovered.push(capability);
        },
      });
      expect(discovered).toHaveLength(1);
      const capability = discovered[0];
      if (!capability) throw new Error("background capability was not discovered");
      yield* Effect.promise(() =>
        expect(
          capability.execute(
            "nested-list-refused",
            { action: "list" },
            new AbortController().signal,
            0,
          ),
        ).rejects.toMatchObject({ _tag: "InvalidBackgroundCommandError" }),
      );
      const result = yield* Effect.promise(() =>
        capability.execute(
          "nested-list",
          { action: "list", state: "all" },
          new AbortController().signal,
          4_096,
        ),
      );
      expect(result).toEqual({ action: "list", text: "No background tasks.", tasks: [] });

      const started = yield* Effect.promise(() =>
        capability.execute(
          "nested-start",
          {
            action: "start",
            command: `node -e "setTimeout(() => {}, 10000)"`,
          },
          new AbortController().signal,
          4_096,
        ),
      );
      if (started.action !== "start") throw new Error("nested start returned the wrong action");
      const taskId = started.snapshot.id;
      const topLevelTool = app.tools[0];
      if (!topLevelTool) throw new Error("top-level background tool was not registered");
      const status = yield* Effect.promise(() =>
        topLevelTool.execute(
          "top-level-status",
          { action: "status", id: taskId },
          new AbortController().signal,
          undefined,
          ctx,
        ),
      );
      expect(status).toMatchObject({ details: { snapshot: { id: taskId } } });

      app.activeTools.splice(0, app.activeTools.length);
      yield* Effect.promise(() =>
        expect(
          capability.execute(
            "deactivated-list",
            { action: "list" },
            new AbortController().signal,
            4_096,
          ),
        ).rejects.toMatchObject({ _tag: "PiSessionRuntimeError" }),
      );

      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
      yield* Effect.promise(() =>
        expect(
          capability.execute("stale-list", { action: "list" }, new AbortController().signal, 1_024),
        ).rejects.toMatchObject({ _tag: "PiSessionRuntimeError" }),
      );
    }),
  );

  it.effect("interrupts a never-settling settings load on shutdown", () =>
    Effect.gen(function* () {
      const entered = deferred<void>();
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
    const command = taskCommandHarness(status);
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
    const manager = taskManagerHarness(
      "exited",
      {
        stop: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
      "anything",
    );
    return Effect.sync(() => expect(manager.isOpen()).toBe(true)).pipe(
      Effect.ensuring(manager.close),
    );
  });

  it.effect("contains a rejecting host notification callback", () => {
    const notify = vi.fn(() => Promise.reject(new Error("host notification rejected")));
    const command = taskCommandHarness(
      () => Promise.resolve(DEFAULT_BACKGROUND_TASK_CONFIG),
      notify,
    );
    return Effect.gen(function* () {
      yield* Effect.promise(() => command.run("status"));
      yield* Effect.promise(() => Promise.resolve());
      expect(notify).toHaveBeenCalledOnce();
    });
  });

  it.effect("reports a status lookup failure without rejecting the command", () => {
    const failure = "session settings unavailable";
    const command = taskCommandHarness(() => Promise.reject(new Error(failure)));
    return Effect.gen(function* () {
      yield* Effect.promise(() => command.run("status"));

      expect(command.notify).toHaveBeenCalledWith(expect.stringContaining(failure), "error");
    });
  });
});

describe("/tasks action feedback", () => {
  it.effect("shows a stop failure while leaving the manager available to close normally", () => {
    const failure = "termination failure surfaced";
    const manager = taskManagerHarness("running", {
      stop: () => Promise.reject(new Error(failure)),
      clear: () => Promise.resolve(),
    });
    return Effect.gen(function* () {
      manager.surface.render(120);
      manager.surface.handleInput("x");
      manager.surface.handleInput("x");
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          expect(manager.notify).toHaveBeenCalledWith(expect.stringContaining(failure), "error"),
        ),
      );
      expect(manager.isOpen()).toBe(true);
    }).pipe(Effect.ensuring(manager.close));
  });

  it.effect("shows a clear failure while leaving the manager available to close normally", () => {
    const failure = "clear failure surfaced";
    const manager = taskManagerHarness("exited", {
      stop: () => Promise.resolve(),
      clear: () => Promise.reject(new Error(failure)),
    });
    return Effect.gen(function* () {
      manager.surface.render(120);
      manager.surface.handleInput("c");
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          expect(manager.notify).toHaveBeenCalledWith(expect.stringContaining(failure), "error"),
        ),
      );
      expect(manager.isOpen()).toBe(true);
    }).pipe(Effect.ensuring(manager.close));
  });
});
