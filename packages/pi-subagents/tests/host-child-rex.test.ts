import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import {
  CustomEditor,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { nodeCreateServer } from "pi-cosmic-core/platform/node-builtins";
import {
  deferredPromise,
  extensionApiFixture,
  extensionContextFixture,
  piKeybindingsFixture,
  pollUntil,
  tuiFixture,
} from "pi-cosmic-core/testing";
import { fauxAssistantMessage, fauxPrintSession } from "pi-cosmic-core/testing/sdk";
import { provideRexPrompt } from "../src/boundary/rex-pi-host.mjs";
import { REX_PROMPT_EVENT, type RexPrompt } from "../src/boundary/rex-prompt.mjs";
import { openRexChildSession } from "../src/boundary/host-child-rex.ts";
import {
  REX_FRAME,
  REX_SOCKET_ENV,
  REX_TOKEN_ENV,
  rexFrame,
  splitRexFrames,
} from "../src/boundary/rex-session-frames.mjs";

/** The fields of Pi's events this test raises; each handler reads only its own. */
interface FixtureEvent {
  readonly source?: string;
  readonly text?: string;
  readonly aborted?: boolean;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly args?: Schema.Json;
  readonly result?: Schema.Json;
  readonly isError?: boolean;
  readonly context?: Schema.Json;
}

type ExtensionEditorFactory = NonNullable<
  Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]
>;
const editorTheme: Parameters<ExtensionEditorFactory>[1] = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};
type Handler = (
  event: FixtureEvent & { readonly type: string },
  ctx: ExtensionContext,
) => InputEventResult | undefined;
interface Frame {
  readonly kind: string;
  readonly value: Schema.Json;
}
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** One end the child connects to: the launcher's socket, or the root's for parked sessions. */
const listen = (path: string, accept = true) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const frames: Frame[] = [];
      let connection: { write: (text: string) => void; destroy: () => void } | undefined;
      let closed = false;
      const server = nodeCreateServer((socket) => {
        let buffered = "";
        socket.setEncoding("utf8");
        connection = socket;
        socket.on("data", (chunk: string) => {
          const split = splitRexFrames(buffered + chunk);
          buffered = split.rest;
          for (const frame of split.frames) {
            frames.push({ kind: frame.kind, value: decodeJson(frame.body) });
            if (accept && frame.kind === REX_FRAME.hello)
              socket.write(rexFrame(REX_FRAME.accept, { ok: true }));
          }
        });
        socket.on("error", () => undefined);
        socket.on("close", () => {
          closed = true;
        });
      });
      server.listen(path);
      const responsesTo = (id: string) =>
        Arr.filter(
          Arr.map(frames, (frame) => frame.value),
          Schema.is(Schema.Struct({ type: Schema.Literal("response"), id: Schema.Literal(id) })),
        );
      const issue = (
        id: string,
        value: { readonly type: string; readonly [key: string]: Schema.Json },
      ) => connection?.write(rexFrame(REX_FRAME.rpc, { ...value, id }));
      const command = (
        id: string,
        value: { readonly type: string; readonly [key: string]: Schema.Json },
      ) =>
        Effect.gen(function* () {
          issue(id, value);
          expect(yield* pollUntil(() => responsesTo(id).length > 0)).toBe(true);
          return responsesTo(id)[0]!;
        });
      return {
        issue,
        command,
        responsesTo,
        frames,
        send: (kind: string, value: Schema.Json) => connection?.write(rexFrame(kind, value)),
        of: (kind: string) => Arr.filter(frames, (frame) => frame.kind === kind),
        isClosed: () => closed,
        /** Ends the connection from this side, as the launcher's exit does. */
        drop: () => connection?.destroy(),
        close: () => {
          connection?.destroy();
          server.close();
        },
      };
    }),
    (end) => Effect.sync(end.close),
  );

