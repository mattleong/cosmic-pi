// @ts-check

/**
 * The launcher of a Rex-hosted subagent. The root spawns it where it would spawn a headless Pi,
 * with the same pipes, so the root's process transport, backpressure, and cleanup evidence apply
 * unchanged. It starts Pi interactively in a detached Rex block and carries the conversation
 * between the root's pipes and the child half's socket:
 *
 *   stdout / stdin   backend events and commands (`R` frames)
 *   process IPC      parent-contact messages (`C` frames)
 *
 * It also carries a questionnaire the root shows the user in the session's open pane (`Q`
 * frames), and takes it back when the pane leaves its window, which only Rex can tell.
 *
 * It exits when the session ends, and it ends the session when the root ends it or goes away:
 * its exit is the root's evidence that the block's Pi is gone. The one exception is parking, where
 * the root asks it to leave an open pane's session alive on the root's own socket.
 *
 * It runs under plain Node, outside Pi and Effect, so it stays small and imports nothing heavier
 * than a predicate.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as Predicate from "effect/Predicate";
import {
  REX_ANSWER_NOTE,
  REX_ASK_MESSAGE,
  REX_FRAME,
  REX_HANDOFF_TIMEOUT_MS,
  REX_SOCKET_ENV,
  REX_TOKEN_ENV,
  rexFrame,
  splitRexFrames,
} from "./rex-session-frames.mjs";

const CONNECT_TIMEOUT_MS = 30_000;
const EXIT_WAIT_MS = 5_000;
/**
 * The root's process transport kills this launcher's whole group 2 seconds after its SIGTERM, Rex
 * CLI calls included, so a session that ending signals must be gone before then.
 */
const SIGNALED_EXIT_WAIT_MS = 1_500;
const EXIT_POLL_MS = 50;

const PANE_WATCH_MS = 2_000;
const REX_TIMEOUT_MS = 10_000;
const TERMINAL_FLAVOR = "com.superlogical.terminal.shell";
/** Lines the launcher itself says to the root, beside the child's own events. */
const NOTE = { block: "pi_subagents_rex_block", listening: "pi_subagents_rex_listening" };
const PARK_COMMAND = "pi_subagents_park";
/** The terminal's own variables are Rex's to set for the block; the root's would mislead it. */
const TERMINAL_ENVIRONMENT =
  /^(?:REX_.*|TERM|TERM_PROGRAM.*|COLORTERM|COLUMNS|LINES|TERMINFO.*|PWD|OLDPWD|SHLVL|_)$/u;
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * @param {string} text
 * @returns {unknown}
 */
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {string | undefined}
 */
const stringField = (value, key) =>
  Predicate.hasProperty(value, key) && Predicate.isString(value[key]) ? value[key] : undefined;

/**
 * @param {unknown} value
 * @returns {string[]}
 */
const stringList = (value) =>
  Array.isArray(value) ? value.filter((entry) => Predicate.isString(entry)) : [];

const rawConfig = parseJson(process.argv[2] ?? "");
const config = {
  /** The Rex CLI. */
  rex: stringField(rawConfig, "rex") ?? "rex",
  /** The Rex session that holds the block. */
  session: stringField(rawConfig, "session") ?? "",
  label: stringField(rawConfig, "label") ?? "subagent",
  cwd: stringField(rawConfig, "cwd") ?? process.cwd(),
  /** Pi and its arguments. */
  command: stringList(Predicate.hasProperty(rawConfig, "command") ? rawConfig.command : []),
  /** A parked session's block to serve instead of starting one. */
  adoptBlock: stringField(rawConfig, "adoptBlock"),
};

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pisa-"));
const socketPath = path.join(directory, "s");
const token = randomBytes(24).toString("hex");

/** @type {net.Socket | undefined} */
let child;
/** @type {number | undefined} */
let childPid;
let block = config.adoptBlock;
/** Rex's answer to the block's creation, while one may still come. @type {Promise<unknown> | undefined} */
let creating;
let ending = false;
let parked = false;
/** A park was asked for: the root's own termination must wait for the child's answer. */
let parking = false;
/** Root commands that arrived before the child connected. @type {string[]} */
const pending = [];
/** The questionnaires the child is showing in its pane, by ID. @type {Set<string>} */
const asking = new Set();
/** Deadlines awaiting the child's terminal receipt. @type {Map<string, NodeJS.Timeout>} */
const withdrawing = new Map();
let watching = false;

