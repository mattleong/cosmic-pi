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
import { makeSessionCapabilityProtocol, signalProcess } from "pi-cosmic-core";
import { ACTIVITY_VIEW_DISCOVER } from "pi-cosmic-ui/activity/view";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
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
import { registerTasksCommand, type TaskManagerActions } from "../src/settings/controller.ts";
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

const harness = (
  loadSettings: BackgroundTaskApplicationBoundaries["loadSettings"],
  events: ExtensionAPI["events"] = createEventBus(),
) => {
  const handlers = new Map<string, Handler>();
  let command: RegisteredCommand | undefined;
  const tools: CapturedBackgroundTool[] = [];
  const activeTools: string[] = [];
  const registerTool = vi.fn((tool: CapturedBackgroundTool) => {
    tools.push(tool);
    if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
  });
  const fixture = {
    events,
    registerCommand: vi.fn((name: string, definition: RegisteredCommand) => {
      if (name === "tasks") command = definition;
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
    emit: (
      name: "session_start" | "session_tree" | "turn_end" | "session_shutdown",
      ctx: ExtensionContext,
    ) => Promise.resolve(handlers.get(name)?.({}, ctx)),
    discover: (sessionId: string) => {
      const found: BackgroundTaskCodeModeCapability[] = [];
      events.emit(BACKGROUND_TASK_CODE_MODE_QUERY, {
        version: BACKGROUND_TASK_CODE_MODE_VERSION,
        sessionId,
        respond: <Candidate>(candidate: Candidate) => {
          const capability = normalizeBackgroundTaskCodeModeCapability(candidate);
          if (capability) found.push(capability);
        },
      });
      return found;
    },
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
  actions: Partial<TaskManagerActions> = {},
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
  registerTasksCommand(pi, bridge, {
    stop: () => Promise.resolve(),
    clear: () => Promise.resolve(),
    config: () => undefined,
    read: () => Promise.resolve({}),
    write: () => Promise.resolve(),
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
  for (const outcome of ["accepted", "unavailable", "absent", "rejected", "replaced"] as const) {
    it.effect(`routes bare tasks to the shared view with ${outcome} admission`, () =>
      Effect.gen(function* () {
        const events = createEventBus();
        const queryProtocol = makeSessionCapabilityProtocol({ version: 1, maxSessionIdChars: 256 });
        const pending = deferredPromise<boolean>();
        const open = vi.fn(() =>
          outcome === "replaced"
            ? pending.promise
            : outcome === "rejected"
              ? Promise.reject(new Error("Manager already open"))
              : Promise.resolve(outcome === "accepted"),
        );
        if (outcome !== "absent")
          events.on(ACTIVITY_VIEW_DISCOVER, (data) => {
            const query = queryProtocol.normalizeQuery(data);
            if (query?.sessionId === "view-session")
              query.respond({ version: 1, sessionId: "view-session", hostToken: {}, open });
          });
        const custom = vi.fn(() => Promise.resolve(undefined));
        const ctx = extensionContextFixture({
          cwd: process.cwd(),
          signal: undefined,
          hasUI: true,
          mode: "tui",
          isProjectTrusted: () => false,
          ui: { notify: vi.fn(), custom },
          sessionManager: { getSessionId: () => "view-session", getSessionFile: () => undefined },
        });
        const h = harness(() => Promise.resolve(), events);
        yield* Effect.promise(() => h.emit("session_start", ctx));
        const opened = h.runCommand("", ctx);
        if (outcome === "replaced") {
          yield* Effect.promise(() => vi.waitFor(() => expect(open).toHaveBeenCalled()));
          yield* Effect.promise(() => h.emit("session_tree", ctx));
          pending.resolve(false);
        }
        if (outcome === "rejected" || outcome === "replaced")
          yield* Effect.promise(() => expect(opened).rejects.toThrow());
        else yield* Effect.promise(() => opened);
        if (outcome !== "absent") expect(open).toHaveBeenCalledWith("tasks", undefined);
        expect(custom).toHaveBeenCalledTimes(
          outcome === "absent" || outcome === "unavailable" ? 1 : 0,
        );
        yield* Effect.promise(() => h.emit("session_shutdown", ctx));
      }),
    );
  }

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

  it.effect.each(["session_start", "session_tree"] as const)(
    "interrupts a never-settling settings load on %s replacement",
    (event) =>
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
        const secondStart = app.emit(event, secondContext);
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

        yield* Effect.promise(() => app.runCommand("settings status", ctx));
        const firstMessage = notify.mock.calls[0]?.[0];
        expect(firstMessage).toEqual(expect.stringContaining("maxRunning = 64"));
        expect(firstMessage).toEqual(expect.stringContaining("maxWaitSeconds = 120"));

        notify.mockClear();
        yield* Effect.promise(() => app.emit("session_start", ctx));
        yield* Effect.promise(() => app.runCommand("settings status", ctx));
        const replacementMessage = notify.mock.calls[0]?.[0];
        expect(replacementMessage).toEqual(expect.stringContaining("maxRunning = 2"));
        expect(replacementMessage).toEqual(expect.stringContaining("maxWaitSeconds = 4"));
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

  it.effect.each(["session_start", "session_tree"] as const)(
    "rejects a stale tool call while %s replacement settings are still loading",
    (event) =>
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

        const replacing = app.emit(event, ctx);
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

  it.live("tree navigation terminates prior processes and revokes same-session capabilities", () =>
    Effect.gen(function* () {
      const activity = fakeActivityHost("tree-session");
      const app = harness(() => Promise.resolve(), activity.events);
      const ctx: ExtensionContext = {
        ...context(process.cwd()),
        sessionManager: opaqueFixture({
          getSessionId: () => "tree-session",
          getSessionFile: () => undefined,
        }),
      };
      yield* Effect.gen(function* () {
        yield* Effect.promise(() => app.emit("session_start", ctx));
        // Navigation keeps the same session identity. Repeat to prove that each branch gets
        // a usable fresh registry, rather than only disposing the initial runtime.
        for (let navigation = 0; navigation < 2; navigation += 1) {
          const capability = app.discover("tree-session")[0];
          if (!capability) throw new Error("background task capability was not available");
          const execute = (input: BackgroundTaskCodeModeInput) =>
            capability.execute("tree-task", input, new AbortController().signal, 4_096);
          const started = yield* Effect.promise(() =>
            execute({
              action: "start",
              command:
                `node -e "const {spawn}=require('node:child_process'); ` +
                `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); ` +
                `console.log('ready:'+process.pid+':'+child.pid+':end'); setInterval(()=>{},1000)"`,
            }),
          );
          if (started.action !== "start") throw new Error("start returned the wrong action");
          const ready = yield* Effect.promise(() =>
            execute({
              action: "wait",
              id: started.snapshot.id,
              until: "output",
              contains: ":end",
              waitSeconds: 5,
            }),
          );
          if (ready.action !== "wait") throw new Error("wait returned the wrong action");
          expect(ready.wait.outcome).toBe("matched");
          const logs = yield* Effect.promise(() =>
            execute({ action: "logs", id: started.snapshot.id }),
          );
          const match = /ready:(\d+):(\d+):end/.exec(logs.text);
          const nodePid = Number(match?.[1]);
          const descendantPid = Number(match?.[2]);
          const shellPid = ready.wait.snapshot.pid;
          if (
            !shellPid ||
            ![nodePid, descendantPid].every((pid) => Number.isSafeInteger(pid) && pid > 0)
          )
            throw new Error("running task did not report valid process ids");
          // Independent test ownership prevents a failed cleanup regression from leaking a
          // process after the application has already replaced its old registry.
          const pids = yield* Effect.acquireRelease(
            Effect.succeed([...new Set([shellPid, nodePid, descendantPid])]),
            (captured) =>
              Effect.sync(() => {
                for (const pid of captured) signalProcess(pid, "SIGKILL");
              }),
          );
          expect(descendantPid).not.toBe(nodePid);
          for (const pid of pids) expect(signalProcess(pid, 0)).toBe("present");
          expect(activity.get()?.items).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: started.snapshot.id })]),
          );

          yield* Effect.promise(() => app.emit("session_tree", ctx));

          // Leader exit is joined, but descendant reaping can follow the process-group sweep.
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (pids.every((pid) => signalProcess(pid, 0) === "absent")) break;
            yield* Effect.sleep("10 millis");
          }
          for (const pid of pids) expect(signalProcess(pid, 0)).toBe("absent");
          expect(activity.get()?.items).toEqual([]);
          yield* Effect.promise(() =>
            expect(execute({ action: "list" })).rejects.toMatchObject({
              _tag: "PiSessionRuntimeError",
            }),
          );
          const replacement = app.discover("tree-session")[0];
          if (!replacement) throw new Error("replacement capability was not available");
          expect(
            yield* Effect.promise(() =>
              replacement.execute(
                "fresh-list",
                { action: "list" },
                new AbortController().signal,
                4_096,
              ),
            ),
          ).toMatchObject({ tasks: [] });
          expect(
            yield* Effect.promise(() =>
              app.tools
                .at(-1)!
                .execute(
                  "fresh-tool",
                  { action: "list" },
                  new AbortController().signal,
                  undefined,
                  ctx,
                ),
            ),
          ).toMatchObject({ details: { action: "list", tasks: [] } });
        }
      }).pipe(Effect.ensuring(Effect.promise(() => app.emit("session_shutdown", ctx))));
    }).pipe(Effect.scoped),
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

      const { discover } = app;
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
  it.effect("warns about arguments that name no subcommand instead of opening the manager", () => {
    const command = tasksCommandHarness();
    return Effect.gen(function* () {
      yield* Effect.promise(() => command.run("status"));
      expect(command.custom).not.toHaveBeenCalled();
      // The usage line names the settings subcommand.
      expect(command.notify).toHaveBeenCalledWith(expect.stringContaining("settings"), "warning");
    });
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
});

describe("/tasks action feedback", () => {
  it.effect.each([
    { action: "stop", state: "running", keys: ["x", "x"] },
    { action: "clear", state: "exited", keys: ["c", "c"] },
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
