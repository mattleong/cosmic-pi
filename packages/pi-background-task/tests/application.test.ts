import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionToolContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  deferredPromise,
  extensionContextFixture,
  piKeybindingsFixture,
  macrotask,
  recordingExtensionHost,
  type DefaultedEventName,
} from "pi-cosmic-core/testing";
import {
  makeSessionCapabilityProtocol,
  nodeFilePlatformLayer,
  signalProcess,
} from "pi-cosmic-core";
import { ACTIVITY_VIEW_DISCOVER } from "pi-cosmic-ui/activity/view";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
import { vi } from "vitest";
import {
  registerBackgroundTaskApplication,
  type BackgroundTaskApplicationBoundaries,
} from "../src/application.ts";
import type { BackgroundTaskProjectionBridge } from "../src/boundary/host-ui.ts";
import { registerTasksCommand, type TaskCommandActions } from "../src/settings/controller.ts";
import type { BackgroundTaskState, BackgroundTaskView } from "../src/task/model.ts";
import { BackgroundTaskDetailsSchema } from "../src/task/schema.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";

const context = (cwd: string) =>
  extensionContextFixture({
    cwd,
    signal: undefined,
    isProjectTrusted: () => false,
    hasUI: false,
    mode: "rpc",
  });

const decodeDetails = Schema.decodeUnknownSync(BackgroundTaskDetailsSchema);

const turnEnd: TurnEndEvent = {
  type: "turn_end",
  turnIndex: 0,
  message: { role: "user", content: "", timestamp: 0 },
  toolResults: [],
  messageEntryId: "entry-1",
  toolResultEntryIds: [],
  entries: [],
  continue: false,
  context: {
    contextEntries: [],
    contextMessages: [],
    llmMessages: [],
    pendingMessages: [],
    canContinue: false,
  },
  outcome: "completed",
};