/**
 * @param {string[]} args
 * @param {number} [timeout]
 * @returns {Promise<string>}
 */
const rex = (args, timeout = REX_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    execFile(config.rex, args, { timeout, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(new Error(error.message));
      else resolve(stdout);
    });
  });

/**
 * Settles with `promise`, or once `deadline` passes.
 * @param {Promise<unknown>} promise
 * @param {number} deadline
 * @returns {Promise<unknown>}
 */
const until = (promise, deadline) =>
  Promise.race([
    promise.catch(() => undefined),
    new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, deadline - Date.now()));
    }),
  ]);

/** @param {object} value */
const note = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolves once `pid` is gone, killing it when it outlasts the deadline.
 * @param {number} pid
 * @param {number} deadline
 * @returns {Promise<void>}
 */
const gone = (pid, deadline) => {
  if (!alive(pid)) return Promise.resolve();
  if (Date.now() >= deadline) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, EXIT_POLL_MS);
  }).then(() => gone(pid, deadline));
};

/**
 * Closes the block and waits for its Pi to be gone, which is what this process's exit attests. A
 * block Rex is still creating is waited for, so that it can be closed too.
 * @param {number} deadline
 */
const endSession = (deadline) =>
  until(creating ?? Promise.resolve(), deadline)
    .then(() => {
      // Without a block to close, the session goes the way a lost launcher's does.
      if (!block) {
        child?.destroy();
        return undefined;
      }
      return rex(
        ["block", "close", "-s", config.session, block],
        Math.max(1, Math.min(REX_TIMEOUT_MS, deadline - Date.now())),
      ).catch(() => undefined);
    })
    .then(() => (childPid === undefined ? undefined : gone(childPid, deadline)));

/**
 * @param {number} code
 * @param {string} [reason]
 * @param {number} [wait] How long the session may take to end.
 */
const finish = (code, reason, wait = EXIT_WAIT_MS) => {
  if (ending) return;
  ending = true;
  const deadline = Date.now() + wait;
  if (reason) process.stderr.write(`${reason}\n`);
  // A block Rex starts from now on finds neither its environment nor this socket, so it closes
  // itself without starting Pi.
  server.close();
  fs.rmSync(directory, { recursive: true, force: true });
  const leave = () => process.exit(code);
  if (parked)
    process.stdout.end(leave); // flush preceding questionnaire receipts before exit
  else if (config.adoptBlock && !child)
    leave(); // never close a block we did not adopt
  else endSession(deadline).then(leave).catch(leave);
};

/** A single-quoted POSIX shell word. @param {string} value */
const quoted = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

const writeEnvironment = () => {
  const file = path.join(directory, "env");
  const lines = Object.entries({
    ...process.env,
    [REX_SOCKET_ENV]: socketPath,
    [REX_TOKEN_ENV]: token,
  }).flatMap(([name, value]) =>
    value !== undefined && SHELL_NAME.test(name) && !TERMINAL_ENVIRONMENT.test(name)
      ? [`export ${name}=${quoted(value)}`]
      : [],
  );
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return file;
};

/**
 * What the block runs: `rex session environment pi...`. The environment reaches Pi through a
 * private file a subshell reads and removes, never through the block's command line, which every
 * process on the machine can read. Rex keeps a block whose program exits quickly, and may create
 * this one after the launcher ended without hearing of it, its file gone and its Pi unable to
 * connect. So the block's own shell, which no signal to the launcher's process group reaches,
 * closes the block once Pi is gone or never started.
 */
const BLOCK_SCRIPT =
  '(. "$3" && rm -f "$3" && shift 3 && exec "$@"); exec "$1" block close -s "$2" "$REX_BLOCK"';

