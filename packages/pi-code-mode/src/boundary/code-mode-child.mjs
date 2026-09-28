// Runs one Code Mode program in a fresh Node process. Pi spawns this module with the session's
// working directory; fd 3 carries length-prefixed JSON frames and fd 4 is a lifetime lease
// watched by a worker. The program is an async function body with ordinary Node semantics.
// Tool calls are sent to Pi, which owns validation, execution and every diagnostic's wording.
import * as nodeModule from "node:module";
import { Socket } from "node:net";
import { join } from "node:path";
import * as vm from "node:vm";
import { Worker } from "node:worker_threads";

const MAX_CALL_FRAME_BYTES = 16 * 1024 * 1024 + 4096;
/** Pi's frame ceiling, less room for the result envelope. */
const MAX_RESULT_FRAME_BYTES = 17 * 1024 * 1024 - 4096;
const MAX_TEXT = 65_536;
const FILENAME = join(process.cwd(), "[code_mode]");
const LOCATION = /\[code_mode\]:(\d+):(\d+)/;

// Pi's death reaches the watchdog as EOF on fd 4, even while this thread is stuck in a loop.
const watchdog = new Worker(new URL("./code-mode-watchdog.mjs", import.meta.url), {
  execArgv: [],
  stdout: false,
  stderr: false,
});
watchdog.unref();
const watchdogReady = new Promise((resolve, reject) => {
  watchdog.once("message", resolve);
  watchdog.once("error", reject);
  watchdog.once("exit", reject);
});

const channel = new Socket({ fd: 3, readable: true, writable: true });
channel.on("error", () => process.exit(1));
channel.on("end", () => process.exit(1));

const objectTag = Object.prototype.toString;
const isObject = (value) => value !== null && Object(value) === value;
const isString = (value) => !isObject(value) && objectTag.call(value) === "[object String]";

const encodeFrame = (message) => {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
};

// ---- inbound frames

let chunks = [];
let buffered = 0;
let expected;
const take = (count) => {
  const joined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
  const out = joined.subarray(0, count);
  const rest = joined.subarray(count);
  chunks = rest.byteLength > 0 ? [rest] : [];
  buffered = rest.byteLength;
  return out;
};
channel.on("data", (chunk) => {
  chunks.push(chunk);
  buffered += chunk.byteLength;
  for (;;) {
    if (expected === undefined) {
      if (buffered < 4) return;
      expected = take(4).readUInt32BE(0);
    }
    if (buffered < expected) return;
    const body = take(expected);
    expected = undefined;
    receive(JSON.parse(body.toString("utf8")));
  }
});

const receive = (message) => {
  if (message.type === "start") void start(message);
  else if (message.type === "reply") settle(message);
  else if (message.type === "finish") process.exit(0);
};

// ---- diagnostics

const text = (value) => {
  try {
    if (isString(value)) return value.slice(0, MAX_TEXT);
    const json = JSON.stringify(value);
    return (json === undefined ? String(value) : json).slice(0, MAX_TEXT);
  } catch {
    try {
      return String(value).slice(0, MAX_TEXT);
    } catch {
      return "a value that could not be printed";
    }
  }
};

const read = (target, key) => {
  try {
    return target[key];
  } catch {
    return undefined;
  }
};

const locate = (stack) => {
  const match = isString(stack) ? LOCATION.exec(stack) : null;
  return match === null ? {} : { line: Number(match[1]), column: Number(match[2]) };
};

/**
 * A syntax error's position from V8's `file:line`, source line and caret header. An error
 * found at the end of input points at the wrapper's closing line; report the last line.
 */
const syntaxLocation = (stack, lineCount) => {
  if (!isString(stack)) return {};
  const lines = stack.split("\n");
  const line = /\[code_mode\]:(\d+)$/.exec(lines[0] ?? "");
  if (line === null) return {};
  const number = Number(line[1]);
  if (number < 1) return {};
  if (number > lineCount) return { line: lineCount };
  const caret = (lines[2] ?? "").indexOf("^");
  return caret < 0 ? { line: number } : { line: number, column: caret + 1 };
};

// Errors this runner created, so Pi can explain them without trusting their text.
const toolFailures = new WeakMap();
const localFailures = new WeakMap();

const describe = (error, via) => {
  if (isObject(error)) {
    const seq = toolFailures.get(error);
    if (seq !== undefined) return { kind: "tool", via, seq, ...locate(read(error, "stack")) };
    const local = localFailures.get(error);
    if (local !== undefined) return { ...local, via };
    const message = read(error, "message");
    if (isString(message)) {
      const name = read(error, "name");
      const code = read(error, "code");
      const stack = read(error, "stack");
      // Node's permission refusals name what was refused and the path it applied to. A refused
      // socket or DNS call names only its syscall; the network is what it was denied.
      const permission =
        read(error, "permission") ??
        (code === "ERR_ACCESS_DENIED" && isString(read(error, "syscall")) ? "Net" : undefined);
      const resource = read(error, "resource");
      return {
        kind: "thrown",
        via,
        message: message.slice(0, MAX_TEXT),
        ...(isString(name) && { name: name.slice(0, 256) }),
        ...(isString(code) && { code: code.slice(0, 64) }),
        ...(isString(permission) && { permission: permission.slice(0, 64) }),
        ...(isString(resource) && { resource: resource.slice(0, 4096) }),
        // Node's module loader raised it, for example while resolving an import.
        ...(isString(stack) && stack.includes("node:internal/modules/") && { module: true }),
        ...locate(stack),
      };
    }
  }
  return { kind: "thrown", via, message: text(error) };
};

