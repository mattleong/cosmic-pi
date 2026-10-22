import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionToolContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
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
  JsonDocumentStore,
  nodeFilePlatformLayer,
  signalProcess,
  type JsonObject,
} from "pi-cosmic-core";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
import { afterEach, vi } from "vitest";
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

afterEach(() => {
  vi.unstubAllEnvs();
});

const useAgentDirectory = (directory: string) =>
  Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", directory));

/**
 * Registers the application against a scoped temporary agent directory, so the real runtime
 * never reads the developer's settings or writes to their package log.
 */
const harness = (
  loadSettings: BackgroundTaskApplicationBoundaries["loadSettings"],
  options: { readonly events?: ExtensionAPI["events"]; readonly settings?: JsonObject } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const documents = yield* JsonDocumentStore;
    const agentDirectory = yield* fs.makeTempDirectoryScoped({
      prefix: "pi-background-application-",
    });
    const settingsPath = path.join(agentDirectory, "extensions", "pi-background-task.json");
    if (options.settings) yield* documents.writeObject(settingsPath, options.settings);
    yield* useAgentDirectory(agentDirectory);
    // A regular file where the agent directory belongs makes session startup fail.
    const blocker = path.join(agentDirectory, "not-a-directory");
    const host = recordingExtensionHost({}, { events: options.events ?? createEventBus() });
    registerBackgroundTaskApplication(host.pi, { loadSettings });
    return {
      tools: host.registrations,
      execute: (input: BackgroundTaskToolInput, ctx: ExtensionToolContext) => {
        const tool = host.registrations.findLast(({ name }) => name === "background_task");
        if (!tool) return Promise.reject(new Error("background_task was not registered"));
        return tool.execute("call", input, new AbortController().signal, undefined, ctx);
      },
      command: (args: string, ctx: ExtensionCommandContext) => {
        const tasks = host.commands.get("tasks");
        if (!tasks) return Promise.reject(new Error("/tasks was not registered"));
        return Promise.resolve(tasks.handler(args, ctx));
      },
      emit: (name: DefaultedEventName, ctx: ExtensionContext) => host.emit(name, ctx),
      globalSettings: documents.readObject(settingsPath),
      breakAgentDirectory: documents
        .writeObject(blocker, {})
        .pipe(Effect.andThen(useAgentDirectory(blocker))),
      restoreAgentDirectory: useAgentDirectory(agentDirectory),
    };
  }).pipe(Effect.provide(nodeFilePlatformLayer));

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
  const notify = vi.fn<ExtensionUIContext["notify"]>();
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
    isAvailable: () => true,
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
  it.effect.each(["session_start", "session_tree"] as const)(
    "interrupts a never-settling settings load on %s replacement",
    (event) =>
      Effect.gen(function* () {
        const firstCwd = `${process.cwd()}/first-pending`;
        const secondCwd = `${process.cwd()}/second-ready`;
        const entered = deferredPromise();
        let firstSignal: AbortSignal | undefined;
        const app = yield* harness((cwd, _trusted, signal) => {
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

  it.effect.each(["session_start", "session_tree"] as const)(
    "rejects retained tool calls during and after %s replacement",
    (event) =>
      Effect.gen(function* () {
        const entered = deferredPromise();
        const replacement = deferredPromise();
        let loadCount = 0;
        const app = yield* harness(() => {
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
          expect(staleCall()).rejects.toSatisfy(Predicate.isTagged("PiSessionRuntimeError")),
        );

        replacement.resolve();
        yield* Effect.promise(() => replacing);
        expect(app.tools.map((registered) => registered.name)).toEqual([
          "background_task",
          "background_task",
        ]);
        yield* Effect.promise(() =>
          expect(staleCall()).rejects.toSatisfy(Predicate.isTagged("PiSessionRuntimeError")),
        );
        expect(yield* Effect.promise(() => app.execute({ action: "list" }, ctx))).toMatchObject({
          details: { action: "list", tasks: [] },
        });
        yield* Effect.promise(() => app.emit("session_shutdown", ctx));
      }),
  );

  it.live("tree navigation terminates prior processes and starts a fresh registry", () =>
    Effect.gen(function* () {
      const activity = fakeActivityHost("tree-session");
      const app = yield* harness(() => Promise.resolve(), { events: activity.events });
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
      const app = yield* harness((_cwd, _trusted, signal) => {
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

const settingsContext = (ui: Partial<ExtensionUIContext>) =>
  extensionContextFixture({
    cwd: process.cwd(),
    signal: undefined,
    isProjectTrusted: () => false,
    hasUI: true,
    mode: "rpc",
    ui,
  });

describe("background-task settings in a session", () => {
  it.live.each([
    { name: "default settings", settings: {}, footer: true, admits: true },
    {
      name: "showFooterStatus false",
      settings: { showFooterStatus: false },
      footer: false,
      admits: true,
    },
    { name: "enabled false", settings: { enabled: false }, footer: false, admits: false },
  ])(
    "$name in the global file governs the footer and task admission",
    ({ settings, footer, admits }) =>
      Effect.gen(function* () {
        const app = yield* harness(() => Promise.resolve(), { settings });
        const setStatus = vi.fn<ExtensionUIContext["setStatus"]>();
        const ctx = settingsContext({ setStatus });
        const shown = () => setStatus.mock.calls.filter(([, text]) => text !== undefined);
        yield* Effect.gen(function* () {
          yield* Effect.promise(() => app.emit("session_start", ctx));
          const started = yield* Effect.exit(
            Effect.tryPromise(() => app.execute({ action: "start", command: "sleep 30" }, ctx)),
          );
          expect(Exit.isSuccess(started)).toBe(admits);
          expect(shown().length > 0).toBe(footer);

          yield* Effect.promise(() => app.execute({ action: "stop_all" }, ctx));
          expect(setStatus.mock.calls.at(-1)?.[1]).toBeUndefined();
          const listed = yield* Effect.promise(() => app.execute({ action: "list" }, ctx));
          expect(decodeDetails(listed.details)).toMatchObject({
            action: "list",
            tasks: admits ? [expect.objectContaining({ state: "stopped" })] : [],
          });
        }).pipe(Effect.ensuring(Effect.promise(() => app.emit("session_shutdown", ctx))));
      }).pipe(Effect.scoped),
  );

  it.effect("/tasks settings writes the session's global file only while the runtime runs", () =>
    Effect.gen(function* () {
      const app = yield* harness(() => Promise.resolve(), {
        settings: { stopGraceMs: 1_000, unrelated: true },
      });
      const notify = vi.fn<ExtensionUIContext["notify"]>();
      const ctx = settingsContext({ notify });

      yield* Effect.promise(() => app.command("settings maxRunning 4", ctx));
      expect(notify).toHaveBeenCalled();
      expect(yield* app.globalSettings).toEqual({ stopGraceMs: 1_000, unrelated: true });

      yield* Effect.promise(() => app.emit("session_start", ctx));
      yield* Effect.promise(() => app.command("settings maxRunning 16", ctx));
      expect(yield* app.globalSettings).toEqual({
        stopGraceMs: 1_000,
        unrelated: true,
        maxRunning: 16,
      });
      yield* Effect.promise(() => app.command("settings maxRunning inherit", ctx));
      expect(yield* app.globalSettings).toEqual({ stopGraceMs: 1_000, unrelated: true });
      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
    }),
  );

  it.effect(
    "/tasks explains a runtime that isn't running instead of failing or opening a manager",
    () =>
      Effect.gen(function* () {
        const app = yield* harness(() => Promise.resolve());
        const surfaces = fakeCustomSurfaceHost({
          rows: 8,
          keybindings: piKeybindingsFixture({ matches: () => false }),
        });
        const notify = vi.fn<ExtensionUIContext["notify"]>();
        const ui = { notify, custom: surfaces.ctx.ui.custom.bind(surfaces.ctx.ui) };
        const custom = vi.spyOn(ui, "custom");
        const terminal = (signal?: AbortSignal) =>
          extensionContextFixture({ cwd: process.cwd(), mode: "tui", hasUI: true, signal, ui });
        const warnings = () => notify.mock.calls.filter(([, level]) => level === "warning").length;
        const ctx = terminal();
        const unavailableNotice = Effect.gen(function* () {
          const before = warnings();
          yield* Effect.promise(() => app.command("", ctx));
          expect(warnings()).toBe(before + 1);
        });

        yield* unavailableNotice;

        yield* app.breakAgentDirectory;
        yield* Effect.promise(() => app.emit("session_start", ctx));
        yield* app.restoreAgentDirectory;
        expect(app.tools).toHaveLength(0);
        yield* unavailableNotice;

        yield* Effect.promise(() => app.emit("session_start", terminal(AbortSignal.abort())));
        yield* unavailableNotice;
        expect(custom).not.toHaveBeenCalled();

        yield* Effect.promise(() => app.emit("session_start", ctx));
        const before = warnings();
        const opened = app.command("", ctx);
        yield* macrotask;
        surfaces.mount();
        expect(custom).toHaveBeenCalledTimes(1);
        surfaces.overlays.at(-1)?.handleInput?.("\x1b");
        yield* Effect.promise(() => opened);
        expect(warnings()).toBe(before);

        yield* Effect.promise(() => app.emit("session_shutdown", ctx));
        yield* unavailableNotice;
        expect(custom).toHaveBeenCalledTimes(1);
      }),
  );
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
});