const startBlock = () =>
  rex([
    "api",
    "call",
    "session.new_block",
    JSON.stringify({
      session_id: config.session,
      flavor: TERMINAL_FLAVOR,
      label: config.label.slice(0, 128),
      options: {
        shell: "none",
        cwd: config.cwd,
        command: [
          "/bin/sh",
          "-c",
          BLOCK_SCRIPT,
          "pi-subagent",
          config.rex,
          config.session,
          writeEnvironment(),
          ...config.command,
        ],
      },
    }),
  ]).then((output) => {
    const created = stringField(parseJson(output), "block_id");
    if (created === undefined) throw new Error("Rex created no block.");
    block = created;
    return created;
  });

/** @param {string} id */
const withdrawAsk = (id) => {
  // The user's answer may already be on its way. Only the child can acknowledge withdrawal.
  if (!asking.has(id) || withdrawing.has(id)) return;
  child?.write(rexFrame(REX_FRAME.ask, { id, withdraw: true }));
  // If the connected Pi no longer responds, end its session before anyone reopens the ask.
  withdrawing.set(
    id,
    setTimeout(
      () => finish(1, "The subagent's pane did not release its questionnaire."),
      REX_HANDOFF_TIMEOUT_MS,
    ).unref(),
  );
};

/** Whether a window shows the block now; true when Rex couldn't say. */
const paneOpen = () =>
  rex(["api", "call", "session.list_blocks", JSON.stringify({ session_id: config.session })]).then(
    (output) => {
      const listed = parseJson(output);
      /** @type {unknown[]} */
      const blocks =
        Predicate.hasProperty(listed, "blocks") && Array.isArray(listed.blocks)
          ? listed.blocks
          : [];
      const own = blocks.find((entry) => stringField(entry, "block_id") === block);
      return own === undefined || stringField(own, "placement") === "placed";
    },
    () => true,
  );

/**
 * A questionnaire in a pane no window shows can't be answered, and only Rex knows when the user
 * hides one. While any is pending, the pane is checked, and they go back to the root when it left.
 */
const watchPane = () => {
  if (watching || asking.size === 0) return;
  watching = true;
  setTimeout(() => {
    const checked = [...asking];
    paneOpen()
      .then((open) => {
        watching = false;
        if (!open) for (const id of checked) withdrawAsk(id);
        return watchPane();
      })
      .catch(() => undefined);
  }, PANE_WATCH_MS).unref();
};

/** @param {unknown} ask The root's `ask` frame for the child. */
const askFromRoot = (ask) => {
  const id = stringField(ask, "id");
  if (id === undefined) return;
  if (Predicate.hasProperty(ask, "withdraw")) {
    withdrawAsk(id);
    return;
  }
  if (parking || ending || !child || !block) {
    note({ type: REX_ANSWER_NOTE, answer: { id, declined: true } });
    return;
  }
  asking.add(id);
  child.write(rexFrame(REX_FRAME.ask, ask));
  // The question is for the user, so the pane that shows it takes the focus; failing to is harmless.
  rex(["block", "focus", "-s", config.session, block]).catch(() => undefined);
  watchPane();
};

/** @param {string} line One command from the root. */
const fromRoot = (line) => {
  if (line.startsWith(`{"type":"${PARK_COMMAND}"`)) {
    const target = parseJson(line);
    parking = true;
    child?.write(
      rexFrame(REX_FRAME.park, {
        socket: stringField(target, "socket"),
        token: stringField(target, "token"),
      }),
    );
    setTimeout(() => {
      parking = false;
      finish(0);
    }, REX_HANDOFF_TIMEOUT_MS).unref();
    return;
  }
  if (child) child.write(`${REX_FRAME.rpc}${line}\n`);
  else pending.push(line);
};

/**
 * @param {net.Socket} socket
 * @param {string} kind
 * @param {string} body
 */
