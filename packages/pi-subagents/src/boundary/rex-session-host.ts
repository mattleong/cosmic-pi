import type { Socket } from "node:net";
import { writerViewConnection, type OpenWriterView } from "./rex-writer-view.ts";
import { fileURLToPath } from "node:url";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { invokeBestEffort, invokeHostCallback } from "pi-cosmic-core/host-session";
import { synchronousRandomHex } from "pi-cosmic-core/platform/native-crypto";
import {
  nodeCreateServer,
  nodeFs,
  nodePath,
  nodeSpawnSync,
  nodeTemporaryRoot,
} from "pi-cosmic-core/platform/node-builtins";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import {
  REX_ANSWER_NOTE,
  REX_ASK_MESSAGE,
  REX_FRAME,
  rexFrame,
  splitRexFrames,
} from "./rex-session-frames.mjs";

/**
 * The root's side of Rex-hosted subagents: which runs have a block, whether its pane is open, and
 * the sessions parked on the root's own socket. A hosted run's Pi is a real interactive session
 * in a Rex block that no window shows until the user opens it. The root still owns the run: the
 * launcher it spawns in place of a headless Pi answers to the same process transport, and a
 * parked session is inert until the root resumes its run.
 */

const RELAY_PATH = fileURLToPath(new URL("./rex-relay.mjs", import.meta.url));
const REX_TIMEOUT_MS = 5_000;
const MAX_FRAME_BUFFER_CHARS = 1024 * 1024;

export type RexPaneState = "hidden" | "open";

/**
 * Leads the label of every block that hosts a subagent, so the user's Rex configuration can tell
 * such a pane from any other and hide it where it would close one.
 */
export const REX_SUBAGENT_LABEL_PREFIX = "subagent: ";

interface RexEntry {
  blockId?: string | undefined;
  /** Whether the pane was open when Rex was last asked; the user can hide it in Rex itself. */
  placed: boolean;
  /** The parked session's connection and the token it must name. */
  parkToken?: string | undefined;
  parked?: Socket | undefined;
  /** A launcher is taking the parked session back, so its connection closing is expected. */
  adopting: boolean;
  /** Speaks to the run's launcher, while it has one. */
  send?: ((message: RexLauncherMessage) => void) | undefined;
}

/** What the root says to a run's launcher beside the backend's own channel. */
export interface RexLauncherMessage {
  readonly type: typeof REX_ASK_MESSAGE;
  readonly ask:
    | { readonly id: string; readonly request: Schema.Json }
    | { readonly id: string; readonly withdraw: true };
}

export interface RexPaneAskHandlers {
  /** Runs when the questionnaire is on screen in the pane. */
  readonly shown: () => void;
  readonly settled: (outcome: Schema.Json | undefined) => void;
}

/** A questionnaire a run's pane is showing for the root. */
interface PaneAsk {
  readonly runId: string;
  readonly shown: () => void;
  readonly settle: (outcome: Schema.Json | undefined) => void;
  readonly withdraw: () => void;
}

/** What a launch needs in place of Pi's own command: the launcher and its configuration. */
export interface RexLaunch {
  readonly args: ReadonlyArray<string>;
}