const entry = (id: string, parentId: string | null) => ({
  type: "message" as const,
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: id }],
    usage: {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 1,
      totalTokens: 16,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    },
    stopReason: "stop" as const,
  },
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pisa-test-" });
  const launcher = yield* listen(`${directory}/s`);
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];
  let idle = true;
  let editor = "";
  const commands = new Map<string, () => Promise<void>>();
  let installedEditor: ReturnType<ExtensionEditorFactory> | undefined;
  const pi = extensionApiFixture({
    registerCommand: (name, registered) => {
      commands.set(name, () => registered.handler("", ctx));
    },
    on: ((name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => undefined;
    }) as ExtensionAPI["on"],
    getThinkingLevel: () => "high",
    sendUserMessage: () => void calls.push("sent-without-receipt"),
  });
  const model = { provider: "openai-codex", id: "gpt-6-luna" };
  const sessionManager = {
    getSessionId: () => "session-1",
    getSessionFile: () => "/tmp/session.jsonl",
    getLeafId: () => "e2",
    getEntries: () => [entry("e1", null), entry("e2", "e1")],
  };
  const ui = {
    getEditorComponent: () => undefined,
    setEditorComponent: (factory: ExtensionEditorFactory) => {
      installedEditor = factory(tuiFixture(), editorTheme, piKeybindingsFixture());
    },
    notify: (message: string) => void calls.push(`notify:${message}`),
    getEditorText: () => editor,
    setEditorText: (text: string) => {
      editor = text;
    },
  };
  const ctx = extensionContextFixture({
    mode: "tui",
    isIdle: () => idle,
    abort: () => void calls.push("abort"),
    shutdown: () => void calls.push("shutdown"),
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    model: model as ExtensionContext["model"],
    sessionManager: sessionManager as unknown as ExtensionContext["sessionManager"],
    ui: ui as unknown as ExtensionContext["ui"],
  });
  const environment = { [REX_SOCKET_ENV]: `${directory}/s`, [REX_TOKEN_ENV]: "launch-token" };
  const session = openRexChildSession(pi, environment)!;
  const emit = (name: string, event: FixtureEvent = {}) =>
    handlers.get(name)?.({ type: name, ...event }, ctx);
  expect(yield* pollUntil(() => launcher.of(REX_FRAME.hello).length === 1)).toBe(true);
  return {
    directory,
    launcher,
    session,
    environment,
    calls,
    emit,
    offer: (candidate: string | ((text: string, steer: boolean) => Promise<string>)) =>
      pi.events.on(REX_PROMPT_EVENT, (query) => {
        if (Schema.is(Schema.Struct({ sessionId: Schema.Literal("session-1") }))(query))
          Object.assign(query, { prompt: candidate });
      }),
    runCommand: (name: string) => commands.get(name)?.(),
    // Pi calls the installed editor's exit handler for its exit key on an empty editor.
    pressExitKey: () =>
      installedEditor instanceof CustomEditor ? installedEditor.onCtrlD?.() : undefined,
    setIdle: (value: boolean) => {
      idle = value;
    },
    setEditor: (text: string) => {
      editor = text;
    },
    editor: () => editor,
  };
});

const live = <A, E>(
  body: Effect.Effect<A, E, FileSystem.FileSystem | import("effect/Scope").Scope>,
) => body.pipe(Effect.provide(NodeFileSystem.layer));