const fromChild = (socket, kind, body) => {
  if (kind === REX_FRAME.rpc) {
    if (!process.stdout.write(`${body}\n`)) {
      socket.pause();
      process.stdout.once("drain", () => socket.resume());
    }
  } else if (kind === REX_FRAME.contact) {
    const contact = parseJson(body);
    if (Predicate.isObject(contact)) process.send?.(contact);
  }
  // The child's word on a questionnaire the root sent it; once it has settled, it is no longer watched.
  else if (kind === REX_FRAME.ask) {
    const answer = parseJson(body);
    const id = stringField(answer, "id");
    if (id === undefined || !asking.has(id)) return;
    if (!Predicate.hasProperty(answer, "shown")) {
      asking.delete(id);
      clearTimeout(withdrawing.get(id));
      withdrawing.delete(id);
    }
    note({ type: REX_ANSWER_NOTE, answer });
  }
  // The user asked, inside the session, to hide its pane: the block leaves its window and runs on.
  else if (kind === REX_FRAME.hide) {
    if (block)
      rex([
        "api",
        "call",
        "session.detach_block",
        JSON.stringify({ session_id: config.session, block_id: block }),
      ]).catch(() => undefined);
  }
  // The child now waits on the root's socket; its block stays, and this launcher's part is over.
  else if (kind === REX_FRAME.park && parking && !ending) {
    const receipt = parseJson(body);
    parked = Predicate.hasProperty(receipt, "ok") && receipt.ok === true;
    finish(parked ? 0 : 1, parked ? undefined : "The subagent's session could not park.");
  }
};

/**
 * The child's first frame names it; anything else, or a second child, is turned away.
 * @param {string} kind
 * @param {string} body
 * @returns {number | undefined} The child's process ID.
 */
const greeting = (kind, body) => {
  const hello = kind === REX_FRAME.hello ? parseJson(body) : undefined;
  if (child || ending || stringField(hello, "token") !== token) return undefined;
  return Predicate.hasProperty(hello, "pid") && Predicate.isNumber(hello.pid)
    ? hello.pid
    : undefined;
};

const server = net.createServer((socket) => {
  let buffered = "";
  let greeted = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    const { frames, rest } = splitRexFrames(buffered + String(chunk));
    buffered = rest;
    for (const frame of frames) {
      if (greeted) {
        fromChild(socket, frame.kind, frame.body);
        continue;
      }
      const pid = greeting(frame.kind, frame.body);
      if (pid === undefined) {
        socket.destroy();
        return;
      }
      greeted = true;
      child = socket;
      childPid = pid;
      socket.write(rexFrame(REX_FRAME.accept, { ok: true }));
      for (const line of pending.splice(0)) socket.write(`${REX_FRAME.rpc}${line}\n`);
    }
  });
  socket.on("error", () => undefined);
  socket.on("close", () => {
    if (socket === child && !parked)
      finish(ending ? 0 : 1, "The subagent's Pi session ended; its Rex pane may have been closed.");
  });
});

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const lines = (input + String(chunk)).split("\n");
  input = lines.pop() ?? "";
  for (const line of lines) if (line) fromRoot(line);
});
// The root closing its end, or disappearing, ends the session with it.
const rootLeft = () => {
  if (!parking) finish(0);
};
const rootSignaled = () => {
  if (!parking) finish(0, undefined, SIGNALED_EXIT_WAIT_MS);
};
process.stdin.on("end", rootLeft);
process.on("disconnect", rootLeft);
process.on("SIGTERM", rootSignaled);
process.on("SIGINT", rootSignaled);
process.on("message", (message) => {
  if (stringField(message, "type") === REX_ASK_MESSAGE)
    askFromRoot(Predicate.hasProperty(message, "ask") ? message.ask : undefined);
  else child?.write(rexFrame(REX_FRAME.contact, message));
});

server.listen(socketPath, () => {
  note({ type: NOTE.listening, socket: socketPath, token });
  setTimeout(() => {
    if (!child) finish(1, "The subagent's Pi session did not start in its Rex block.");
  }, CONNECT_TIMEOUT_MS).unref();
  if (ending) return;
  creating = block ? Promise.resolve(block) : startBlock();
  creating
    .then((blockId) => (ending ? undefined : note({ type: NOTE.block, blockId })))
    .catch((/** @type {unknown} */ error) =>
      finish(1, `Rex could not start the subagent's block: ${String(error)}`),
    );
});