export interface RexSessionHost {
  /** Whether the setting asks for Rex-hosted sessions; they also need Pi to run inside Rex. */
  readonly setEnabled: (enabled: boolean) => void;
  readonly isEnabled: () => boolean;
  /** Whether this Pi runs where Rex can host sessions. */
  readonly isAvailable: () => boolean;
  /** The launcher for a run's Pi `command`, or `undefined` to start it headless. */
  readonly launch: (
    run: { readonly runId: string; readonly name: string; readonly cwd: string },
    command: ReadonlyArray<string>,
  ) => RexLaunch | undefined;
  /** Reads what a run's launcher says about itself, beside the child's own events. */
  readonly observe: (runId: string, value: Schema.Json) => void;
  /** Gives the host a way to speak to a run's launcher, for as long as the run has one. */
  readonly attach: (runId: string, send: (message: RexLauncherMessage) => void) => void;
  /**
   * Shows the user a questionnaire in a run's open pane, which takes the focus. `settled` runs
   * once with what the session answered, or with `undefined` when the pane isn't open or leaves
   * its window before the user answers: the caller then asks somewhere the user can see. The
   * returned function takes the questionnaire back.
   */
  readonly ask: (
    runId: string,
    request: Schema.Json,
    handlers: RexPaneAskHandlers,
  ) => () => Effect.Effect<void>;
  /** Where a run's session should wait instead of ending, when its pane is open. */
  readonly parkTarget: (
    runId: string,
  ) => { readonly socket: string; readonly token: string } | undefined;
  /** A run's launcher is gone; its block went with it unless the session parked. */
  readonly released: (runId: string) => void;
  readonly pane: (runId: string) => RexPaneState | undefined;
  /** Shows a hidden session beside the root's pane, or hides an open one. False when Rex refused. */
  readonly togglePane: (runId: string) => boolean;
  /** A display of a headless writer; never hosts or parks the writer itself. */
  readonly toggleWriterView: (runId: string, name: string, open: OpenWriterView) => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  /** Tells the user, in a parked session's own pane, why their words went nowhere. */
  readonly notify: (runId: string, message: string) => void;
  /** Whether an open pane's session may park: not while the runtime that owns it is ending. */
  readonly setParking: (allowed: boolean) => void;
  readonly close: () => void;
}

const decodeNote = decodeUnknownOrUndefined(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("pi_subagents_rex_block"), blockId: Schema.String }),
    Schema.Struct({
      type: Schema.Literal("pi_subagents_rex_listening"),
      socket: Schema.String,
      token: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal(REX_ANSWER_NOTE),
      answer: Schema.Struct({
        id: Schema.String,
        shown: Schema.optional(Schema.Boolean),
        declined: Schema.optional(Schema.Boolean),
        outcome: Schema.optional(Schema.Json),
      }),
    }),
  ]),
);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const decodeHello = decodeUnknownOrUndefined(
  Schema.Struct({ token: Schema.String, parked: Schema.Literal(true) }),
);
const decodeTransfer = decodeUnknownOrUndefined(Schema.Struct({ ok: Schema.Boolean }));
const decodeResume = decodeUnknownOrUndefined(Schema.Struct({ text: Schema.String }));

export interface RexSessionHostOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** The user typed into a parked session: the run's next assignment, for its owner to start. */
  readonly onResume: (runId: string, text: string) => void;
  /** Runs the Rex CLI and returns its output, or `undefined` when it failed. */
  readonly rex?:
    | ((executable: string, args: ReadonlyArray<string>) => string | undefined)
    | undefined;
}

