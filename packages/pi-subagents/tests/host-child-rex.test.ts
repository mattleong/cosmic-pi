import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { nodeCreateServer } from "pi-cosmic-core/platform/node-builtins";
import {
  extensionApiFixture,
  extensionContextFixture,
  piKeybindingsFixture,
  pollUntil,
  tuiFixture,
} from "pi-cosmic-core/testing";
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
const listen = (path: string) =>
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
          for (const frame of split.frames)
            frames.push({ kind: frame.kind, value: decodeJson(frame.body) });
        });
        socket.on("error", () => undefined);
        socket.on("close", () => {
          closed = true;
        });
      });
      server.listen(path);
      return {
        frames,
        send: (kind: string, value: Schema.Json) => connection?.write(rexFrame(kind, value)),
        of: (kind: string) => Arr.filter(frames, (frame) => frame.kind === kind),
        isClosed: () => closed,
        /** Ends the connection from this side, as the launcher's exit does. */
        drop: () => connection?.destroy(),
        close: () => server.close(),
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
    registerCommand: (name, options) => {
      commands.set(name, () => options.handler("", ctx));
    },
    on: ((name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => undefined;
    }) as ExtensionAPI["on"],
    getThinkingLevel: () => "high",
    sendUserMessage: (content, options) => {
      const text = Predicate.isString(content) ? content : "(parts)";
      calls.push(`send:${text}:${options?.deliverAs ?? "now"}`);
    },
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
  const responses = () =>
    Arr.filter(
      Arr.map(launcher.of(REX_FRAME.rpc), (frame) => frame.value),
      Schema.is(Schema.Struct({ type: Schema.Literal("response"), id: Schema.String })),
    );
  const command = (
    id: string,
    value: { readonly type: string; readonly [key: string]: Schema.Json },
  ) =>
    Effect.gen(function* () {
      launcher.send(REX_FRAME.rpc, { ...value, id });
      expect(yield* pollUntil(() => Arr.some(responses(), (response) => response.id === id))).toBe(
        true,
      );
      return yield* Arr.findFirst(responses(), (response) => response.id === id).pipe(
        Effect.fromOption,
        Effect.orDie,
      );
    });
  expect(yield* pollUntil(() => launcher.of(REX_FRAME.hello).length === 1)).toBe(true);
  return {
    directory,
    launcher,
    session,
    environment,
    calls,
    emit,
    command,
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
        expect(yield* h.command("state", { type: "get_state" })).toMatchObject({
          command: "get_state",
          success: true,
          data: {
            thinkingLevel: "high",
            model: { provider: "openai-codex", id: "gpt-6-luna" },
            sessionId: "session-1",
            sessionFile: "/tmp/session.jsonl",
          },
        });
        expect(yield* h.command("stats", { type: "get_session_stats" })).toMatchObject({
          data: {
            tokens: { input: 20, output: 4, cacheRead: 6, cacheWrite: 2, total: 32 },
            cost: 1,
            contextUsage: { percent: 10 },
          },
        });
        expect(yield* h.command("tail", { type: "get_entries", since: "e1" })).toMatchObject({
          data: { entries: [{ id: "e2" }], leafId: "e2" },
        });
        expect(yield* h.command("lost", { type: "get_entries", since: "gone" })).toMatchObject({
          success: false,
        });
        expect(yield* h.command("odd", { type: "set_model" })).toMatchObject({ success: false });
      }),
    ),
  );

  it.live("starts an idle session's turn, queues into a busy one, and interrupts", () =>
    live(
      Effect.gen(function* () {
        const h = yield* fixture;
        h.emit("session_start");
        expect(yield* h.command("p1", { type: "prompt", message: "task" })).toMatchObject({
          data: { disposition: "started" },
        });
        h.setIdle(false);
        expect(yield* h.command("p2", { type: "prompt", message: "more" })).toMatchObject({
          success: false,
        });
        expect(
          yield* h.command("p3", { type: "prompt", message: "steer", streamingBehavior: "steer" }),
        ).toMatchObject({ data: { disposition: "queued" } });
        yield* h.command("q", { type: "clear_queue" });
        yield* h.command("a", { type: "abort" });
        expect(h.calls).toEqual(["send:task:now", "send:steer:steer", "abort"]);

        // Pi hands an interrupted turn's queue back to the editor; the parent's steer isn't a draft.
        h.setEditor("steer");
        h.emit("agent_settled", { aborted: true });
        expect(h.editor()).toBe("");
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

  it.live("parks on the root's socket, sends typed words there, and returns to a launcher", () =>
    live(
      Effect.gen(function* () {
        const h = yield* fixture;
        h.emit("session_start");
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

        // Parked, it starts no turn of its own: the words are the run's next assignment.
        expect(h.emit("input", { source: "interactive", text: "continue" })).toEqual({
          action: "handled",
        });
        expect(yield* pollUntil(() => root.of(REX_FRAME.resume).length === 1)).toBe(true);
        expect(root.of(REX_FRAME.resume)[0]?.value).toEqual({ text: "continue" });
        root.send(REX_FRAME.notice, { message: "It can't be resumed" });
        expect(yield* pollUntil(() => h.calls.includes("notify:It can't be resumed"))).toBe(true);

        const next = yield* listen(`${h.directory}/s2`);
        root.send(REX_FRAME.adopt, { socket: `${h.directory}/s2`, token: "next-token" });
        expect(yield* pollUntil(() => next.of(REX_FRAME.hello).length === 1)).toBe(true);
        expect(next.of(REX_FRAME.hello)[0]?.value).toMatchObject({
          token: "next-token",
          parked: false,
        });
        expect(h.emit("input", { source: "interactive", text: "again" })).toBeUndefined();
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