describe("a Rex-hosted child", () => {
  it("is a headless child when no launcher named a socket", () => {
    expect(openRexChildSession(extensionApiFixture({}), {})).toBeUndefined();
  });

  it.live("names itself once and keeps the socket out of its tools' environment", () =>
    live(
      Effect.gen(function* () {
        const h = yield* fixture;
        expect(h.launcher.of(REX_FRAME.hello)[0]?.value).toMatchObject({
          token: "launch-token",
          parked: false,
        });
        expect(h.environment).toEqual({});
      }),
    ),
  );

  it.live("answers the backend's commands as Pi's RPC mode would, once its session starts", () =>
    live(
      Effect.gen(function* () {
        const h = yield* fixture;
        // A command that arrives before the session exists waits for it.
        h.launcher.send(REX_FRAME.rpc, { type: "get_state", id: "early" });
        yield* Effect.sleep("30 millis");
        h.emit("session_start");
        expect(yield* h.launcher.command("state", { type: "get_state" })).toMatchObject({
          command: "get_state",
          success: true,
          data: {
            thinkingLevel: "high",
            model: { provider: "openai-codex", id: "gpt-6-luna" },
            sessionId: "session-1",
            sessionFile: "/tmp/session.jsonl",
          },
        });
        expect(yield* h.launcher.command("stats", { type: "get_session_stats" })).toMatchObject({
          data: {
            tokens: { input: 20, output: 4, cacheRead: 6, cacheWrite: 2, total: 32 },
            cost: 1,
            contextUsage: { percent: 10 },
          },
        });
        expect(
          yield* h.launcher.command("tail", { type: "get_entries", since: "e1" }),
        ).toMatchObject({
          data: { entries: [{ id: "e2" }], leafId: "e2" },
        });
        expect(
          yield* h.launcher.command("lost", { type: "get_entries", since: "gone" }),
        ).toMatchObject({
          success: false,
        });
        expect(yield* h.launcher.command("odd", { type: "set_model" })).toMatchObject({
          success: false,
        });
      }),
    ),
  );

  it.live(
    "relays the installed SDK's prompt receipts through input interception and a busy turn",
    () =>
      live(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pisa-sdk-" });
          const socket = `${directory}/s`;
          const launcher = yield* listen(socket);
          const atHook = deferredPromise();
          const releaseHook = deferredPromise();
          const finishTurn = deferredPromise();
          const { session, fake } = yield* fauxPrintSession("rex-session-", "rex-receipts", [
            (pi) => provideRexPrompt(pi, (): AgentSession => session),
            (pi) => {
              openRexChildSession(pi, { [REX_SOCKET_ENV]: socket, [REX_TOKEN_ENV]: "token" });
              pi.on("input", (input) => {
                if (input.text === "swallowed") return { action: "handled" };
                if (input.text !== "start") return { action: "continue" };
                atHook.resolve();
                return releaseHook.promise.then(() => ({ action: "continue" as const }));
              });
            },
          ]);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              releaseHook.resolve();
              finishTurn.resolve();
            }),
          );
          expect(yield* pollUntil(() => launcher.of(REX_FRAME.hello).length === 1)).toBe(true);
          fake.setResponses([
            () => finishTurn.promise.then(() => fauxAssistantMessage("done")),
            fauxAssistantMessage("steer received"),
          ]);

          launcher.issue("task", { type: "prompt", message: "start" });
          yield* Effect.promise(() => atHook.promise);
          // This synchronous command round-trips while SDK prompt preflight is still waiting on input.
          yield* launcher.command("barrier", { type: "get_state" });
          expect(launcher.responsesTo("task")).toEqual([]);
          releaseHook.resolve();
          expect(
            yield* pollUntil(
              () => launcher.responsesTo("task").length === 1 && session.isStreaming,
            ),
          ).toBe(true);
          expect(launcher.responsesTo("task")[0]).toMatchObject({
            success: true,
            data: { disposition: "started" },
          });
          expect(
            yield* launcher.command("swallowed", {
              type: "prompt",
              message: "swallowed",
              streamingBehavior: "steer",
            }),
          ).toMatchObject({
            success: true,
            data: { disposition: "handled" },
          });
          expect(
            yield* launcher.command("busy", { type: "prompt", message: "no steering" }),
          ).toMatchObject({ success: false });
          expect(
            yield* launcher.command("queued", {
              type: "prompt",
              message: "later",
              streamingBehavior: "steer",
            }),
          ).toMatchObject({
            success: true,
            data: { disposition: "queued" },
          });
          expect(session.getSteeringMessages()).toEqual(["later"]);
          expect(launcher.of(REX_FRAME.contact)).toEqual([]);
          finishTurn.resolve();
          expect(yield* pollUntil(() => !session.isStreaming)).toBe(true);
        }),
      ),
    15_000,
  );

  it.live("never guesses admission or submits without a callable prompt capability", () =>
    live(
      Effect.gen(function* () {
        const h = yield* fixture;
        h.emit("session_start");
        const steer = { type: "prompt", message: "a draft", streamingBehavior: "steer" };
        h.setIdle(false);
        const detach = h.offer("not callable");
        expect(yield* h.launcher.command("unavailable", steer)).toMatchObject({ success: false });
        expect(h.calls).toEqual([]);
        detach();

        // A malformed result after submission is uncertain, not a safe refusal or a queue receipt.
        h.offer(() => Promise.resolve("unknown"));
        const invalid = yield* h.launcher.command("invalid", steer);
        expect(invalid).toMatchObject({ success: true });
        expect(invalid).not.toHaveProperty("data");
        h.setEditor("a draft");
        h.emit("agent_settled", { aborted: true });
        expect(h.editor()).toBe("a draft");
      }),
    ),
  );

  it.live("cleans parent text returned by an abort only for an acknowledged queue", () =>
    live(
      Effect.gen(function* () {
        const h = yield* fixture;
        h.emit("session_start");
        h.offer(() => Promise.resolve("queued"));
        expect(
          yield* h.launcher.command("steer", {
            type: "prompt",
            message: "guidance",
            streamingBehavior: "steer",
          }),
        ).toMatchObject({
          data: { disposition: "queued" },
        });
        yield* h.launcher.command("clear", { type: "clear_queue" });
        yield* h.launcher.command("abort", { type: "abort" });
        h.setEditor("guidance");
        h.emit("agent_settled", { aborted: true });
        expect(h.calls).toEqual(["abort"]);
        expect(h.editor()).toBe("");
      }),
    ),
  );

  it.live(
    "a released activation neither answers late receipts nor submits into its successor",
    () =>
      live(
        Effect.gen(function* () {
          const h = yield* fixture;
          h.emit("session_start");
          const started = deferredPromise();
          const receipt = deferredPromise<"queued">();
          const submitted: string[] = [];
          const submit: RexPrompt = (text) => {
            submitted.push(text);
            started.resolve();
            return receipt.promise;
          };
          h.offer(submit);
          h.launcher.issue("old", { type: "prompt", message: "previous" });
          yield* Effect.promise(() => started.promise);
          h.emit("session_shutdown");
          h.launcher.issue("released", { type: "prompt", message: "should not run" });
          // An unrecognized command doesn't need an activation. Its answer proves the preceding
          // prompt arrived on the socket while the consumer was released.
          yield* h.launcher.command("release-barrier", { type: "unsupported" });
          h.emit("session_start");
          receipt.resolve("queued");
          yield* h.launcher.command("barrier", { type: "get_state" });
          expect(h.launcher.responsesTo("old")).toEqual([]);
          expect(h.launcher.responsesTo("released")).toEqual([]);
          expect(submitted).toEqual(["previous"]);
          h.setEditor("previous");
          h.emit("agent_settled", { aborted: true });
          expect(h.editor()).toBe("previous");
        }),
      ),
  );

  it.live("reports the run's events and what the user typed into its session", () =>
    live(
      Effect.gen(function* () {
        const h = yield* fixture;
        h.emit("session_start");
        const before = h.launcher.of(REX_FRAME.rpc).length;
        h.emit("agent_start");
        h.emit("tool_execution_start", {
          toolCallId: "t1",
          toolName: "bash",
          args: { command: "ls" },
        });
        h.emit("tool_execution_end", {
          toolCallId: "t1",
          toolName: "bash",
          result: { content: [] },
          isError: false,
        });
        h.emit("turn_end", { context: { huge: "state the parent never needs" } });
        h.emit("agent_settled", { aborted: false });
        expect(yield* pollUntil(() => h.launcher.of(REX_FRAME.rpc).length === before + 5)).toBe(
          true,
        );
        expect(Arr.map(h.launcher.of(REX_FRAME.rpc).slice(before), (frame) => frame.value)).toEqual(
          [
            { type: "agent_start" },
            {
              type: "tool_execution_start",
              toolCallId: "t1",
              toolName: "bash",
              args: { command: "ls" },
            },
            {
              type: "tool_execution_end",
              toolCallId: "t1",
              toolName: "bash",
              result: { content: [] },
              isError: false,
            },
            { type: "turn_end" },
            { type: "agent_settled" },
          ],
        );

        expect(h.emit("input", { source: "extension", text: "from the parent" })).toBeUndefined();
        expect(h.emit("input", { source: "interactive", text: "from the user" })).toBeUndefined();
        expect(yield* pollUntil(() => h.launcher.of(REX_FRAME.contact).length === 1)).toBe(true);
        expect(h.launcher.of(REX_FRAME.contact)[0]?.value).toEqual({
          channel: "pi-subagents",
          type: "user_input",
          text: "from the user",
        });
      }),
    ),
  );

  it.live("large native pastes leave Pi's input untouched and send a bounded Unicode notice", () =>
    live(
      Effect.gen(function* () {
        const h = yield* fixture;
        h.emit("session_start");
        const head = Fn.pipe("a", Str.repeat(65_534));
        const text = `${head}🍎more`;
        const input = { source: "interactive", text };
        expect(h.emit("input", input)).toBeUndefined();
        expect(input.text).toBe(text);
        expect(yield* pollUntil(() => h.launcher.of(REX_FRAME.contact).length === 1)).toBe(true);
        expect(h.launcher.of(REX_FRAME.contact)[0]?.value).toEqual({
          channel: "pi-subagents",
          type: "user_input",
          text: `${head}…`,
        });
      }),
    ),
  );

  it.live("parks on the root's socket, sends typed words there, and returns to a launcher", () =>
    live(
      Effect.gen(function* () {
        const h = yield* fixture;
        h.emit("session_start");
        const submitted = deferredPromise();
        const receipt = deferredPromise<"started">();
        h.offer(() => {
          submitted.resolve();
          return receipt.promise;
        });
        h.launcher.issue("old-command", { type: "prompt", message: "old assignment" });
        yield* Effect.promise(() => submitted.promise);
        const lateAck = h.session.ipc.sendContact({
          channel: "pi-subagents",
          type: "turn_input_barrier_ack",
          requestId: "old-turn",
        });
        h.setIdle(false);
        const root = yield* listen(`${h.directory}/park`);
        h.launcher.send(REX_FRAME.park, { socket: `${h.directory}/park`, token: "park-token" });
        expect(yield* pollUntil(() => root.of(REX_FRAME.hello).length === 1)).toBe(true);
        expect(root.of(REX_FRAME.hello)[0]?.value).toMatchObject({
          token: "park-token",
          parked: true,
        });
        // The launcher learns it may leave, and a turn still running stops with the run.
        expect(yield* pollUntil(() => h.launcher.of(REX_FRAME.park).length === 1)).toBe(true);
        expect(yield* pollUntil(h.launcher.isClosed)).toBe(true);
        expect(h.calls).toEqual(["abort"]);

        // Parked input is the actual assignment, not the bounded notice of active input.
        const assignment = Fn.pipe("🍎", Str.repeat(36_000));
        expect(h.emit("input", { source: "interactive", text: assignment })).toEqual({
          action: "handled",
        });
        expect(yield* pollUntil(() => root.of(REX_FRAME.resume).length === 1)).toBe(true);
        expect(root.of(REX_FRAME.resume)[0]?.value).toEqual({ text: assignment });
        root.send(REX_FRAME.notice, { message: "It can't be resumed" });
        expect(yield* pollUntil(() => h.calls.includes("notify:It can't be resumed"))).toBe(true);

        const next = yield* listen(`${h.directory}/s2`);
        root.send(REX_FRAME.adopt, { socket: `${h.directory}/s2`, token: "next-token" });
        expect(yield* pollUntil(() => next.of(REX_FRAME.hello).length === 1)).toBe(true);
        expect(next.of(REX_FRAME.hello)[0]?.value).toMatchObject({
          token: "next-token",
          parked: false,
        });
        expect(yield* pollUntil(root.isClosed)).toBe(true);
        expect(h.emit("input", { source: "interactive", text: "again" })).toBeUndefined();
        receipt.resolve("started");
        expect(yield* Effect.flip(lateAck)).toMatchObject({ code: "transport_not_sent" });
        yield* next.command("barrier", { type: "get_state" });
        expect(
          Arr.flatMap([h.launcher, root, next], (end) => end.responsesTo("old-command")),
        ).toEqual([]);
        expect(h.calls).not.toContain("shutdown");
      }),
    ),
  );

  it.live("a replacement that refuses the hello leaves the old controller authoritative", () =>
    live(
      Effect.gen(function* () {
        const h = yield* fixture;
        h.emit("session_start");
        h.setIdle(false);
        const reject = yield* listen(`${h.directory}/reject`, false);
        h.launcher.send(REX_FRAME.park, { socket: `${h.directory}/reject`, token: "bad" });
        expect(yield* pollUntil(() => reject.of(REX_FRAME.hello).length === 1)).toBe(true);
        expect(yield* h.launcher.command("during", { type: "get_state" })).toMatchObject({
          success: true,
        });
        reject.drop();
        expect(yield* pollUntil(() => h.launcher.of(REX_FRAME.park).length > 0)).toBe(true);
        expect(h.launcher.of(REX_FRAME.park)[0]?.value).toEqual({ ok: false });
        expect(yield* h.launcher.command("after", { type: "get_state" })).toMatchObject({
          success: true,
        });
        expect(h.calls).not.toContain("abort");
        expect(h.calls).not.toContain("shutdown");
        expect(reject.of(REX_FRAME.rpc)).toEqual([]);
      }),
    ),
  );

  it.live(
    "joins a pane presenter and sends its committed answer before releasing the launcher",
    () =>
      live(
        Effect.gen(function* () {
          const h = yield* fixture;
          h.emit("session_start");
          const answer = deferredPromise<Schema.Json>();
          let signal: AbortSignal | undefined;
          h.session.paneAsks.listen((_request, owner, shown) => {
            signal = owner;
            shown();
            return answer.promise;
          });
          const root = yield* listen(`${h.directory}/root`);
          h.launcher.send(REX_FRAME.ask, { id: "one", request: {} });
          expect(yield* pollUntil(() => h.launcher.of(REX_FRAME.ask).length > 0)).toBe(true);
          h.launcher.send(REX_FRAME.park, { socket: `${h.directory}/root`, token: "root" });
          expect(yield* pollUntil(() => signal?.aborted === true)).toBe(true);
          expect(root.frames).toEqual([]);
          expect(h.launcher.isClosed()).toBe(false);
          answer.resolve({ answers: ["red"] });
          expect(yield* pollUntil(h.launcher.isClosed)).toBe(true);
          expect(h.launcher.frames.slice(-2)).toEqual([
            { kind: REX_FRAME.ask, value: { id: "one", outcome: { answers: ["red"] } } },
            { kind: REX_FRAME.park, value: { ok: true } },
          ]);
          expect(root.of(REX_FRAME.ask)).toEqual([]);

          // If a resumed launch cannot attach, this parked session still routes input to the root.
          root.send(REX_FRAME.adopt, { socket: `${h.directory}/missing`, token: "missing" });
          expect(yield* pollUntil(() => root.of(REX_FRAME.adopt).length === 1)).toBe(true);
          expect(root.of(REX_FRAME.adopt)[0]?.value).toEqual({ ok: false });
          expect(h.emit("input", { source: "interactive", text: "retry" })).toEqual({
            action: "handled",
          });
          expect(yield* pollUntil(() => root.of(REX_FRAME.resume).length === 1)).toBe(true);
          expect(h.calls).not.toContain("shutdown");
        }),
      ),
  );

  it.live("hides its pane, instead of quitting, when the user asks from inside it", () =>
    live(
      Effect.gen(function* () {
        const h = yield* fixture;
        h.emit("session_start");
        yield* Effect.promise(() => h.runCommand("hide") ?? Promise.resolve());
        // Pi's exit key on an empty editor would end the run; here it is the same wish.
        h.pressExitKey();
        expect(yield* pollUntil(() => h.launcher.of(REX_FRAME.hide).length === 2)).toBe(true);
        expect(h.calls).toEqual([]);
      }),
    ),
  );

  it.live(
    "shows the user the root's questionnaires and answers each for as long as it shows it",
    () =>
      live(
        Effect.gen(function* () {
          const h = yield* fixture;
          h.emit("session_start");
          const asks = () => Arr.map(h.launcher.of(REX_FRAME.ask), (frame) => frame.value);
          const request = { questions: [] };
          // Before anything in this session can show one, the root is told to ask elsewhere.
          h.launcher.send(REX_FRAME.ask, { id: "early", request });
          expect(yield* pollUntil(() => asks().length === 1)).toBe(true);
          expect(asks()).toEqual([{ id: "early", declined: true }]);

          const showing: Array<{
            readonly signal: AbortSignal;
            readonly shown: () => void;
            readonly answer: (outcome: Schema.Json | undefined) => void;
          }> = [];
          const detach = h.session.paneAsks.listen((_request, signal, shown) => {
            const answered = deferredPromise<Schema.Json | undefined>();
            showing.push({ signal, shown, answer: answered.resolve });
            return answered.promise;
          });
          const outcome = { outcome: "cancelled", answers: [] };
          h.launcher.send(REX_FRAME.ask, { id: "answered", request });
          expect(yield* pollUntil(() => showing.length === 1)).toBe(true);
          showing[0]?.shown();
          showing[0]?.answer(outcome);
          expect(yield* pollUntil(() => asks().length === 3)).toBe(true);
          expect(asks().slice(1)).toEqual([
            { id: "answered", shown: true },
            { id: "answered", outcome },
          ]);

          // A return request joins cleanup. A committed terminal outcome still wins the race.
          h.launcher.send(REX_FRAME.ask, { id: "withdrawn", request });
          expect(yield* pollUntil(() => showing.length === 2)).toBe(true);
          h.launcher.send(REX_FRAME.ask, { id: "withdrawn", withdraw: true });
          expect(yield* pollUntil(() => showing[1]?.signal.aborted === true)).toBe(true);
          showing[1]?.answer(outcome);

          // Hiding the pane from inside hands back what it shows, and so does the session ending.
          h.launcher.send(REX_FRAME.ask, { id: "hidden", request });
          expect(yield* pollUntil(() => showing.length === 3)).toBe(true);
          yield* Effect.promise(() => h.runCommand("hide") ?? Promise.resolve());
          expect(showing[2]?.signal.aborted).toBe(true);
          expect(asks()).not.toContainEqual({ id: "hidden", declined: true });
          showing[2]?.answer(undefined);
          expect(yield* pollUntil(() => h.launcher.of(REX_FRAME.hide).length === 1)).toBe(true);
          h.launcher.send(REX_FRAME.ask, { id: "ended", request });
          expect(yield* pollUntil(() => showing.length === 4)).toBe(true);
          detach();
          showing[3]?.answer(undefined);
          expect(yield* pollUntil(() => asks().length === 6)).toBe(true);
          expect(asks().slice(3)).toEqual([
            { id: "withdrawn", outcome },
            { id: "hidden", declined: true },
            { id: "ended", declined: true },
          ]);
          expect(showing[2]?.signal.aborted).toBe(true);
          expect(showing[3]?.signal.aborted).toBe(true);
        }),
      ),
  );

  it.live("shuts down at session start if the launcher socket never existed", () =>
    live(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pisa-no-launcher-" });
        const handlers = new Map<string, Handler>();
        const pi = extensionApiFixture({
          on: ((name: string, handler: Handler) => {
            handlers.set(name, handler);
            return () => undefined;
          }) as ExtensionAPI["on"],
        });
        const session = openRexChildSession(pi, {
          [REX_SOCKET_ENV]: `${directory}/absent`,
          [REX_TOKEN_ENV]: "token",
        })!;
        const lost = deferredPromise();
        const off = session.ipc.listen({ onControl: () => undefined, onDisconnect: lost.resolve });
        yield* Effect.promise(() => lost.promise).pipe(Effect.timeout("5 seconds"));
        let stopped = false;
        handlers.get("session_start")?.(
          { type: "session_start" },
          extensionContextFixture({
            shutdown: () => {
              stopped = true;
            },
          }),
        );
        expect(stopped).toBe(true);
        off();
      }),
    ),
  );

  it.live("stops and exits when its parent's end goes away", () =>
    live(
      Effect.gen(function* () {
        const h = yield* fixture;
        h.emit("session_start");
        h.launcher.drop();
        expect(yield* pollUntil(() => h.calls.includes("shutdown"))).toBe(true);
        expect(h.calls).toEqual(["abort", "shutdown"]);
      }),
    ),
  );
});
