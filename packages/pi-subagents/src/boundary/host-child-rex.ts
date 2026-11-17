import type { Socket } from "node:net";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEventResult,
  type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  invokeBestEffort,
  invokeHostCallback,
  notifyAtHostBoundary,
} from "pi-cosmic-core/host-session";
import { NodeEventEmitter, nodeCreateConnection } from "pi-cosmic-core/platform/node-builtins";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import type { LocalPiContact } from "../backend/local-pi-protocol.ts";
import { localPiChildIpcChannel, type LocalPiChildIpcChannel } from "./local-pi-ipc.ts";
import {
  REX_FRAME,
  REX_SOCKET_ENV,
  REX_TOKEN_ENV,
  rexFrame,
  splitRexFrames,
} from "./rex-session-frames.mjs";

/**
 * A subagent whose Pi runs interactively in a Rex block has no RPC channel, so this half speaks
 * for it: over the socket its launcher named, it answers the commands the parent's backend sends
 * a headless child and reports the same events, built from Pi's extension API. The parent's
 * backend can't tell the two kinds of child apart, and everything above it is unchanged.
 */

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const CommandId = Schema.optional(Schema.String);
const CommandSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["get_state", "get_session_stats", "clear_queue", "abort"]),
    id: CommandId,
  }),
  Schema.Struct({
    type: Schema.Literal("prompt"),
    id: CommandId,
    message: Schema.String,
    streamingBehavior: Schema.optional(Schema.Literal("steer")),
  }),
  Schema.Struct({
    type: Schema.Literal("get_entries"),
    id: CommandId,
    since: Schema.optional(Schema.String),
  }),
]);
type Command = typeof CommandSchema.Type;
const decodeCommand = decodeUnknownOrUndefined(CommandSchema);
const decodeCommandHead = decodeUnknownOrUndefined(
  Schema.Struct({ type: Schema.String, id: CommandId }),
);
const decodeLink = decodeUnknownOrUndefined(
  Schema.Struct({ socket: Schema.String, token: Schema.String }),
);

const decodeAsk = decodeUnknownOrUndefined(
  Schema.Union([
    Schema.Struct({ id: Schema.String, request: Schema.Json }),
    Schema.Struct({ id: Schema.String, withdraw: Schema.Literal(true) }),
  ]),
);

/**
 * Shows the user a questionnaire the root sent, in this session, and resolves with the outcome,
 * or `undefined` when this session can't show one.
 */
export type RexPanePresenter = (
  request: Schema.Json,
  signal: AbortSignal,
  shown: () => void,
) => Promise<Schema.Json | undefined>;

/** The questionnaires the root shows the user in this session's pane, while one is open. */
export interface RexPaneAsks {
  /** Shows them through `present` until the returned function runs, which declines any still open. */
  readonly listen: (present: RexPanePresenter) => () => void;
}

/** What this session says of a questionnaire the root sent it. */
type PaneAnswer =
  | { readonly id: string; readonly shown: true }
  | { readonly id: string; readonly declined: true }
  | { readonly id: string; readonly outcome: Schema.Json };

interface Link {
  readonly socket: Socket;
  /** A parked session answers no commands and starts no turns; it waits to be resumed. */
  readonly parked: boolean;
}

/** A tool's arguments or result, which Pi types `any`: carried as it is, if it is a container. */
const OpaqueSchema = Schema.declare(Predicate.isObjectOrArray);
const opaque = Fn.flow(Schema.decodeUnknownOption(OpaqueSchema), Option.getOrUndefined);
type Opaque = typeof OpaqueSchema.Type;

type SessionMessage = MessageEndEvent["message"];
type SessionEntries = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;

/** What a command's response carries, in the shapes Pi's RPC mode answers with. */
type ResponseData =
  | {
      readonly thinkingLevel: string;
      readonly model?: { readonly provider: string; readonly id: string };
      readonly sessionId: string;
      readonly sessionFile?: string;
    }
  | {
      readonly tokens: Readonly<
        Record<"input" | "output" | "cacheRead" | "cacheWrite" | "total", number>
      >;
      readonly cost: number;
      readonly contextUsage: { readonly percent: number | null };
    }
  | { readonly disposition: "started" | "queued" }
  | { readonly entries: SessionEntries; readonly leafId: string | null };

type CommandOutcome =
  | { readonly success: true; readonly data?: ResponseData }
  | { readonly success: false; readonly error: string };

