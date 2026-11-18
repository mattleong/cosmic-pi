import type { Socket } from "node:net";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEventResult,
  type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
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
import { safeTextPrefix } from "pi-cosmic-core/text";
import { MAX_PARENT_MESSAGE_CHARS } from "../run/limits.ts";
import { ForeignCallable } from "pi-cosmic-core/schema/foreign-callable";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import {
  REX_PROMPT_EVENT,
  type RexPrompt,
  type RexPromptQuery,
  type RexPromptDisposition,
} from "./rex-prompt.mjs";
import type { LocalPiContact } from "../backend/local-pi-protocol.ts";
import { localPiChildIpcChannel, type LocalPiChildIpcChannel } from "./local-pi-ipc.ts";
import {
  REX_FRAME,
  REX_HANDOFF_TIMEOUT_MS,
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
type PromptCommand = Extract<Command, { readonly type: "prompt" }>;
const decodeCommand = decodeUnknownOrUndefined(CommandSchema);
const decodeCommandHead = decodeUnknownOrUndefined(
  Schema.Struct({ type: Schema.String, id: CommandId }),
);
const decodeLink = decodeUnknownOrUndefined(
  Schema.Struct({ socket: Schema.String, token: Schema.String }),
);

const decodeAccepted = decodeUnknownOrUndefined(Schema.Struct({ ok: Schema.Literal(true) }));
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

interface Activation {
  readonly ctx: ExtensionContext;
  /** Only text the SDK actually queued may be returned to the editor after an abort. */
  readonly queued: string[];
}

const decodePrompt = decodeUnknownOrUndefined(ForeignCallable<Parameters<RexPrompt>>());
const decodeDisposition = decodeUnknownOrUndefined(
  Schema.Literals(["started", "queued", "handled"]),
);

const queryPrompt = (pi: ExtensionAPI, sessionId: string) =>
  invokeHostCallback(() => {
    const query: RexPromptQuery = { sessionId, prompt: undefined };
    pi.events.emit(REX_PROMPT_EVENT, query);
    return decodePrompt(query.prompt);
  }, undefined);

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
  | { readonly disposition: RexPromptDisposition }
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
  | { readonly ok: boolean }
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
  let activation: Activation | undefined;
  /** Only the initial startup may hold commands for a session that hasn't started yet. */
  let waiting: Array<{ readonly from: Link; readonly command: Command }> | undefined = [];
  let closing = false;

  // Contact operations are lazy Effects. Capture their socket when requested, not when
  // a fork later runs an acknowledgement or cancellation.
  const contactChannel = (owner?: Link) =>
    localPiChildIpcChannel({
      events: contactEvents,
      connected: () =>
        owner !== undefined && link === owner && !owner.parked && !owner.socket.destroyed,
      send: (message, callback) => {
        callback(send(owner, REX_FRAME.contact, message) ? null : new Error("Rex link is closed."));
      },
    });
  let contacts = contactChannel();
  const event = (frame: SessionEvent): void => {
    if (link && !link.parked) send(link, REX_FRAME.rpc, frame);
  };
  const respondOn = (
    target: Link | undefined,
    command: { readonly type: string; readonly id?: string | undefined },
    outcome: CommandOutcome,
  ) =>
    send(target, REX_FRAME.rpc, {
      type: "response",
      ...(command.id !== undefined && { id: command.id }),
      command: command.type,
      ...outcome,
    });
  const respond = (
    command: { readonly type: string; readonly id?: string | undefined },
    outcome: CommandOutcome,
  ) => respondOn(link, command, outcome);
  const succeed = (command: Command, data?: ResponseData) =>
    respond(command, { success: true, ...(data && { data }) });

  const admit = (active: Activation, from: Link, command: PromptCommand): void => {
    const current = () =>
      activation === active && link === from && !closing && !from.socket.destroyed;
    const reply = (outcome: CommandOutcome) => {
      if (current()) respondOn(from, command, outcome);
    };

    const submit = queryPrompt(pi, active.ctx.sessionManager.getSessionId());
    if (!current()) return;
    if (!submit) {
      reply({ success: false, error: "The subagent's prompt capability is unavailable." });
      return;
    }
    // Submit synchronously on this socket's turn. Only the SDK's preflight receipt is async.
    // A broken contract after submission isn't a refusal: without a valid disposition the
    // backend reports an uncertain outcome rather than inviting a duplicate prompt.
    const uncertain = () => reply({ success: true });
    Effect.runSync(
      Effect.try(() => {
        const result: unknown = submit(command.message, command.streamingBehavior === "steer");
        if (!Predicate.isPromiseLike(result)) return uncertain();
        void Promise.resolve(result).then(
          (value) => {
            if (!current()) return;
            const disposition = decodeDisposition(value);
            if (disposition === "queued") active.queued.push(command.message);
            return reply({ success: true, ...(disposition && { data: { disposition } }) });
          },
          () => reply({ success: false, error: "The subagent could not take the prompt." }),
        );
      }).pipe(Effect.orElseSucceed(uncertain)),
    );
  };

  // The parent is this session's only reader. Without it nothing takes the report, so the turn
  // stops and Pi exits; Pi defers the exit until the abort has settled. A session that hasn't
  // started answers nothing and exits as it starts.
  const leave = (): void => {
    if (closing) return;
    closing = true;
    contactEvents.emit("disconnect");
    waiting = undefined;
    const ctx = activation?.ctx;
    if (!ctx) return;
    invokeBestEffort(() => ctx.abort());
    invokeBestEffort(() => ctx.shutdown());
  };

  const handle = (active: Activation, from: Link, command: Command): void => {
    const { ctx } = active;
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
      case "prompt":
        admit(active, from, command);
        return;
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
  const receiveCommand = (from: Link, value: Schema.Json): void => {
    const command = decodeCommand(value);
    if (!command) {
      const head = decodeCommandHead(value);
      if (head) respond(head, { success: false, error: "Unsupported command." });
      return;
    }
    if (activation) answer(activation, from, command);
    else waiting?.push({ from, command });
  };
  const answer = (active: Activation, from: Link, command: Command): void => {
    if (from !== link || closing || activation !== active) return;
    const handled = invokeHostCallback(() => {
      handle(active, from, command);
      return true;
    }, false);
    if (!handled) respond(command, { success: false, error: "The command failed." });
  };

  // Withdrawal requests a terminal receipt, not a synthetic decline. The presenter may
  // already have the user's decision and still be releasing the dialog/editor.
  let presenter: RexPanePresenter | undefined;
  const paneAsks = new Map<string, { readonly stop: () => Promise<void> }>();
  let moving = false;
  let hiding = false;
  const stopAsks = () => Promise.all(Arr.map([...paneAsks.values()], (ask) => ask.stop()));
  const receiveAsk = (from: Link, value: Schema.Json): void => {
    const ask = decodeAsk(value);
    if (!ask) return;
    const { id } = ask;
    const existing = paneAsks.get(id);
    if (!Predicate.hasProperty(ask, "request")) {
      existing?.stop().catch(() => from.socket.destroy());
      return;
    }
    if (existing) return;
    const present = presenter;
    if (!present || from.parked || moving || hiding) {
      send(from, REX_FRAME.ask, { id, declined: true });
      return;
    }
    const controller = new AbortController();
    let stopping: Promise<void> | undefined;
    const done = Promise.resolve()
      .then(() =>
        present(ask.request, controller.signal, () => {
          if (!controller.signal.aborted && paneAsks.get(id) === showing)
            send(from, REX_FRAME.ask, { id, shown: true });
        }),
      )
      .catch(() => undefined)
      .then((outcome) => {
        paneAsks.delete(id);
        send(from, REX_FRAME.ask, outcome === undefined ? { id, declined: true } : { id, outcome });
        return undefined;
      });
    const showing = {
      stop: () => {
        if (stopping) return stopping;
        controller.abort();
        // Never tell the root it is safe to open a second dialog if this one won't stop.
        stopping = Effect.runPromise(
          Effect.promise(() => done).pipe(
            Effect.timeoutOrElse({
              duration: REX_HANDOFF_TIMEOUT_MS,
              orElse: () =>
                Effect.sync(() => {
                  from.socket.destroy();
                }),
            }),
          ),
        );
        return stopping;
      },
    };
    paneAsks.set(id, showing);
  };

  // Connecting isn't acceptance. Until the new owner authenticates the hello, the old
  // socket remains the sole source of commands and destination of events and prompt receipts.
  let candidate: Link | undefined;
  const connect = (path: string, linkToken: string, parked: boolean, previous?: Link) => {
    const transfer = parked ? REX_FRAME.park : REX_FRAME.adopt;
    const refuse = () => {
      moving = false;
      if (previous && previous === link && !closing) send(previous, transfer, { ok: false });
      else if (!previous) leave();
    };
    const socket = invokeHostCallback(() => nodeCreateConnection(path), undefined);
    if (!socket) return refuse();
    const next: Link = { socket, parked };
    candidate = next;
    socket.setTimeout(REX_HANDOFF_TIMEOUT_MS, () => socket.destroy());
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      send(next, REX_FRAME.hello, { token: linkToken, pid: process.pid, parked });
    });
    socket.on("data", (chunk: string) => {
      const { frames, rest } = splitRexFrames(buffered + chunk);
      buffered = rest;
      for (const frame of frames) {
        if (next === candidate) {
          if (
            closing ||
            previous !== link ||
            frame.kind !== REX_FRAME.accept ||
            !decodeAccepted(Option.getOrUndefined(decodeJson(frame.body)))
          ) {
            socket.destroy();
            return;
          }
          socket.setTimeout(0);
          candidate = undefined;
          link = next;
          contacts = contactChannel(next);
          moving = false;
          if (previous) {
            if (parked) {
              contactEvents.emit("disconnect");
              const ctx = activation?.ctx;
              if (ctx && !ctx.isIdle()) invokeBestEffort(() => ctx.abort());
            }
            send(previous, transfer, { ok: true });
            previous.socket.end();
          }
        } else receiveFrame(next, frame.kind, frame.body);
      }
    });
    socket.on("error", Fn.constVoid);
    socket.on("close", () => {
      if (candidate === next) {
        candidate = undefined;
        refuse();
      } else if (link === next) {
        leave();
        candidate?.socket.destroy();
        stopAsks().catch(Fn.constVoid);
      }
    });
  };
  const receiveFrame = (from: Link, kind: string, body: string): void => {
    if (from !== link || closing) return;
    const value = Option.getOrUndefined(decodeJson(body));
    if (value === undefined) return;
    if (kind === REX_FRAME.rpc) {
      if (!from.parked) receiveCommand(from, value);
    } else if (kind === REX_FRAME.contact) contactEvents.emit("message", value);
    else if (kind === REX_FRAME.park || kind === REX_FRAME.adopt) {
      const target = decodeLink(value);
      const parking = kind === REX_FRAME.park;
      if (!target || moving || from.parked === parking) return;
      moving = true;
      stopAsks()
        .then(() => {
          if (link === from && !closing && !from.socket.destroyed)
            connect(target.socket, target.token, parking, from);
          return undefined;
        })
        .catch(() => from.socket.destroy());
    } else if (kind === REX_FRAME.ask) receiveAsk(from, value);
    else if (kind === REX_FRAME.notice) {
      const notice = decodeUnknownOrUndefined(Schema.Struct({ message: Schema.String }))(value);
      const ctx = activation?.ctx;
      if (notice && ctx) notifyAtHostBoundary(ctx, notice.message, "warning");
    }
  };
  connect(socketPath, token, false);

  // Quitting Pi here would end the run with it, so the session's own way out hides its pane:
  // the run goes on, and Activity shows the pane again.
  const hide = (): void => {
    const from = link;
    hiding = true;
    stopAsks()
      .then(() => {
        hiding = false;
        return from === link && !closing && send(from, REX_FRAME.hide, { ok: true });
      })
      .catch(() => from?.socket.destroy());
  };
  pi.registerCommand("hide", {
    description: "Hide this subagent's pane; it keeps running",
    handler: () => {
      hide();
      return Promise.resolve();
    },
  });
  pi.on("session_start", (_event, ctx) => {
    if (closing) {
      invokeBestEffort(() => ctx.shutdown());
      return;
    }
    const active: Activation = { ctx, queued: [] };
    activation = active;
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
    for (const { from, command } of waiting ?? []) answer(active, from, command);
    waiting = undefined;
  });
  pi.on("session_shutdown", () => {
    activation = undefined;
    waiting = undefined;
  });
  pi.on("agent_start", () => event({ type: "agent_start" }));
  pi.on("agent_end", () => event({ type: "agent_end" }));
  pi.on("agent_settled", (settled, ctx) => {
    // An interrupted turn hands its queued messages back to the editor. The ones the parent
    // steered are the parent's to send again, not the user's draft.
    const queued = activation?.queued;
    if (settled.aborted && queued?.length) {
      const returned = Arr.join(queued, "\n\n");
      invokeBestEffort(() => {
        if (Str.trim(ctx.ui.getEditorText()) === Str.trim(returned)) ctx.ui.setEditorText("");
      });
    }
    if (queued) queued.length = 0;
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
      text:
        input.text.length <= MAX_PARENT_MESSAGE_CHARS
          ? input.text
          : `${safeTextPrefix(input.text, MAX_PARENT_MESSAGE_CHARS - 1)}…`,
    };
    send(link, REX_FRAME.contact, contact);
    return undefined;
  });

  return {
    ipc: {
      sendContact: (message) => contacts.sendContact(message),
      listen: (handlers) => contacts.listen(handlers),
    },
    paneAsks: {
      listen: (present) => {
        presenter = present;
        return () => {
          if (presenter !== present) return;
          presenter = undefined;
          stopAsks().catch(Fn.constVoid);
        };
      },
    },
  };
}
