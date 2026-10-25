import {
  createEventBus,
  type AgentBeforeSettleEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionToolContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  deferredPromise,
  extensionContextFixture,
  recordingExtensionHost,
  type DefaultedEventName,
} from "pi-cosmic-core/testing";
import {
  JsonDocumentStore,
  nodeFilePlatformLayer,
  signalProcess,
  type JsonObject,
} from "pi-cosmic-core";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
import { afterEach, vi } from "vitest";
import {
  registerBackgroundTaskApplication,
  type BackgroundTaskApplicationBoundaries,
} from "../src/application.ts";
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

const completedSettle: AgentBeforeSettleEvent = {
  type: "agent_before_settle",
  outcome: "completed",
  entries: [],
  continue: false,
  context: {
    contextEntries: [],
    contextMessages: [],
    llmMessages: [],
    pendingMessages: [],
    canContinue: true,
  },
};

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
  options: {
    readonly events?: ExtensionAPI["events"];
    readonly settings?: JsonObject;
    readonly host?: Partial<ExtensionAPI>;
    /** Registers as a subagent's own Pi session, whatever session runs the tests. */
    readonly subagentChild?: boolean;
  } = {},
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
    vi.stubEnv("PI_SUBAGENT_CHILD", options.subagentChild ? "1" : undefined);
    // A regular file where the agent directory belongs makes session startup fail.
    const blocker = path.join(agentDirectory, "not-a-directory");
    const host = recordingExtensionHost(
      {},
      { ...options.host, events: options.events ?? createEventBus() },
    );
    registerBackgroundTaskApplication(host.pi, { loadSettings });
    return {
      tools: host.registrations,
      execute: (
        input: BackgroundTaskToolInput,
        ctx: ExtensionToolContext,
        signal = new AbortController().signal,
      ) => {
        const tool = Option.getOrUndefined(
          Arr.findLast(host.registrations, ({ name }) => name === "background_task"),
        );
        if (!tool) return Promise.reject(new Error("background_task was not registered"));
        return tool.execute("call", input, signal, undefined, ctx);
      },
      command: (args: string, ctx: ExtensionCommandContext) => {
        const tasks = host.commands.get("tasks");
        if (!tasks) return Promise.reject(new Error("/tasks was not registered"));
        return Promise.resolve(tasks.handler(args, ctx));
      },
      emit: (name: DefaultedEventName, ctx: ExtensionContext) => host.emit(name, ctx),
      modelContext: host.modelContext,
      /** Settles a completed run through every handler, chaining their results as Pi does. */
      settle: (ctx: ExtensionContext) =>
        Arr.reduce(
          host.handlers.get("agent_before_settle"),
          Promise.resolve(completedSettle),
          (previous, handler) =>
            previous.then((event) =>
              Promise.resolve(handler(event, ctx)).then((result) => ({
                ...event,
                entries: result?.entries ?? event.entries,
                continue: result?.continue ?? event.continue,
              })),
            ),
        ),
      globalSettings: documents.readObject(settingsPath),
      breakAgentDirectory: documents
        .writeObject(blocker, {})
        .pipe(Effect.andThen(useAgentDirectory(blocker))),
      restoreAgentDirectory: useAgentDirectory(agentDirectory),
    };
  }).pipe(Effect.provide(nodeFilePlatformLayer));