/** The run's events, as Pi's RPC mode would write them. */
type SessionEvent =
  | {
      readonly type: "agent_start" | "agent_end" | "agent_settled" | "turn_end" | "compaction_end";
    }
  | { readonly type: "message_start" | "message_end"; readonly message: SessionMessage }
  | {
      readonly type: "message_update";
      readonly message: SessionMessage;
      readonly assistantMessageEvent: { readonly type: string };
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: Opaque | undefined;
      readonly parentToolCallId?: string;
    }
  | {
      readonly type: "tool_execution_update";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly partialResult: Opaque | undefined;
      readonly parentToolCallId?: string;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: Opaque | undefined;
      readonly isError: boolean;
      readonly durationMs?: number;
    };

type OutgoingFrame =
  | SessionEvent
  | LocalPiContact
  | ({ readonly type: "response"; readonly id?: string; readonly command: string } & CommandOutcome)
  | { readonly token: string; readonly pid: number; readonly parked: boolean }
  | { readonly ok: true }
  | { readonly text: string }
  | PaneAnswer;

const send = (target: Link | undefined, kind: string, frame: OutgoingFrame): boolean => {
  if (!target || target.socket.destroyed) return false;
  return invokeHostCallback(() => {
    target.socket.write(rexFrame(kind, frame));
    return true;
  }, false);
};

const assistantUsageTotals = (ctx: ExtensionContext) => {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const { usage } = entry.message;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.total += usage.totalTokens;
    cost += usage.cost.total;
  }
  return { tokens: totals, cost };
};

export interface RexChildSession {
  /** The parent-contact channel, carried by the same socket as the commands and events. */
  readonly ipc: LocalPiChildIpcChannel;
  readonly paneAsks: RexPaneAsks;
}

/**
 * Connects to the launcher's socket when this Pi was started inside a Rex block, and speaks the
 * backend's protocol over it. Returns `undefined` for a headless child.
 */
