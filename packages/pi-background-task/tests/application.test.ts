import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { deferredPromise, extensionContextFixture, pollUntil } from "pi-cosmic-core/testing";
import { signalProcess } from "pi-cosmic-core";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
import { afterEach, vi } from "vitest";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";
import { applicationHost, decodeDetails, sessionContext } from "./support/application-host.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The guidelines a session's background_task registration carries. */
const registeredGuidelines = (subagentChild: boolean) =>
  Effect.gen(function* () {
    const app = yield* applicationHost(() => Promise.resolve(), { subagentChild });
    const ctx = sessionContext();
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

describe("background-task Pi lifecycle", () => {
  it.effect.each([false, true])(
    "marks its notices as automated in model requests only (subagent child: %s)",
    (subagentChild) =>
      Effect.gen(function* () {
        const app = yield* applicationHost(() => Promise.resolve(), { subagentChild });
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
          app.modelContext(sessionContext(), [typed, notice]),
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
        const app = yield* applicationHost((cwd, _trusted, signal) => {
          if (cwd !== firstCwd) return Promise.resolve();
          firstSignal = signal;
          entered.resolve();
          return Promise.race([]);
        });

        const firstStart = app.emit("session_start", sessionContext({ cwd: firstCwd }));
        yield* Effect.promise(() => entered.promise);
        const secondContext = sessionContext({ cwd: secondCwd });
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
        const app = yield* applicationHost(() => {
          if (++loadCount === 1) return Promise.resolve();
          entered.resolve();
          return replacement.promise;
        });
        const ctx = sessionContext();
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
        const app = yield* applicationHost(() => Promise.resolve(), { events: activity.events });
        const ctx = sessionContext({ sessionId: "tree-session" });
        yield* Effect.gen(function* () {
          yield* Effect.promise(() => app.emit("session_start", ctx));
          for (let navigation = 0; navigation < 2; navigation += 1) {
            const execute = (input: BackgroundTaskToolInput) => app.execute(input, ctx);
            const taskId = yield* app.startTask(ctx, {
              command:
                `node -e "const {spawn}=require('node:child_process'); ` +
                `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); ` +
                `console.log('ready:'+process.pid+':'+child.pid+':end'); setInterval(()=>{},1000)"`,
            });
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
            yield* pollUntil(
              () => Arr.every(pids, (pid) => signalProcess(pid, 0) === "absent"),
              1_000,
            );
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
        const app = yield* applicationHost(() => Promise.resolve(), {
          // Tasks run with the shell settings Pi's bash tool uses.
          host: { sendMessage, getSettings: () => ({ shellCommandPrefix: "greeting=hello" }) },
          subagentChild,
        });
        const ctx = sessionContext();
        const start = (command: string) => app.startTask(ctx, { command, notify: "exit" });
        yield* Effect.gen(function* () {
          yield* Effect.promise(() => app.emit("session_start", ctx));
          const id = yield* start('echo "$greeting"; exit 3');
          yield* pollUntil(() => sendMessage.mock.calls.length > 0, 1_000);
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
        const app = yield* applicationHost(() => Promise.resolve(), { subagentChild });
        const ctx = sessionContext();
        yield* Effect.gen(function* () {
          yield* Effect.promise(() => app.emit("session_start", ctx));
          const id = yield* app.startTask(ctx, { command: "sleep 30" });
          const settled = yield* Effect.promise(() => app.settle(ctx));
          const reminder = Arr.findFirst(
            settled.entries,
            (entry) =>
              entry.type === "custom_message" &&
              Predicate.isString(entry.content) &&
              Fn.pipe(entry.content, Str.includes(id)),
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
      const app = yield* applicationHost((_cwd, _trusted, signal) => {
        loaderSignal = signal;
        entered.resolve();
        return Promise.race([]);
      });
      const ctx = sessionContext();

      const starting = app.emit("session_start", ctx);
      yield* Effect.promise(() => entered.promise);
      const shutdown = app.emit("session_shutdown", ctx);
      yield* Effect.promise(() => Promise.all([starting, shutdown]));

      expect(loaderSignal?.aborted).toBe(true);
      expect(app.tools).toHaveLength(0);
    }),
  );
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
        const app = yield* applicationHost(() => Promise.resolve(), { settings });
        const setStatus = vi.fn<ExtensionUIContext["setStatus"]>();
        const ctx = sessionContext({ ui: { setStatus } });
        const shown = () => Arr.filter(setStatus.mock.calls, ([, text]) => text !== undefined);
        yield* Effect.gen(function* () {
          yield* Effect.promise(() => app.emit("session_start", ctx));
          const started = yield* Effect.promise(() =>
            app.execute({ action: "start", command: "sleep 30" }, ctx),
          );
          expect(started.isError === true).toBe(!admits);
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

  it.live("the footer line steps aside while Activity lists running tasks", () =>
    Effect.gen(function* () {
      const activity = fakeActivityHost("footer-session");
      const app = yield* applicationHost(() => Promise.resolve(), { events: activity.events });
      const setStatus = vi.fn<ExtensionUIContext["setStatus"]>();
      const ctx = sessionContext({ ui: { setStatus }, sessionId: "footer-session" });
      yield* Effect.gen(function* () {
        yield* Effect.promise(() => app.emit("session_start", ctx));
        yield* Effect.promise(() => app.execute({ action: "start", command: "sleep 30" }, ctx));
        expect(activity.get()?.items).toHaveLength(1);
        expect(Arr.filter(setStatus.mock.calls, ([, text]) => text !== undefined)).toEqual([]);
        yield* Effect.promise(() => app.execute({ action: "stop_all" }, ctx));
      }).pipe(Effect.ensuring(Effect.promise(() => app.emit("session_shutdown", ctx))));
    }).pipe(Effect.scoped),
  );

  it.live("an aborted wait ends before the hour maxWaitSeconds allows and leaves the task", () => {
    const call = new AbortController();
    return Effect.gen(function* () {
      const app = yield* applicationHost(() => Promise.resolve(), {
        settings: { maxWaitSeconds: 3_600 },
      });
      const ctx = sessionContext({ ui: {} });
      yield* Effect.gen(function* () {
        yield* Effect.promise(() => app.emit("session_start", ctx));
        const id = yield* app.startTask(ctx, { command: "sleep 30" });

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
      const app = yield* applicationHost(() => Promise.resolve(), {
        settings: { stopGraceMs: 1_000, unrelated: true },
      });
      const notify = vi.fn<ExtensionUIContext["notify"]>();
      const ctx = sessionContext({ ui: { notify } });

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
      const app = yield* applicationHost(() => Promise.resolve());
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