// ---- tools

let sealed = false;
let nextSeq = 0;
const pending = new Map();
let drainWaiters = [];

// While the program runs, only pending tool calls hold the process open. If it then awaits
// something nothing can settle (no tool call, timer or I/O), Node's event loop empties and
// `beforeExit` reports the stall instead of the program waiting out its deadline.
let running = false;
const holdChannel = () => {
  if (running && pending.size === 0) channel.unref();
  else channel.ref();
};

const localError = (kind, message, site, tool) => {
  const error = new Error(message);
  error.name = "CodeModeError";
  const frames = (site.stack ?? "").split("\n").slice(1).join("\n");
  Object.defineProperty(error, "stack", {
    value: `${error.name}: ${message}\n${frames}`,
    configurable: true,
    writable: true,
  });
  localFailures.set(error, { kind, message: message.slice(0, MAX_TEXT), tool, ...locate(frames) });
  return error;
};

const callTool = (path, label, args) => {
  // Captured before anything else so failures point at the program's call.
  const site = new Error();
  if (sealed) {
    return Promise.reject(
      localError(
        "closed",
        `${label} was called after the program finished; it was not sent.`,
        site,
        label,
      ),
    );
  }
  const seq = nextSeq;
  let frame;
  try {
    frame = encodeFrame({ type: "call", seq, path, args });
  } catch (cause) {
    return Promise.reject(
      localError(
        "arguments",
        `Arguments for ${label} must be JSON data: ${text(read(cause, "message") ?? cause)}`,
        site,
        label,
      ),
    );
  }
  if (frame.byteLength > MAX_CALL_FRAME_BYTES) {
    return Promise.reject(
      localError("arguments", `Arguments for ${label} exceed 16 MiB.`, site, label),
    );
  }
  nextSeq += 1;
  return new Promise((resolve, reject) => {
    pending.set(seq, { resolve, reject, site, label });
    holdChannel();
    channel.write(frame);
  });
};

const settle = (message) => {
  const entry = pending.get(message.seq);
  if (entry === undefined) return;
  pending.delete(message.seq);
  holdChannel();
  if (message.ok) entry.resolve(message.value);
  else {
    const error = new Error(message.message);
    error.name = "ToolError";
    error.tool = entry.label;
    error.kind = message.kind;
    const frames = (entry.site.stack ?? "").split("\n").slice(1).join("\n");
    Object.defineProperty(error, "stack", {
      value: `${error.name}: ${message.message}\n${frames}`,
      configurable: true,
      writable: true,
    });
    toolFailures.set(error, message.seq);
    entry.reject(error);
  }
  if (pending.size === 0) for (const wake of drainWaiters.splice(0)) wake();
};

const drained = () =>
  pending.size === 0 ? Promise.resolve() : new Promise((wake) => drainWaiters.push(wake));

