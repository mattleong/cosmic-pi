#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

// This helper never consumes ambient credentials or configuration. Local adapters also
// sanitize the runtime process before launching a CLI, since NODE_OPTIONS is applied by Node
// before this module begins executing.
for (const key of Object.keys(process.env)) delete process.env[key];

const VERSION = 1;
const SERVER_NAME = "pi-subagents-supervisor";
const SERVER_VERSION = "1.0.0";
const MAX_CONFIG_BYTES = 4 * 1024;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_MESSAGE_CHARS = 16 * 1024;
const MAX_REPLY_CHARS = 64 * 1024;
const MAX_REPORT_CHARS = 32 * 1024;
const MAX_ID_CHARS = 256;
const MAX_DELIVERY_ID_CHARS = 256;
const MAX_CONCURRENT_CALLS = 16;
const MAX_CHANNEL_CALLS = 32;
const MAX_PENDING_WRITES = 64;
const CHANNEL_TIMEOUT_MILLIS = 10_000;
const CONNECT_TIMEOUT_MILLIS = 5_000;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, allowed, required = []) =>
  object(value) &&
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => own(value, key));
const boundedString = (value, maximum, nonEmpty = true) =>
  typeof value === "string" && value.length <= maximum && (!nonEmpty || value.trim().length > 0);
const validRpcId = (value) =>
  (typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS) ||
  (typeof value === "number" && Number.isSafeInteger(value));
const rpcKey = (value) => `${typeof value}:${String(value)}`;
const validChannelId = (value) =>
  typeof value === "string" && CHANNEL_ID_PATTERN.test(value) && value.length <= 128;
const boundedMetadata = (value, depth = 0) => {
  if (depth > 6) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 4096;
  if (Array.isArray(value))
    return value.length <= 64 && value.every((entry) => boundedMetadata(entry, depth + 1));
  if (!object(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 64 &&
    entries.every(([key, entry]) => key.length <= 128 && boundedMetadata(entry, depth + 1))
  );
};
const validMeta = (params) =>
  params === undefined ||
  (exactKeys(params, ["_meta"]) && (!own(params, "_meta") || boundedMetadata(params._meta)));

const fixedDiagnostic = (message) => {
  const text = boundedString(message, 512) ? message : "Private supervisor helper failed.";
  process.stderr.write(`${text}\n`);
};

const configArgument = () => {
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== "--config" ||
    !boundedString(process.argv[3], 4096) ||
    !isAbsolute(process.argv[3]) ||
    process.argv[3].includes("\0")
  )
    return undefined;
  return resolve(process.argv[3]);
};

const readConfig = async (path) => {
  const directoryStat = await lstat(dirname(path));
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o077) !== 0
  )
    throw new Error("unsafe-config-directory");
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES)
      throw new Error("unsafe-config-file");
    if ((stat.mode & 0o077) !== 0) throw new Error("unsafe-config-mode");
    const source = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES) throw new Error("oversized-config");
    const value = JSON.parse(source);
    if (
      !exactKeys(
        value,
        ["version", "runId", "host", "port", "token"],
        ["version", "runId", "host", "port", "token"],
      ) ||
      value.version !== VERSION ||
      value.host !== "127.0.0.1" ||
      !Number.isSafeInteger(value.port) ||
      value.port < 1 ||
      value.port > 65_535 ||
      typeof value.runId !== "string" ||
      !RUN_ID_PATTERN.test(value.runId) ||
      typeof value.token !== "string" ||
      !TOKEN_PATTERN.test(value.token)
    )
      throw new Error("invalid-config");
    return {
      version: VERSION,
      runId: value.runId,
      host: "127.0.0.1",
      port: value.port,
      token: value.token,
    };
  } finally {
    await handle.close();
  }
};

const makeSerializedWriter = (stream, maximumWrites = MAX_PENDING_WRITES) => {
  let tail = Promise.resolve();
  let pending = 0;
  let closed = false;
  const write = (value) => {
    if (closed || pending >= maximumWrites) return Promise.reject(new Error("write-capacity"));
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
      return Promise.reject(new Error("write-size"));
    pending += 1;
    const operation = tail.then(
      () =>
        new Promise((resolveWrite, rejectWrite) => {
          stream.write(line, "utf8", (error) =>
            error ? rejectWrite(error) : resolveWrite(undefined),
          );
        }),
    );
    tail = operation
      .catch(() => undefined)
      .then(() => {
        pending = Math.max(0, pending - 1);
      });
    return operation;
  };
  return {
    write,
    close: () => {
      closed = true;
    },
  };
};