export function openRexChildSession(
  pi: ExtensionAPI,
  environment: NodeJS.ProcessEnv = process.env,
): RexChildSession | undefined {
  const socketPath = environment[REX_SOCKET_ENV];
  const token = environment[REX_TOKEN_ENV];
  if (!socketPath || !token) return undefined;
  delete environment[REX_SOCKET_ENV];
  delete environment[REX_TOKEN_ENV];

  const contactEvents = new NodeEventEmitter();
  let link: Link | undefined;
  let context: ExtensionContext | undefined;
  /** Commands that arrived before the session started, which need its context to answer. */
  const waiting: Command[] = [];
  /** Steering text this half queued for the parent, which an abort returns to the editor. */
  const steered: string[] = [];
  let closing = false;

  const event = (frame: SessionEvent): void => {
    if (link && !link.parked) send(link, REX_FRAME.rpc, frame);
  };
  const respond = (
    command: { readonly type: string; readonly id?: string | undefined },
    outcome: CommandOutcome,
  ) =>
    send(link, REX_FRAME.rpc, {
      type: "response",
      ...(command.id !== undefined && { id: command.id }),
      command: command.type,
      ...outcome,
    });
  const succeed = (command: Command, data?: ResponseData) =>
    respond(command, { success: true, ...(data && { data }) });

  // The parent is this session's only reader. Without it nothing takes the report, so the turn
  // stops and Pi exits; Pi defers the exit until the abort has settled.
  const leave = (): void => {
    if (closing) return;
    closing = true;
    contactEvents.emit("disconnect");
    const ctx = context;
    if (!ctx) return;
    invokeBestEffort(() => ctx.abort());
    invokeBestEffort(() => ctx.shutdown());
  };

  const handle = (ctx: ExtensionContext, command: Command): void => {
    switch (command.type) {
      case "get_state": {
        const { model } = ctx;
        succeed(command, {
          thinkingLevel: pi.getThinkingLevel(),
          ...(model && { model: { provider: model.provider, id: model.id } }),
          sessionId: ctx.sessionManager.getSessionId(),
          ...Option.match(Option.fromNullishOr(ctx.sessionManager.getSessionFile()), {
            onNone: () => ({}),
            onSome: (sessionFile) => ({ sessionFile }),
          }),
        });
        return;
      }
      case "get_session_stats":
        succeed(command, {
          ...assistantUsageTotals(ctx),
          contextUsage: { percent: ctx.getContextUsage()?.percent ?? null },
        });
        return;
      case "prompt": {
        const idle = ctx.isIdle();
        if (!idle && command.streamingBehavior === undefined) {
          respond(command, { success: false, error: "The subagent is busy." });
          return;
        }
        if (!idle) steered.push(command.message);
        pi.sendUserMessage(command.message, idle ? undefined : { deliverAs: "steer" });
        succeed(command, { disposition: idle ? "started" : "queued" });
        return;
      }
      // Pi returns queued messages to the editor when a turn is aborted, so there is no queue
      // to clear ahead of the abort; the settled turn below empties the editor of them.
      case "clear_queue":
        succeed(command);
        return;
      case "abort":
        ctx.abort();
        succeed(command);
        return;
      case "get_entries": {
        const entries = ctx.sessionManager.getEntries();
        const cursor =
          command.since === undefined
            ? Option.some(-1)
            : Arr.findFirstIndex(entries, (entry) => entry.id === command.since);
        if (Option.isNone(cursor)) {
          respond(command, { success: false, error: "Unknown session entry." });
          return;
        }
        succeed(command, {
          entries: entries.slice(cursor.value + 1),
          leafId: ctx.sessionManager.getLeafId(),
        });
      }
    }
  };
  const receiveCommand = (value: Schema.Json): void => {
    const command = decodeCommand(value);
    if (!command) {
      const head = decodeCommandHead(value);
      if (head) respond(head, { success: false, error: "Unsupported command." });
      return;
    }
    const ctx = context;
    if (ctx) answer(ctx, command);
    else waiting.push(command);
  };
  const answer = (ctx: ExtensionContext, command: Command): void => {
    const handled = invokeHostCallback(() => {
      handle(ctx, command);
      return true;
    }, false);
    if (!handled) respond(command, { success: false, error: "The command failed." });
  };

  // Questionnaires the root shows the user here, by the root's ID for each.
  let presenter: RexPanePresenter | undefined;
  const paneAsks = new Map<string, AbortController>();
  /** Hands every open questionnaire back: the user can no longer answer it in this session. */
  const declineAsks = (): void => {
    for (const [id, showing] of paneAsks) {
      paneAsks.delete(id);
      showing.abort();
      send(link, REX_FRAME.ask, { id, declined: true });
    }
  };
  const receiveAsk = (from: Link, value: Schema.Json): void => {
    const ask = decodeAsk(value);
    if (!ask) return;
    if (!Predicate.hasProperty(ask, "request")) {
      paneAsks.get(ask.id)?.abort();
      paneAsks.delete(ask.id);
      return;
    }
    const { id } = ask;
    const present = presenter;
    if (!present || from.parked) {
      send(from, REX_FRAME.ask, { id, declined: true });
      return;
    }
    const showing = new AbortController();
    paneAsks.set(id, showing);
    // Only the questionnaire still open here may speak for its ID: a withdrawn one is the root's again.
    const say = (word: PaneAnswer): void => {
      if (paneAsks.get(id) === showing) send(link, REX_FRAME.ask, word);
    };
    const settle = (outcome: Schema.Json | undefined): void => {
      say(outcome === undefined ? { id, declined: true } : { id, outcome });
      if (paneAsks.get(id) === showing) paneAsks.delete(id);
    };
    invokeBestEffort(() => {
      present(ask.request, showing.signal, () => say({ id, shown: true }))
        .then(settle)
        .catch(() => settle(undefined));
    });
  };

  const connect = (path: string, linkToken: string, parked: boolean, onLinked?: () => void) => {
    const socket = nodeCreateConnection(path);
    const next: Link = { socket, parked };
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const previous = link;
      link = next;
      send(next, REX_FRAME.hello, { token: linkToken, pid: process.pid, parked });
      onLinked?.();
      previous?.socket.end();
    });
    socket.on("data", (chunk: string) => {
      const { frames, rest } = splitRexFrames(buffered + chunk);
      buffered = rest;
      for (const frame of frames) receiveFrame(next, frame.kind, frame.body);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (link === next) leave();
    });
  };
  const receiveFrame = (from: Link, kind: string, body: string): void => {
    if (from !== link) return;
    const value = Option.getOrUndefined(decodeJson(body));
    if (value === undefined) return;
    if (kind === REX_FRAME.rpc) {
      if (!from.parked) receiveCommand(value);
    } else if (kind === REX_FRAME.contact) contactEvents.emit("message", value);
    // The run reported while its pane was open: the session stays for the user and waits, on
    // the root's own socket, to be resumed. The launcher that owned this run exits.
    else if (kind === REX_FRAME.park || kind === REX_FRAME.adopt) {
      const target = decodeLink(value);
      if (!target) return;
      const parking = kind === REX_FRAME.park;
      // A parked session is inert, so a turn still running when its run ends stops with it.
      const ctx = context;
      if (parking && ctx && !ctx.isIdle()) invokeBestEffort(() => ctx.abort());
      const acknowledge = () => send(from, REX_FRAME.park, { ok: true });
      connect(target.socket, target.token, parking, acknowledge);
    } else if (kind === REX_FRAME.ask) receiveAsk(from, value);
    else if (kind === REX_FRAME.notice) {
      const notice = decodeUnknownOrUndefined(Schema.Struct({ message: Schema.String }))(value);
      const ctx = context;
      if (notice && ctx) notifyAtHostBoundary(ctx, notice.message, "warning");
    }
  };
  connect(socketPath, token, false);

  // Quitting Pi here would end the run with it, so the session's own way out hides its pane:
  // the run goes on, and Activity shows the pane again.
  const hide = (): void => {
    declineAsks();
    send(link, REX_FRAME.hide, { ok: true });
  };
  pi.registerCommand("hide", {
    description: "Hide this subagent's pane; it keeps running",
    handler: () => {
      hide();
      return Promise.resolve();
    },
  });
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    // Pi's exit key on an empty editor is the same wish. An editor another extension installed
    // keeps its own keys.
    if (ctx.mode === "tui" && ctx.ui.getEditorComponent() === undefined)
      invokeBestEffort(() =>
        ctx.ui.setEditorComponent((tui, theme, keybindings) => {
          const editor = new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
          editor.onCtrlD = hide;
          return editor;
        }),
      );
    for (const command of waiting.splice(0)) answer(ctx, command);
  });
  pi.on("agent_start", () => event({ type: "agent_start" }));
  pi.on("agent_end", () => event({ type: "agent_end" }));
  pi.on("agent_settled", (settled, ctx) => {
    // An interrupted turn hands its queued messages back to the editor. The ones the parent
    // steered are the parent's to send again, not the user's draft.
    if (settled.aborted && steered.length > 0) {
      const returned = Arr.join(steered, "\n\n");
      invokeBestEffort(() => {
        if (Str.trim(ctx.ui.getEditorText()) === Str.trim(returned)) ctx.ui.setEditorText("");
      });
    }
    steered.length = 0;
    event({ type: "agent_settled" });
  });
  pi.on("message_start", ({ message }) => event({ type: "message_start", message }));
  pi.on("message_update", ({ message, assistantMessageEvent }) =>
    event({
      type: "message_update",
      message,
      assistantMessageEvent: { type: assistantMessageEvent.type },
    }),
  );
  pi.on("message_end", ({ message }) => {
    event({ type: "message_end", message });
  });
  pi.on("tool_execution_start", ({ toolCallId, toolName, args, parentToolCallId }) =>
    event({
      type: "tool_execution_start",
      toolCallId,
      toolName,
      args: opaque(args),
      ...(parentToolCallId !== undefined && { parentToolCallId }),
    }),
  );
  pi.on("tool_execution_update", ({ toolCallId, toolName, partialResult, parentToolCallId }) =>
    event({
      type: "tool_execution_update",
      toolCallId,
      toolName,
      partialResult: opaque(partialResult),
      ...(parentToolCallId !== undefined && { parentToolCallId }),
    }),
  );
  pi.on("tool_execution_end", ({ toolCallId, toolName, result, isError, durationMs }) =>
    event({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: opaque(result),
      isError,
      ...(durationMs !== undefined && { durationMs }),
    }),
  );
  pi.on("turn_end", () => event({ type: "turn_end" }));
  pi.on("session_compact", () => event({ type: "compaction_end" }));
  pi.on("input", (input): InputEventResult | undefined => {
    if (input.source !== "interactive") return undefined;
    // Typed into a parked session, the words are the run's next assignment: only the parent can
    // start it, so they go there and this Pi starts no turn of its own.
    if (link?.parked) {
      send(link, REX_FRAME.resume, { text: input.text });
      return { action: "handled" };
    }
    const contact: LocalPiContact = {
      channel: "pi-subagents",
      type: "user_input",
      text: input.text,
    };
    send(link, REX_FRAME.contact, contact);
    return undefined;
  });

  return {
    ipc: localPiChildIpcChannel({
      events: contactEvents,
      connected: () => link !== undefined && !link.parked && !link.socket.destroyed,
      send: (message, callback) => {
        callback(send(link, REX_FRAME.contact, message) ? null : new Error("Rex link is closed."));
      },
    }),
    paneAsks: {
      listen: (present) => {
        presenter = present;
        return () => {
          if (presenter === present) presenter = undefined;
          declineAsks();
        };
      },
    },
  };
}