const harness = (
  loadSettings: BackgroundTaskApplicationBoundaries["loadSettings"],
  events: ExtensionAPI["events"] = createEventBus(),
) => {
  const host = recordingExtensionHost({}, { events });
  registerBackgroundTaskApplication(host.pi, { loadSettings });
  return {
    tools: host.registrations,
    execute: (input: BackgroundTaskToolInput, ctx: ExtensionToolContext) => {
      const tool = host.registrations.findLast(({ name }) => name === "background_task");
      if (!tool) return Promise.reject(new Error("background_task was not registered"));
      return tool.execute("call", input, new AbortController().signal, undefined, ctx);
    },
    emit: (name: DefaultedEventName, ctx: ExtensionContext) => host.emit(name, ctx),
    turnEnd: (ctx: ExtensionContext) => host.emit("turn_end", ctx, turnEnd),
    runCommand: (args: string, ctx: ExtensionCommandContext) => {
      const command = host.commands.get("tasks");
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
  actions: Partial<TaskCommandActions> = {},
) {
  const host = fakeCustomSurfaceHost({
    rows: 8,
    keybindings: piKeybindingsFixture({ matches: () => false }),
  });
  const notify = vi.fn();
  const ui = { notify, custom: host.ctx.ui.custom.bind(host.ctx.ui) };
  const custom = vi.spyOn(ui, "custom");
  const ctx = extensionContextFixture({
    cwd: "/tmp",
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui,
  });
  const extension = recordingExtensionHost();
  const listeners = new Set<() => void>();
  const bridge: BackgroundTaskProjectionBridge = {
    get: () => ({ tasks: [managerTask(state)] }),
    publish: () => undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setContext: () => undefined,
    setFooterEnabled: () => undefined,
    clear: () => undefined,
  };
  registerTasksCommand(extension.pi, bridge, {
    stop: () => Promise.resolve(),
    clear: () => Promise.resolve(),
    config: () => undefined,
    read: () => Promise.resolve({}),
    write: () => Promise.resolve(),
    captureAuthority: () => () => true,
    ...actions,
  });
  const run = (args: string) =>
    Promise.resolve(extension.commands.get("tasks")!.handler(args, ctx));
  return {
    custom,
    notify,
    run,
    host,
    publish: () => {
      for (const listener of listeners) listener();
    },
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
        const surface = fakeCustomSurfaceHost({
          rows: 8,
          keybindings: piKeybindingsFixture({ matches: () => false }),
        });
        const ui = { notify: vi.fn(), custom: surface.ctx.ui.custom.bind(surface.ctx.ui) };
        const custom = vi.spyOn(ui, "custom");
        const standalone = outcome === "absent" || outcome === "unavailable";
        const ctx = extensionContextFixture({
          cwd: process.cwd(),
          signal: undefined,
          hasUI: true,
          mode: "tui",
          isProjectTrusted: () => false,
          ui,
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
        if (standalone) {
          yield* Effect.promise(() => vi.waitFor(() => expect(custom).toHaveBeenCalled()));
          surface.mount();
          surface.overlays.at(-1)?.handleInput?.("\x1b");
        }
        if (outcome === "rejected" || outcome === "replaced")
          yield* Effect.promise(() => expect(opened).rejects.toThrow());
        else yield* Effect.promise(() => opened);
        if (outcome !== "absent") expect(open).toHaveBeenCalledWith("tasks", undefined);
        expect(custom).toHaveBeenCalledTimes(standalone ? 1 : 0);
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
      const fs = yield* FileSystem.FileSystem;
      const agentDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-background-agent-" });
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-background-project-" });
      const configPath = `${cwd}/.pi/extensions/pi-background-task.json`;
      yield* fs.makeDirectory(`${cwd}/.pi/extensions`, { recursive: true });
      yield* fs.writeFileString(configPath, '{"maxRunning":100,"maxWaitSeconds":300}');
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory)),
        () => Effect.sync(() => vi.unstubAllEnvs()),
      );
      const app = harness(() => Promise.resolve());
      const notify = vi.fn();
      const ctx = extensionContextFixture({
        cwd,
        signal: undefined,
        isProjectTrusted: () => true,
        hasUI: true,
        mode: "rpc",
        ui: { notify },
      });

      yield* Effect.gen(function* () {
        yield* Effect.promise(() => app.emit("session_start", ctx));
        yield* fs.writeFileString(configPath, '{"maxRunning":2,"maxWaitSeconds":4}');

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
    }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect("ignores turn_end while the runtime slot is inactive", () =>
    Effect.gen(function* () {
      const settings = deferredPromise();
      const setStatus = vi.fn();
      const app = harness(() => settings.promise);
      const ctx = extensionContextFixture({
        cwd: process.cwd(),
        signal: undefined,
        isProjectTrusted: () => false,
        hasUI: true,
        mode: "tui",
        ui: { setStatus },
      });

      const starting = app.emit("session_start", ctx);
      yield* Effect.promise(() => app.turnEnd(ctx));
      expect(setStatus).not.toHaveBeenCalled();

      settings.resolve();
      yield* Effect.promise(() => starting);
      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
    }),
  );

  it.effect.each(["session_start", "session_tree"] as const)(
    "rejects retained tool calls during and after %s replacement",
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
        yield* Effect.promise(() => entered.promise);
        const staleCall = () =>
          tool.execute(
            "replacement-check",
            { action: "list" },
            new AbortController().signal,
            undefined,
            ctx,
          );
        yield* Effect.promise(() =>
          expect(staleCall()).rejects.toMatchObject({ _tag: "PiSessionRuntimeError" }),
        );

        replacement.resolve();
        yield* Effect.promise(() => replacing);
        expect(app.tools.map((tool) => tool.name)).toEqual(["background_task", "background_task"]);
        yield* Effect.promise(() =>
          expect(staleCall()).rejects.toMatchObject({ _tag: "PiSessionRuntimeError" }),
        );
        expect(yield* Effect.promise(() => app.execute({ action: "list" }, ctx))).toMatchObject({
          details: { action: "list", tasks: [] },
        });
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

      expect(app.tools).toHaveLength(0);
      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
    }),
  );

  it.live("tree navigation terminates prior processes and starts a fresh registry", () =>
    Effect.gen(function* () {
      const activity = fakeActivityHost("tree-session");
      const app = harness(() => Promise.resolve(), activity.events);
      const ctx = extensionContextFixture({
        cwd: process.cwd(),
        signal: undefined,
        isProjectTrusted: () => false,
        hasUI: false,
        mode: "rpc",
        sessionManager: {
          getSessionId: () => "tree-session",
          getSessionFile: () => undefined,
        },
      });
      yield* Effect.gen(function* () {
        yield* Effect.promise(() => app.emit("session_start", ctx));
        for (let navigation = 0; navigation < 2; navigation += 1) {
          const execute = (input: BackgroundTaskToolInput) => app.execute(input, ctx);
          const started = yield* Effect.promise(() =>
            execute({
              action: "start",
              command:
                `node -e "const {spawn}=require('node:child_process'); ` +
                `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); ` +
                `console.log('ready:'+process.pid+':'+child.pid+':end'); setInterval(()=>{},1000)"`,
            }),
          );
          const startedDetails = decodeDetails(started.details);
          if (startedDetails.action !== "start") throw new Error("start returned the wrong action");
          const taskId = startedDetails.snapshot.id;
          const ready = yield* Effect.promise(() =>
            execute({
              action: "wait",
              id: taskId,
              until: "output",
              contains: ":end",
              waitSeconds: 5,
            }),
          );
          const readyDetails = decodeDetails(ready.details);
          if (readyDetails.action !== "wait") throw new Error("wait returned the wrong action");
          expect(readyDetails.wait.outcome).toBe("matched");
          const logs = yield* Effect.promise(() => execute({ action: "logs", id: taskId }));
          const output = logs.content.map((part) => (part.type === "text" ? part.text : ""));
          const match = /ready:(\d+):(\d+):end/.exec(output.join(""));
          const nodePid = Number(match?.[1]);
          const descendantPid = Number(match?.[2]);
          const shellPid = readyDetails.wait.snapshot.pid;
          if (
            !shellPid ||
            ![nodePid, descendantPid].every((pid) => Number.isSafeInteger(pid) && pid > 0)
          )
            throw new Error("running task did not report valid process ids");
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
            expect.arrayContaining([expect.objectContaining({ id: taskId })]),
          );

          yield* Effect.promise(() => app.emit("session_tree", ctx));

          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (pids.every((pid) => signalProcess(pid, 0) === "absent")) break;
            yield* Effect.sleep("10 millis");
          }
          for (const pid of pids) expect(signalProcess(pid, 0)).toBe("absent");
          expect(activity.get()?.items).toEqual([]);
          expect(yield* Effect.promise(() => execute({ action: "list" }))).toMatchObject({
            details: { action: "list", tasks: [] },
          });
        }
      }).pipe(Effect.ensuring(Effect.promise(() => app.emit("session_shutdown", ctx))));
    }).pipe(Effect.scoped),
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
      expect(app.tools).toHaveLength(0);
    }),
  );
});