const runRex = (executable: string, args: ReadonlyArray<string>): string | undefined =>
  invokeHostCallback(() => {
    const result = nodeSpawnSync(executable, [...args], {
      timeout: REX_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout : undefined;
  }, undefined);

const decodeSplit = decodeUnknownOrUndefined(
  Schema.fromJsonString(Schema.Struct({ block_ids: Schema.Array(Schema.String) })),
);
const decodeBlocks = decodeUnknownOrUndefined(
  Schema.fromJsonString(
    Schema.Struct({
      blocks: Schema.Array(Schema.Struct({ block_id: Schema.String, placement: Schema.String })),
    }),
  ),
);

/** Whether a run's pane is open, by what Rex shows now, or by what it last showed. */
const refreshPlacement = (entry: RexEntry, placed: ReadonlySet<string> | undefined): boolean => {
  if (placed && entry.blockId) entry.placed = placed.has(entry.blockId);
  return entry.placed;
};

export function rexSessionHost(options: RexSessionHostOptions): RexSessionHost {
  const environment = options.environment ?? process.env;
  const session = environment.REX_SESSION;
  const anchor = environment.REX_BLOCK;
  const executable = environment.REX_BIN_DIR
    ? nodePath.join(environment.REX_BIN_DIR, "rex")
    : "rex";
  const rexOutput = (args: ReadonlyArray<string>) => (options.rex ?? runRex)(executable, args);
  const rex = (args: ReadonlyArray<string>): boolean => rexOutput(args) !== undefined;
  const call = (method: string, input: Readonly<Record<string, string>>) => [
    "api",
    "call",
    method,
    JSON.stringify({ session_id: session, ...input }),
  ];
  const api = (method: string, input: Readonly<Record<string, string>>) => rex(call(method, input));
  /**
   * Which of the session's blocks a window shows now. The user hides and closes panes in Rex
   * itself, so only Rex knows; `undefined` when it couldn't say.
   */
  const placedBlocks = (): ReadonlySet<string> | undefined => {
    const listed = decodeBlocks(rexOutput(call("session.list_blocks", {})));
    return (
      listed &&
      new Set(
        Arr.map(
          Arr.filter(listed.blocks, (block) => block.placement === "placed"),
          (block) => block.block_id,
        ),
      )
    );
  };
  const isOpen = (entry: RexEntry): boolean => refreshPlacement(entry, placedBlocks());

  const entries = new Map<string, RexEntry>();
  const views = new Map<string, { readonly block: string; readonly close: () => void }>();
  const asks = new Map<string, PaneAsk>();
  const listeners = new Set<() => void>();
  let enabled = false;
  let parking = true;
  let closed = false;
  let park: { readonly directory: string; readonly socket: string; close: () => void } | undefined;

  const changed = (): void => {
    for (const listener of listeners) invokeBestEffort(listener);
  };
  const entryOf = (runId: string): RexEntry => {
    const existing = entries.get(runId);
    if (existing) return existing;
    const created: RexEntry = { placed: false, adopting: false };
    entries.set(runId, created);
    return created;
  };
  const forget = (runId: string): void => {
    if (entries.delete(runId)) changed();
  };
  /** Takes back the questionnaires a run's pane shows: no one can answer them there any more. */
  const withdrawAsks = (runId: string): void => {
    for (const ask of asks.values()) if (ask.runId === runId) ask.withdraw();
  };
  const closeBlock = (entry: RexEntry): void => {
    if (entry.blockId && session) rex(["block", "close", "-s", session, entry.blockId]);
  };

  const receiveParked = (socket: Socket, kind: string, body: string): void => {
    const value = Option.getOrUndefined(decodeJson(body));
    if (kind === REX_FRAME.hello) {
      const hello = decodeHello(value);
      for (const [, entry] of entries)
        if (
          !closed &&
          parking &&
          hello &&
          entry.parkToken === hello.token &&
          !entry.parked &&
          isOpen(entry)
        ) {
          entry.parked = socket;
          entry.parkToken = undefined;
          socket.write(rexFrame(REX_FRAME.accept, { ok: true }));
          changed();
          return;
        }
      socket.destroy();
      return;
    }
    if (kind === REX_FRAME.adopt) {
      const receipt = decodeTransfer(value);
      for (const entry of entries.values()) {
        if (entry.parked !== socket || !entry.adopting || !receipt) continue;
        entry.adopting = false;
        // Only a successful receipt releases our parked link. A refused candidate can retry.
        if (receipt.ok) entry.parked = undefined;
      }
      return;
    }
    // Hidden from inside, a parked session has no reader left, as when Activity hides it.
    if (kind === REX_FRAME.hide) {
      for (const entry of entries.values()) if (entry.parked === socket) closeBlock(entry);
      return;
    }
    if (kind !== REX_FRAME.resume) return;
    const resume = decodeResume(value);
    for (const [runId, entry] of entries)
      if (resume && entry.parked === socket)
        invokeBestEffort(() => options.onResume(runId, resume.text));
  };
  const parkServer = () => {
    if (park) return park;
    const directory = nodeFs.mkdtempSync(nodePath.join(nodeTemporaryRoot(), "pisa-"));
    const socketPath = nodePath.join(directory, "park");
    const server = nodeCreateServer((socket) => {
      let buffered = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        const { frames, rest } = splitRexFrames(buffered + chunk);
        // A parked session only ever says a line of the user's; anything larger isn't one.
        buffered = rest.length > MAX_FRAME_BUFFER_CHARS ? "" : rest;
        for (const frame of frames) receiveParked(socket, frame.kind, frame.body);
      });
      socket.on("error", Fn.constVoid);
      socket.on("close", () => {
        for (const [runId, entry] of entries) {
          if (entry.parked !== socket) continue;
          entry.parked = undefined;
          forget(runId);
        }
      });
    });
    server.listen(socketPath);
    park = {
      directory,
      socket: socketPath,
      close: () => {
        server.close();
        nodeFs.rmSync(directory, { recursive: true, force: true });
      },
    };
    return park;
  };

  const isAvailable = (): boolean => Boolean(session && anchor);
  const closeViews = () => {
    for (const view of views.values()) view.close();
  };

  return {
    setEnabled: (value) => {
      if (enabled === value) return;
      enabled = value;
      if (!enabled) closeViews();
      changed();
    },
    isEnabled: () => enabled,
    isAvailable,
    launch: (run, command) => {
      const parked = entries.get(run.runId);
      const adoptBlock = parked?.parked ? parked.blockId : undefined;
      if (closed || !session || !isAvailable() || (!enabled && !adoptBlock)) return undefined;
      // A parked session the user has since hidden in Rex has no reader left; each launch is a
      // moment to end the ones that aren't this run's own.
      const waiting = Arr.filter([...entries.values()], (entry) => entry.parked !== undefined);
      if (waiting.length > 0) {
        const placed = placedBlocks();
        for (const entry of waiting)
          if (entry !== parked && placed && !refreshPlacement(entry, placed)) closeBlock(entry);
      }
      entryOf(run.runId);
      return {
        args: [
          RELAY_PATH,
          JSON.stringify({
            rex: executable,
            session,
            label: Fn.pipe(`${REX_SUBAGENT_LABEL_PREFIX}${run.name}`, Str.slice(0, 128)),
            cwd: run.cwd,
            command,
            ...(adoptBlock && { adoptBlock }),
          }),
        ],
      };
    },
    observe: (runId, value) => {
      const note = decodeNote(value);
      const entry = entries.get(runId);
      if (!note || !entry) return;
      if (note.type === "pi_subagents_rex_block") {
        entry.blockId = note.blockId;
        changed();
        return;
      }
      if (note.type === REX_ANSWER_NOTE) {
        const ask = asks.get(note.answer.id);
        if (ask?.runId !== runId) return;
        if (note.answer.shown) invokeBestEffort(ask.shown);
        else ask.settle(note.answer.declined ? undefined : note.answer.outcome);
        return;
      }
      // The launcher of a resumed run takes its parked session back.
      const parked = entry.parked;
      if (!parked || entry.adopting) return;
      entry.adopting = true;
      invokeBestEffort(() =>
        parked.write(rexFrame(REX_FRAME.adopt, { socket: note.socket, token: note.token })),
      );
    },
    attach: (runId, send) => {
      const entry = entries.get(runId);
      if (entry) entry.send = (message) => invokeBestEffort(() => send(message));
    },
    ask: (runId, request, handlers) => {
      const entry = entries.get(runId);
      const send = entry?.send;
      if (closed || !send || !entry?.blockId || entry.parkToken || entry.parked || !isOpen(entry)) {
        invokeBestEffort(() => handlers.settled(undefined));
        return () => Effect.void;
      }
      const id = synchronousRandomHex(12);
      let withdrawn = false;
      const settled = Deferred.makeUnsafe<void>();
      const settle = (outcome: Schema.Json | undefined) => {
        if (!asks.delete(id)) return;
        Deferred.doneUnsafe(settled, Effect.void);
        invokeBestEffort(() => handlers.settled(outcome));
      };
      const withdraw = () => {
        if (asks.has(id) && !withdrawn) {
          withdrawn = true;
          send({ type: REX_ASK_MESSAGE, ask: { id, withdraw: true } });
        }
      };
      const shown = () => {
        if (!withdrawn) handlers.shown();
      };
      asks.set(id, { runId, shown, settle, withdraw });
      send({ type: REX_ASK_MESSAGE, ask: { id, request } });
      return () => {
        withdraw();
        return Deferred.await(settled);
      };
    },
    parkTarget: (runId) => {
      const entry = entries.get(runId);
      if (
        closed ||
        !parking ||
        !entry?.blockId ||
        entry.parkToken ||
        entry.parked ||
        !isOpen(entry)
      )
        return undefined;
      return invokeHostCallback(() => {
        const token = synchronousRandomHex(24);
        const { socket } = parkServer();
        entry.parkToken = token;
        return { socket, token };
      }, undefined);
    },
    released: (runId) => {
      const entry = entries.get(runId);
      if (!entry) return;
      // The launcher that carried them is gone, so its pane's questionnaires go back to the caller.
      entry.send = undefined;
      for (const ask of asks.values()) if (ask.runId === runId) ask.settle(undefined);
      // A parked session keeps its block until its pane closes or a launcher takes it back.
      if (entry.parked) return;
      forget(runId);
    },
    pane: (runId) => {
      if (views.has(runId)) return "open";
      const entry = entries.get(runId);
      if (!entry?.blockId) return undefined;
      return entry.placed ? "open" : "hidden";
    },
    toggleWriterView: (runId, name, open) => {
      if (!enabled || closed || !parking || !session || !anchor) return false;
      const previous = views.get(runId);
      if (previous) {
        const placed = placedBlocks();
        if (!placed) return false;
        if (placed.has(previous.block)) {
          previous.close();
          return true;
        }
        // Rex may have detached it via a user keybinding; reveal the existing screen.
        if (
          !api("session.move_block", {
            block_id: previous.block,
            anchor_block_id: anchor,
            direction: "horizontal",
          })
        ) {
          previous.close();
          return false;
        }
        rex(["block", "focus", "-s", session, previous.block]);
        return true;
      }
      return invokeHostCallback(() => {
        const connection = writerViewConnection(executable, open, () => {
          views.delete(runId);
          changed();
        });
        const result = decodeSplit(
          rexOutput([
            "split",
            "-s",
            session,
            "-b",
            anchor,
            "--split=right",
            "--shell=none",
            "-c",
            nodeTemporaryRoot(),
            "--label",
            Fn.pipe(`${REX_SUBAGENT_LABEL_PREFIX}${name}`, Str.slice(0, 128)),
            "--json",
            "--",
            ...connection.command,
          ]),
        );
        const block = result?.block_ids[0];
        if (!block) {
          connection.close();
          return false;
        }
        views.set(runId, { block, close: connection.close });
        changed();
        return true;
      }, false);
    },
    togglePane: (runId) => {
      const entry = entries.get(runId);
      if (!entry?.blockId || !anchor) return false;
      if (!isOpen(entry)) {
        const placed = api("session.move_block", {
          block_id: entry.blockId,
          anchor_block_id: anchor,
          direction: "horizontal",
        });
        entry.placed = placed;
        // The user opened the pane to use it, so it takes the focus; failing to is harmless.
        if (placed && session) rex(["block", "focus", "-s", session, entry.blockId]);
        changed();
        return placed;
      }
      // Nothing reads a parked session once its pane closes, so hiding it ends it.
      if (entry.parked) {
        closeBlock(entry);
        return true;
      }
      const hidden = api("session.detach_block", { block_id: entry.blockId });
      if (hidden) {
        entry.placed = false;
        withdrawAsks(runId);
      }
      changed();
      return hidden;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: (runId, message) => {
      const parked = entries.get(runId)?.parked;
      if (parked) invokeBestEffort(() => parked.write(rexFrame(REX_FRAME.notice, { message })));
    },
    setParking: (allowed) => {
      parking = allowed;
      if (!allowed) closeViews();
    },
    close: () => {
      if (closed) return;
      closed = true;
      closeViews();
      for (const ask of asks.values()) ask.settle(undefined);
      for (const entry of entries.values())
        if (entry.parked) {
          entry.parked.destroy();
          closeBlock(entry);
        }
      entries.clear();
      invokeBestEffort(() => park?.close());
      listeners.clear();
    },
  };
}