const attachLineReader = (stream, onLine, onFailure) => {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    buffered = "";
    onFailure();
  };
  const emit = (final) => {
    while (!failed) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      let line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return fail();
      if (line) onLine(line);
    }
    if (failed || Buffer.byteLength(buffered, "utf8") > MAX_LINE_BYTES) return fail();
    if (final && buffered) {
      let line = buffered;
      buffered = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return fail();
      if (line) onLine(line);
    }
  };
  const onData = (chunk) => {
    if (failed) return;
    buffered += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    emit(false);
  };
  const onEnd = () => {
    if (failed) return;
    buffered += decoder.end();
    emit(true);
  };
  stream.on("data", onData);
  stream.once("end", onEnd);
  return () => {
    failed = true;
    stream.off("data", onData);
    stream.off("end", onEnd);
    buffered = "";
  };
};

const constantToken = (expected, value) => {
  const left = Buffer.from(expected, "utf8");
  const right = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.alloc(0);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
};

const connectChannel = (config) =>
  new Promise((resolveConnect, rejectConnect) => {
    const socket = connect({ host: config.host, port: config.port });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectConnect(new Error("connect-timeout"));
    }, CONNECT_TIMEOUT_MILLIS);
    timer.unref();
    const onError = () => {
      clearTimeout(timer);
      rejectConnect(new Error("connect-failed"));
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.setNoDelay(true);
      resolveConnect(socket);
    });
  });

const configPath = configArgument();
if (!configPath) {
  fixedDiagnostic("Private supervisor helper configuration argument is invalid.");
  process.exit(2);
}

let config;
let socket;
try {
  config = await readConfig(configPath);
  socket = await connectChannel(config);
} catch {
  fixedDiagnostic("Private supervisor helper could not open its bounded channel configuration.");
  process.exit(2);
}

const stdout = makeSerializedWriter(process.stdout);
const channelOutput = makeSerializedWriter(socket);
const pendingChannel = new Map();
const activeCalls = new Map();
let assignmentEpoch = 0;
let channelClosed = false;
let initialized = false;

const sendRpc = (message) =>
  stdout.write(message).catch(() => {
    failChannel("stdout_closed");
    socket.destroy();
  });
const rpcError = (id, code, message) => sendRpc({ jsonrpc: "2.0", id, error: { code, message } });
const toolResult = (id, text, isError = false) =>
  sendRpc({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      ...(isError ? { isError: true } : {}),
    },
  });

const failChannel = (code = "channel_closed") => {
  if (channelClosed) return;
  channelClosed = true;
  channelOutput.close();
  for (const pending of pendingChannel.values()) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject({ code, message: "Private supervisor channel closed before delivery settled." });
  }
  pendingChannel.clear();
  process.stdin.destroy();
};

const authenticatedFrame = (value) =>
  exactKeys(value, [
    "version",
    "runId",
    "token",
    "type",
    "id",
    "assignmentEpoch",
    "accepted",
    "duplicate",
    "sequence",
    "code",
    "message",
    "targetRequestId",
    "cancelled",
  ]) &&
  value.version === VERSION &&
  value.runId === config.runId &&
  constantToken(config.token, value.token) &&
  typeof value.type === "string";

const sendChannelFrame = (value) => {
  if (channelClosed) return Promise.reject(new Error("channel-closed"));
  return channelOutput.write({
    version: VERSION,
    runId: config.runId,
    token: config.token,
    ...value,
  });
};