const expression = (path) =>
  "tools" +
  path
    .map((segment) =>
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`,
    )
    .join("");

const buildTools = (paths) => {
  const root = {};
  for (const path of paths) {
    let node = root;
    for (const segment of path.slice(0, -1)) {
      if (!Object.hasOwn(node, segment)) node[segment] = {};
      node = node[segment];
    }
    const label = expression(path);
    const name = path.join(".");
    node[path[path.length - 1]] = { [name]: (...args) => callTool(path, label, args) }[name];
  }
  const freeze = (node) => {
    for (const value of Object.values(node)) {
      if (Object.getPrototypeOf(value) === Object.prototype) freeze(value);
    }
    return Object.freeze(node);
  };
  return freeze(root);
};

// ---- rejections that nothing handled

const MAX_TRACKED_REJECTIONS = 10_000;
const unhandled = new Map();
process.on("unhandledRejection", (reason, promise) => {
  if (unhandled.size < MAX_TRACKED_REJECTIONS) unhandled.set(promise, reason);
});
process.on("rejectionHandled", (promise) => unhandled.delete(promise));
let uncaught;
process.on("uncaughtException", (error) => {
  if (uncaught === undefined) uncaught = { error };
  void complete({ ok: false, failure: describe(error, "uncaught") });
});
process.on("beforeExit", () => {
  if (running) void complete({ ok: false, failure: { kind: "stalled" } });
});

// ---- network

// Node 25+ refuses the network under --permission, but earlier versions cannot. Refusing the
// usual entry points here gives every version the same answer; the rest is Node's to refuse.
const networkRefused = () =>
  Object.assign(
    new Error(
      "Code Mode programs can't use the network directly. Use tools.pi.bash, for example with curl, so the request is recorded.",
    ),
    { code: "ERR_ACCESS_DENIED", permission: "Net" },
  );
const refusedNetworkApis = {
  fetch: async () => {
    throw networkRefused();
  },
  WebSocket: function WebSocket() {
    throw networkRefused();
  },
  EventSource: function EventSource() {
    throw networkRefused();
  },
};
for (const [name, value] of Object.entries(refusedNetworkApis)) {
  if (name in globalThis) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
}

// ---- compile and run

const wrap = (body) => `(async function (tools) {\n${body}\n})`;
const scriptOptions = {
  filename: FILENAME,
  lineOffset: -1,
  importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
};
/** JavaScript first; on a syntax error, retry once with TypeScript types stripped. */
const compile = (source) => {
  const lineCount = source.split("\n").length;
  const syntaxFailure = (error) => ({
    kind: "syntax",
    message: text(read(error, "message") ?? error),
    ...syntaxLocation(read(error, "stack"), lineCount),
  });
  try {
    return { run: new vm.Script(wrap(source), scriptOptions).runInThisContext() };
  } catch (javascriptError) {
    if (!(nodeModule.stripTypeScriptTypes instanceof Function)) {
      return { failure: syntaxFailure(javascriptError) };
    }
    let stripped;
    try {
      stripped = nodeModule.stripTypeScriptTypes(wrap(source), { mode: "strip" });
    } catch (typeScriptError) {
      return {
        failure: syntaxFailure(
          read(typeScriptError, "code") === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"
            ? typeScriptError
            : javascriptError,
        ),
      };
    }
    try {
      return { run: new vm.Script(stripped, scriptOptions).runInThisContext() };
    } catch (error) {
      return { failure: syntaxFailure(error) };
    }
  }
};

let resultLimit = 16 * 1024 * 1024;

/** A value's UTF-8 text, cut at a code point boundary within the result limit. */
const fit = (format, value) => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= resultLimit) {
    return { ok: true, format, text: value, totalBytes: bytes.byteLength };
  }
  let end = resultLimit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    ok: true,
    format,
    text: bytes.subarray(0, end).toString("utf8"),
    totalBytes: bytes.byteLength,
  };
};

const serialize = (value) => {
  if (value === undefined) return fit("json", "null");
  if (isString(value)) return fit("text", value);
  try {
    return fit("json", JSON.stringify(value) ?? "null");
  } catch (error) {
    return {
      ok: false,
      failure: { kind: "return", message: text(read(error, "message") ?? error) },
    };
  }
};

const flush = (stream) =>
  new Promise((resolve) => {
    if (stream.destroyed || stream.writableLength === 0) resolve();
    else {
      stream.once("drain", resolve);
      stream.once("close", resolve);
    }
  });

const turn = () => new Promise((resolve) => setImmediate(resolve));

let completing = false;
const complete = async (outcome) => {
  if (completing) return;
  completing = true;
  // The channel holds the process open again until Pi has the result.
  running = false;
  holdChannel();
  // New calls are refused from here; calls already sent still finish and are delivered.
  sealed = true;
  await drained();
  let result = outcome.ok ? serialize(outcome.value) : outcome;
  // Let Node report rejections that nothing handled, including any from serialization.
  await turn();
  await turn();
  if (result.ok) {
    const first = unhandled.values().next();
    if (!first.done) result = { ok: false, failure: describe(first.value, "unhandled") };
    else if (uncaught !== undefined) {
      result = { ok: false, failure: describe(uncaught.error, "uncaught") };
    }
  }
  await flush(process.stdout);
  await flush(process.stderr);
  // JSON escaping can grow text past Pi's frame ceiling; keep halving the kept prefix until it fits.
  let frame = encodeFrame({ type: "result", ...result });
  while (result.ok && frame.byteLength > MAX_RESULT_FRAME_BYTES) {
    const bytes = Buffer.from(result.text, "utf8");
    let end = Math.floor(bytes.byteLength / 2);
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    result = { ...result, text: bytes.subarray(0, end).toString("utf8") };
    frame = encodeFrame({ type: "result", ...result });
  }
  channel.write(frame);
};

const run = async (message) => {
  resultLimit = message.resultLimit;
  try {
    await watchdogReady;
  } catch {
    process.exit(1);
  }
  const tools = buildTools(message.tools);
  const compiled = compile(message.source);
  if (compiled.failure !== undefined) {
    return complete({ ok: false, failure: compiled.failure });
  }
  let outcome;
  try {
    running = true;
    holdChannel();
    outcome = { ok: true, value: await compiled.run(tools) };
  } catch (error) {
    outcome = { ok: false, failure: describe(error, "body") };
  }
  return complete(outcome);
};

// A failure in this runner, not the program, still ends with a result rather than a hang.
const start = (message) =>
  run(message).catch((error) => {
    completing = false;
    return complete({
      ok: false,
      failure: {
        kind: "thrown",
        via: "body",
        message: `Code Mode's program runner failed: ${text(read(error, "message") ?? error)}`,
      },
    });
  });