describe("/tasks command", () => {
  it.effect("warns about arguments that name no subcommand instead of opening the manager", () => {
    const command = tasksCommandHarness();
    return Effect.gen(function* () {
      yield* Effect.promise(() => command.run("status"));
      expect(command.custom).not.toHaveBeenCalled();
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
    { action: "stop", state: "running", key: "x" },
    { action: "clear", state: "exited", key: "c" },
  ] as const)(
    "revokes old $action confirmations and notifications, not new openings",
    ({ action, state, key }) =>
      Effect.gen(function* () {
        let generation = 1;
        const pending = deferredPromise();
        const mutate = vi.fn(() => pending.promise);
        const command = tasksCommandHarness(state, {
          [action]: mutate,
          captureAuthority: () => {
            const token = generation;
            return () => token === generation;
          },
        });
        const old = command.open();
        old.surface.render(120);
        old.surface.handleInput?.(key);
        generation++;
        old.surface.handleInput?.(key);
        expect(mutate).not.toHaveBeenCalled();
        expect(old.isOpen()).toBe(false);
        yield* old.close;

        const current = command.open();
        current.surface.render(120);
        current.surface.handleInput?.(key);
        current.surface.handleInput?.(key);
        expect(mutate).toHaveBeenCalledTimes(1);
        generation++;
        pending.reject(new Error("retired action failed"));
        yield* macrotask;
        expect(command.notify).not.toHaveBeenCalled();
        yield* current.close;
      }),
  );

  it.effect("closes an open manager once its session is replaced", () =>
    Effect.gen(function* () {
      let generation = 1;
      const command = tasksCommandHarness("running", {
        captureAuthority: () => {
          const token = generation;
          return () => token === generation;
        },
      });
      const manager = command.open();
      manager.surface.render(120);
      command.publish();
      expect(manager.isOpen()).toBe(true);
      generation++;
      command.publish();
      expect(manager.isOpen()).toBe(false);
      yield* manager.close;
    }),
  );

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