const channelCall = (type, payload, signal, waitsForParent = false) => {
  if (channelClosed || pendingChannel.size >= MAX_CHANNEL_CALLS || assignmentEpoch < 1)
    return Promise.reject({
      code: "channel_unavailable",
      message: "Private supervisor channel is unavailable or has no active assignment.",
    });
  const id = randomUUID();
  const capturedEpoch = assignmentEpoch;
  return new Promise((resolveCall, rejectCall) => {
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      const pending = pendingChannel.get(id);
      if (pending?.timer) clearTimeout(pending.timer);
      pendingChannel.delete(id);
      signal?.removeEventListener("abort", onAbort);
      operation(value);
    };
    const onAbort = () => {
      finish(rejectCall, { code: "request_cancelled", message: "MCP request was cancelled." });
      void sendChannelFrame({ type: "cancel", id: randomUUID(), targetRequestId: id }).catch(
        () => undefined,
      );
    };
    const timer = waitsForParent
      ? undefined
      : setTimeout(
          () =>
            finish(rejectCall, {
              code: "delivery_outcome_uncertain",
              message:
                "Supervisor delivery was not acknowledged and will not be retried automatically.",
            }),
          CHANNEL_TIMEOUT_MILLIS,
        );
    timer?.unref();
    pendingChannel.set(id, {
      type,
      timer,
      resolve: (value) => finish(resolveCall, value),
      reject: (value) => finish(rejectCall, value),
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    void sendChannelFrame({ type, id, assignmentEpoch: capturedEpoch, ...payload }).catch(() =>
      finish(rejectCall, {
        code: "delivery_outcome_uncertain",
        message: "Supervisor send outcome is uncertain and will not be retried automatically.",
      }),
    );
  });
};

let helloResolve;
let helloReject;
const hello = new Promise((resolveHello, rejectHello) => {
  helloResolve = resolveHello;
  helloReject = rejectHello;
});
const helloTimer = setTimeout(
  () => helloReject(new Error("hello-timeout")),
  CONNECT_TIMEOUT_MILLIS,
);
helloTimer.unref();

const detachChannelReader = attachLineReader(
  socket,
  (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      socket.destroy();
      return;
    }
    if (!object(value) || !authenticatedFrame(value)) {
      socket.destroy();
      return;
    }
    switch (value.type) {
      case "hello_ok":
        if (
          value.id !== "hello" ||
          !Number.isSafeInteger(value.assignmentEpoch) ||
          value.assignmentEpoch < 0
        ) {
          socket.destroy();
          return;
        }
        assignmentEpoch = value.assignmentEpoch;
        clearTimeout(helloTimer);
        helloResolve(undefined);
        return;
      case "assignment_epoch":
        if (
          !validChannelId(value.id) ||
          !Number.isSafeInteger(value.assignmentEpoch) ||
          value.assignmentEpoch <= assignmentEpoch
        ) {
          socket.destroy();
          return;
        }
        assignmentEpoch = value.assignmentEpoch;
        void sendChannelFrame({
          type: "assignment_epoch_ack",
          id: value.id,
          assignmentEpoch,
        }).catch(() => socket.destroy());
        return;
      case "result":
      case "error": {
        if (!validChannelId(value.id)) {
          socket.destroy();
          return;
        }
        const pending = pendingChannel.get(value.id);
        if (!pending) return;
        if (value.type === "error") {
          if (!boundedString(value.code, 128) || !boundedString(value.message, 512)) {
            socket.destroy();
            return;
          }
          pending.reject({ code: value.code, message: value.message });
          return;
        }
        if (value.accepted !== true) {
          socket.destroy();
          return;
        }
        pending.resolve({
          duplicate: value.duplicate === true,
          sequence: Number.isSafeInteger(value.sequence) ? value.sequence : undefined,
        });
        return;
      }
      case "question_reply": {
        if (!validChannelId(value.id) || !boundedString(value.message, MAX_REPLY_CHARS)) {
          socket.destroy();
          return;
        }
        const pending = pendingChannel.get(value.id);
        // A parent reply may cross a JSON-RPC cancellation that already removed the local
        // question. Ignore that exact stale reply rather than destroying the authenticated
        // channel needed by later supervisor tools.
        if (!pending) return;
        if (pending.type !== "question") {
          socket.destroy();
          return;
        }
        const acknowledgement = sendChannelFrame({
          type: "question_reply_ack",
          id: randomUUID(),
          questionId: value.id,
        });
        void acknowledgement.then(
          () => pending.resolve({ message: value.message }),
          () =>
            pending.reject({
              code: "reply_outcome_uncertain",
              message: "Parent reply acknowledgement could not be sent.",
            }),
        );
        return;
      }
      case "cancelled": {
        if (!validChannelId(value.id)) {
          socket.destroy();
          return;
        }
        pendingChannel.get(value.id)?.reject({
          code: "request_cancelled",
          message: "Supervisor request was cancelled.",
        });
        return;
      }
      case "cancel_result":
        return;
      case "closed":
        socket.destroy();
        return;
      default:
        socket.destroy();
    }
  },
  () => socket.destroy(),
);