describe("background-task Pi lifecycle", () => {
  it.effect.each([false, true])(
    "marks its notices as automated in model requests only (subagent child: %s)",
    (subagentChild) =>
      Effect.gen(function* () {
        const app = yield* harness(() => Promise.resolve(), { subagentChild });
        const notice = {
          role: "custom" as const,
          customType: "pi-background-task-finished",
          content: "Background task task-0000000001 exited with code 0.",
          display: true,
          details: { task: { id: "task-0000000001" } },
          timestamp: 1,
        };
        const typed = { role: "user" as const, content: "Run the tests.", timestamp: 2 };
        const sent = yield* Effect.promise(() =>
          app.modelContext(context(process.cwd()), [typed, notice]),
        );
        expect(sent[0]).toEqual(typed);
        expect(sent[1]).toMatchObject({ customType: notice.customType, details: notice.details });
        const content = sent[1]?.role === "custom" ? sent[1].content : "";
        expect(content).toContain("<pi_extension_message");
        expect(content).toContain("background task task-0000000001");
        expect(content).toContain("not typed by the user");
        expect(content).toContain(notice.content);
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
        expect(Arr.map(app.tools, (tool) => tool.name)).toEqual(["background_task"]);
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
        expect(Arr.map(app.tools, (registered) => registered.name)).toEqual([
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

  it.live(
    "tree navigation terminates prior processes and starts a fresh registry",
    () =>
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
            if (startedDetails.action !== "start")
              throw new Error("start returned the wrong action");
            const taskId = startedDetails.snapshot.id;
            const ready = yield* Effect.promise(() =>
              execute({
                action: "wait",
                id: taskId,
                until: "output",
                contains: ":end",
                waitSeconds: 30,
              }),
            );
            const readyDetails = decodeDetails(ready.details);
            if (readyDetails.action !== "wait") throw new Error("wait returned the wrong action");
            expect(readyDetails.wait.outcome).toBe("matched");
            const logs = yield* Effect.promise(() => execute({ action: "logs", id: taskId }));
            const output = Arr.map(logs.content, (part) => (part.type === "text" ? part.text : ""));
            const match = /ready:(\d+):(\d+):end/.exec(Arr.join(output, ""));
            const nodePid = Number(match?.[1]);
            const descendantPid = Number(match?.[2]);
            const shellPid = readyDetails.wait.snapshot.pid;
            if (
              !shellPid ||
              !Arr.every([nodePid, descendantPid], (pid) => Number.isSafeInteger(pid) && pid > 0)
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

            // Signalled processes can take a while to be reaped on loaded runners.
            for (let attempt = 0; attempt < 1_000; attempt += 1) {
              if (Arr.every(pids, (pid) => signalProcess(pid, 0) === "absent")) break;
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
    // Starts four real node processes, each slow to start on a loaded runner.
    60_000,
  );

  it.live.each([
    { session: "a root session starts the idle agent's turn", subagentChild: false },
    { session: "a subagent's own session appends it without a turn", subagentChild: true },
  ])(
    "sends a notifying task's finish, where $session, and nothing after shutdown",
    ({ subagentChild }) =>
      Effect.gen(function* () {
        const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
        const app = yield* harness(() => Promise.resolve(), {
          // Tasks run with the shell settings Pi's bash tool uses.
          host: { sendMessage, getSettings: () => ({ shellCommandPrefix: "greeting=hello" }) },
          subagentChild,
        });
        const ctx = context(process.cwd());
        const start = (command: string) =>
          Effect.promise(() => app.execute({ action: "start", command, notify: "exit" }, ctx)).pipe(
            Effect.map((result) => {
              const details = decodeDetails(result.details);
              if (details.action !== "start") throw new Error("start returned the wrong action");
              return details.snapshot.id;
            }),
          );
        yield* Effect.gen(function* () {
          yield* Effect.promise(() => app.emit("session_start", ctx));
          const id = yield* start('echo "$greeting"; exit 3');
          for (
            let attempt = 0;
            attempt < 1_000 && sendMessage.mock.calls.length === 0;
            attempt += 1
          )
            yield* Effect.sleep("10 millis");
          expect(sendMessage.mock.calls).toHaveLength(1);
          const [message, options] = sendMessage.mock.calls[0] ?? [];
          expect(message).toMatchObject({
            customType: "pi-background-task-finished",
            display: true,
            details: { task: { id, state: "failed", exitCode: 3 } },
          });
          expect(options).toEqual({ deliverAs: "steer", triggerTurn: !subagentChild });
          const content = Predicate.isString(message?.content) ? message.content : "";
          expect(content).toContain(id);
          expect(content).toContain("hello");

          yield* start("sleep 30");
          yield* Effect.promise(() => app.emit("session_shutdown", ctx));
          yield* Effect.sleep("100 millis");
          expect(sendMessage.mock.calls).toHaveLength(1);
        }).pipe(Effect.ensuring(Effect.promise(() => app.emit("session_shutdown", ctx))));
      }).pipe(Effect.scoped),
    30_000,
  );

  /** The guidelines a session's background_task registration carries. */
  const registeredGuidelines = (subagentChild: boolean) =>
    Effect.gen(function* () {
      const app = yield* harness(() => Promise.resolve(), { subagentChild });
      const ctx = context(process.cwd());
      return yield* Effect.promise(() => app.emit("session_start", ctx)).pipe(
        Effect.map(() =>
          Option.match(
            Arr.findLast(app.tools, ({ name }) => name === "background_task"),
            {
              onNone: () => [],
              onSome: (tool) => tool.promptGuidelines ?? [],
            },
          ),
        ),
        Effect.ensuring(Effect.promise(() => app.emit("session_shutdown", ctx))),
      );
    });

  it.live(
    "adds guidance to the tool only in a subagent's own session",
    () =>
      Effect.gen(function* () {
        const root = yield* registeredGuidelines(false);
        const child = yield* registeredGuidelines(true);
        expect(root.length).toBeGreaterThan(0);
        expect(child).toEqual(expect.arrayContaining([...root]));
        expect(child.length).toBeGreaterThan(root.length);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live.each([
    { session: "a subagent's own session", subagentChild: true },
    { session: "a root session", subagentChild: false },
  ])(
    "reminds a settling run of the tasks its end would stop only in $session",
    ({ subagentChild }) =>
      Effect.gen(function* () {
        const app = yield* harness(() => Promise.resolve(), { subagentChild });
        const ctx = context(process.cwd());
        yield* Effect.gen(function* () {
          yield* Effect.promise(() => app.emit("session_start", ctx));
          const started = yield* Effect.promise(() =>
            app.execute({ action: "start", command: "sleep 30" }, ctx),
          );
          const details = decodeDetails(started.details);
          if (details.action !== "start") throw new Error("start returned the wrong action");
          const settled = yield* Effect.promise(() => app.settle(ctx));
          const reminder = Arr.findFirst(
            settled.entries,
            (entry) =>
              entry.type === "custom_message" &&
              Predicate.isString(entry.content) &&
              Str.includes(details.snapshot.id)(entry.content),
          );
          expect(Option.isSome(reminder)).toBe(subagentChild);
          expect(settled.continue).toBe(subagentChild);
        }).pipe(Effect.ensuring(Effect.promise(() => app.emit("session_shutdown", ctx))));
      }).pipe(Effect.scoped),
    30_000,
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
        const shown = () => Arr.filter(setStatus.mock.calls, ([, text]) => text !== undefined);
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

  it.live("an aborted wait ends before the hour maxWaitSeconds allows and leaves the task", () => {
    const call = new AbortController();
    return Effect.gen(function* () {
      const app = yield* harness(() => Promise.resolve(), { settings: { maxWaitSeconds: 3_600 } });
      const ctx = settingsContext({});
      yield* Effect.gen(function* () {
        yield* Effect.promise(() => app.emit("session_start", ctx));
        const started = yield* Effect.promise(() =>
          app.execute({ action: "start", command: "sleep 30" }, ctx),
        );
        const details = decodeDetails(started.details);
        if (details.action !== "start") throw new Error("start returned the wrong action");
        const { id } = details.snapshot;

        const waiting = app.execute({ action: "wait", id, until: "exit" }, ctx, call.signal);
        let settled = false;
        void waiting.then(
          () => (settled = true),
          () => (settled = true),
        );
        yield* Effect.sleep("100 millis");
        expect(settled).toBe(false);
        call.abort();
        const waited = yield* Effect.exit(Effect.tryPromise(() => waiting));
        expect(Exit.isFailure(waited)).toBe(true);
        const status = yield* Effect.promise(() => app.execute({ action: "status", id }, ctx));
        expect(decodeDetails(status.details)).toMatchObject({ snapshot: { state: "running" } });
      }).pipe(Effect.ensuring(Effect.promise(() => app.emit("session_shutdown", ctx))));
    }).pipe(Effect.scoped);
  });

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

  it.effect("/tasks explains a runtime that isn't running or a missing Activity view", () =>
    Effect.gen(function* () {
      const app = yield* harness(() => Promise.resolve());
      const notify = vi.fn<ExtensionUIContext["notify"]>();
      const terminal = (signal?: AbortSignal) =>
        extensionContextFixture({
          cwd: process.cwd(),
          mode: "tui",
          hasUI: true,
          signal,
          ui: { notify },
        });
      const ctx = terminal();
      const notice = Effect.gen(function* () {
        notify.mockClear();
        yield* Effect.promise(() => app.command("", ctx));
        expect(notify).toHaveBeenCalledOnce();
        const [message, level] = notify.mock.calls[0] ?? [];
        expect(level).toBe("warning");
        return message;
      });
      const unavailable = yield* notice;
      expect(unavailable).not.toContain("pi-cosmic-ui");

      yield* app.breakAgentDirectory;
      yield* Effect.promise(() => app.emit("session_start", ctx));
      yield* app.restoreAgentDirectory;
      expect(app.tools).toHaveLength(0);
      expect(yield* notice).toBe(unavailable);

      yield* Effect.promise(() => app.emit("session_start", terminal(AbortSignal.abort())));
      expect(yield* notice).toBe(unavailable);

      // A running runtime needs Cosmic UI's Activity view, which this host doesn't provide.
      yield* Effect.promise(() => app.emit("session_start", ctx));
      expect(yield* notice).toContain("pi-cosmic-ui");

      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
      expect(yield* notice).toBe(unavailable);
    }),
  );
});