socket.once("close", () => {
  clearTimeout(helloTimer);
  helloReject(new Error("hello-closed"));
  failChannel();
});
socket.once("error", () => {
  clearTimeout(helloTimer);
  helloReject(new Error("hello-error"));
  failChannel();
});

try {
  await sendChannelFrame({ type: "hello", id: "hello" });
  await hello;
} catch {
  fixedDiagnostic("Private supervisor helper authentication failed or parent channel closed.");
  process.exit(2);
}

const toolDefinitions = [
  {
    name: "supervisor_progress",
    description: "Publish bounded assignment progress to the parent projection.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS } },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "supervisor_warning",
    description:
      "Record one bounded non-blocking assignment warning in parent-visible run status; repeat it in the final report. Ask a question instead when the risk could invalidate work the parent is doing now.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS } },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "supervisor_question",
    description:
      "Ask the parent this assignment's one correlated blocking question and wait for its exact reply.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS } },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "supervisor_submit_report",
    description:
      "Submit the complete bounded final report with a stable delivery identity for explicit idempotent retry.",
    inputSchema: {
      type: "object",
      properties: {
        delivery_id: {
          type: "string",
          minLength: 1,
          maxLength: MAX_DELIVERY_ID_CHARS,
          pattern: DELIVERY_ID_PATTERN.source,
        },
        report: { type: "string", minLength: 1, maxLength: MAX_REPORT_CHARS },
      },
      required: ["delivery_id", "report"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

const decodeToolArguments = (name, value) => {
  if (name === "supervisor_submit_report") {
    if (
      !exactKeys(value, ["delivery_id", "report"], ["delivery_id", "report"]) ||
      typeof value.delivery_id !== "string" ||
      value.delivery_id.length > MAX_DELIVERY_ID_CHARS ||
      !DELIVERY_ID_PATTERN.test(value.delivery_id) ||
      !boundedString(value.report, MAX_REPORT_CHARS)
    )
      return undefined;
    return { deliveryId: value.delivery_id, report: value.report };
  }
  if (
    !["supervisor_progress", "supervisor_warning", "supervisor_question"].includes(name) ||
    !exactKeys(value, ["message"], ["message"]) ||
    !boundedString(value.message, MAX_MESSAGE_CHARS)
  )
    return undefined;
  return { message: value.message };
};

const decodeMcpMessage = (value) => {
  if (
    !exactKeys(value, ["jsonrpc", "id", "method", "params"], ["jsonrpc", "method"]) ||
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string" ||
    value.method.length < 1 ||
    value.method.length > 128 ||
    (own(value, "id") && !validRpcId(value.id))
  )
    return undefined;
  const id = own(value, "id") ? value.id : undefined;
  switch (value.method) {
    case "initialize":
      if (
        id === undefined ||
        !exactKeys(
          value.params,
          ["protocolVersion", "capabilities", "clientInfo", "_meta"],
          ["protocolVersion"],
        ) ||
        !boundedString(value.params.protocolVersion, 64) ||
        (own(value.params, "_meta") && !boundedMetadata(value.params._meta))
      )
        return undefined;
      return { method: value.method, id, protocolVersion: value.params.protocolVersion };
    case "notifications/initialized":
      if (id !== undefined || !validMeta(value.params)) return undefined;
      return { method: value.method };
    case "notifications/cancelled":
      if (
        id !== undefined ||
        !exactKeys(value.params, ["requestId", "reason", "_meta"], ["requestId"]) ||
        !validRpcId(value.params.requestId) ||
        (value.params.reason !== undefined && !boundedString(value.params.reason, 512, false)) ||
        (own(value.params, "_meta") && !boundedMetadata(value.params._meta))
      )
        return undefined;
      return { method: value.method, requestId: value.params.requestId };
    case "ping":
    case "tools/list":
      if (id === undefined || !validMeta(value.params)) return undefined;
      return { method: value.method, id };
    case "tools/call":
      if (
        id === undefined ||
        !exactKeys(value.params, ["name", "arguments", "_meta"], ["name", "arguments"]) ||
        !boundedString(value.params.name, 128) ||
        (own(value.params, "_meta") && !boundedMetadata(value.params._meta))
      )
        return undefined;
      return {
        method: value.method,
        id,
        name: value.params.name,
        arguments: value.params.arguments,
      };
    default:
      return { method: value.method, ...(id === undefined ? {} : { id }) };
  }
};

const executeTool = async (request, signal) => {
  const args = decodeToolArguments(request.name, request.arguments);
  if (!args) {
    toolResult(request.id, "Tool input is malformed, excessive, or unsupported.", true);
    return;
  }
  switch (request.name) {
    case "supervisor_progress":
      await channelCall("progress", { message: args.message }, signal);
      toolResult(request.id, "Progress delivered to the parent projection.");
      return;
    case "supervisor_warning":
      await channelCall("warning", { message: args.message }, signal);
      toolResult(request.id, "Warning recorded in parent-visible run status.");
      return;
    case "supervisor_question": {
      const result = await channelCall("question", { message: args.message }, signal, true);
      toolResult(request.id, `Parent reply: ${result.message}`);
      return;
    }
    case "supervisor_submit_report": {
      const result = await channelCall(
        "report",
        { deliveryId: args.deliveryId, text: args.report },
        signal,
      );
      toolResult(
        request.id,
        `${result.duplicate ? "Final report retry accepted" : "Final report accepted"}; sequence ${result.sequence}.`,
      );
      return;
    }
  }
};

const dispatchMcp = (request) => {
  switch (request.method) {
    case "initialize":
      initialized = true;
      sendRpc({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return;
    case "notifications/initialized":
      return;
    case "notifications/cancelled": {
      const call = activeCalls.get(rpcKey(request.requestId));
      call?.abort();
      return;
    }
    case "ping":
      sendRpc({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    case "tools/list":
      if (!initialized) {
        rpcError(request.id, -32002, "MCP helper is not initialized.");
        return;
      }
      sendRpc({ jsonrpc: "2.0", id: request.id, result: { tools: toolDefinitions } });
      return;
    case "tools/call": {
      if (!initialized) {
        rpcError(request.id, -32002, "MCP helper is not initialized.");
        return;
      }
      if (activeCalls.size >= MAX_CONCURRENT_CALLS) {
        rpcError(request.id, -32000, "Bounded concurrent MCP call capacity is full.");
        return;
      }
      const key = rpcKey(request.id);
      if (activeCalls.has(key)) {
        rpcError(request.id, -32600, "An MCP request with this id is already active.");
        return;
      }
      const controller = new AbortController();
      activeCalls.set(key, controller);
      void executeTool(request, controller.signal)
        .catch((failure) => {
          const cancelled = failure?.code === "request_cancelled";
          rpcError(
            request.id,
            cancelled ? -32800 : -32000,
            boundedString(failure?.message, 512)
              ? failure.message
              : "Private supervisor tool delivery failed.",
          );
        })
        .finally(() => activeCalls.delete(key));
      return;
    }
    default:
      if (request.id !== undefined) rpcError(request.id, -32601, "Method not found.");
  }
};

const detachStdin = attachLineReader(
  process.stdin,
  (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      rpcError(null, -32700, "Parse error.");
      return;
    }
    const request = decodeMcpMessage(value);
    if (!request) {
      const id = object(value) && own(value, "id") && validRpcId(value.id) ? value.id : null;
      rpcError(id, -32600, "Invalid or excessive JSON-RPC request.");
      return;
    }
    dispatchMcp(request);
  },
  () => {
    rpcError(null, -32600, "JSON-RPC input exceeds the bounded line limit.");
    process.stdin.destroy();
  },
);

let inputClosed = false;
const closeInput = () => {
  if (inputClosed) return;
  inputClosed = true;
  for (const call of activeCalls.values()) call.abort();
  activeCalls.clear();
  detachStdin();
  detachChannelReader();
  stdout.close();
  channelOutput.close();
  socket.destroy();
};
process.stdin.once("end", closeInput);
process.stdin.once("close", closeInput);
