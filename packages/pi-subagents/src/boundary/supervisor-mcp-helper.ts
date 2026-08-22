#!/usr/bin/env node
// The executable MCP edge deliberately owns native stdio and no-follow config reads.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/strictEffectProvide:off
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { isJsonObject, runtimeTypeName, type JsonObject, type JsonValue } from "pi-cosmic-core";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
  SUPERVISOR_CHANNEL_VERSION,
  SupervisorChannelConfigSchema,
  SupervisorChannelIdSchema,
  SupervisorDeliveryIdSchema,
  type SupervisorChannelConfig,
  SupervisorRpcFailure,
  SupervisorRpcGroup,
} from "../supervisor/protocol.ts";

for (const key of Object.keys(process.env)) delete process.env[key];

const VERSION = SUPERVISOR_CHANNEL_VERSION;
const SERVER_NAME = "pi-subagents-supervisor";
const SERVER_VERSION = "2.0.0";
const MAX_CONFIG_BYTES = 4 * 1024;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_MESSAGE_CHARS = 16 * 1024;
const MAX_REPORT_CHARS = 32 * 1024;
const MAX_ID_CHARS = 256;
const MAX_DELIVERY_ID_CHARS = 256;
const MAX_CONCURRENT_CALLS = 16;
const MAX_PENDING_WRITES = 64;
const CHANNEL_TIMEOUT_MILLIS = 10_000;
const CONNECT_TIMEOUT_MILLIS = 5_000;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

type RpcId = string | number;

type DecodedMcpMessage =
  | { readonly method: "initialize"; readonly id: RpcId; readonly protocolVersion: string }
  | { readonly method: "notifications/initialized" }
  | { readonly method: "notifications/cancelled"; readonly requestId: RpcId }
  | { readonly method: "ping" | "tools/list"; readonly id: RpcId }
  | {
      readonly method: "tools/call";
      readonly id: RpcId;
      readonly name: string;
      readonly arguments: JsonValue | undefined;
    }
  | {
      readonly method: "unknown";
      readonly requestedMethod: string;
      readonly id?: RpcId | undefined;
    };

type ToolCall = Extract<DecodedMcpMessage, { readonly method: "tools/call" }>;

type DecodedToolArguments =
  | { readonly kind: "message"; readonly message: string }
  | {
      readonly kind: "report";
      readonly deliveryId: ReturnType<typeof SupervisorDeliveryIdSchema.make>;
      readonly report: string;
    };

interface SerializedWriter {
  readonly write: <ValueInput>(value: ValueInput) => Promise<void>;
  readonly close: () => void;
}

interface McpToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  isError?: true;
}

const own = (value: JsonObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const exactKeys = <ValueInput>(
  value: ValueInput,
  allowed: ReadonlyArray<string>,
  required: ReadonlyArray<string> = [],
): value is ValueInput & JsonObject =>
  isJsonObject(value) &&
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => own(value, key));

const boundedString = <ValueInput>(
  value: ValueInput,
  maximum: number,
  nonEmpty = true,
): value is ValueInput & string =>
  Predicate.isString(value) && value.length <= maximum && (!nonEmpty || value.trim().length > 0);

const validRpcId = <ValueInput>(value: ValueInput): value is ValueInput & RpcId =>
  (Predicate.isString(value) && value.length > 0 && value.length <= MAX_ID_CHARS) ||
  (Predicate.isNumber(value) && Number.isSafeInteger(value));

const rpcKey = (value: RpcId): string => `${runtimeTypeName(value)}:${String(value)}`;

const boundedMetadata = <ValueInput>(value: ValueInput, depth = 0): boolean => {
  if (depth > 6) return false;
  if (value === null || Predicate.isBoolean(value)) return true;
  if (Predicate.isNumber(value)) return Number.isFinite(value);
  if (Predicate.isString(value)) return value.length <= 4096;
  if (Array.isArray(value))
    return value.length <= 64 && value.every((entry) => boundedMetadata(entry, depth + 1));
  if (!isJsonObject(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 64 &&
    entries.every(([key, entry]) => key.length <= 128 && boundedMetadata(entry, depth + 1))
  );
};

const validMeta = <ParamsInput>(params: ParamsInput): boolean =>
  params === undefined ||
  (exactKeys(params, ["_meta"]) && (!own(params, "_meta") || boundedMetadata(params._meta)));

const fixedDiagnostic = <MessageInput>(message: MessageInput): void => {
  const text = boundedString(message, 512) ? message : "Private supervisor helper failed.";
  process.stderr.write(`${text}\n`);
};

const configArgument = (): string | undefined => {
  const argument = process.argv[3];
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== "--config" ||
    !boundedString(argument, 4096) ||
    !isAbsolute(argument) ||
    argument.includes("\0")
  )
    return undefined;
  return resolve(argument);
};

class HelperConfigError extends Schema.TaggedError<HelperConfigError>()("HelperConfigError", {
  code: Schema.String,
}) {}

const helperConfigError = (code: string) => new HelperConfigError({ code });
const configFromJson = Schema.fromJsonString(SupervisorChannelConfigSchema);
const unknownFromJson = Schema.fromJsonString(Schema.Unknown);

const readConfig = (path: string): Effect.Effect<SupervisorChannelConfig, HelperConfigError> =>
  Effect.gen(function* () {
    const directoryStat = yield* Effect.tryPromise({
      try: () => lstat(dirname(path)),
      catch: () => helperConfigError("unsafe-config-directory"),
    });
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (directoryStat.mode & 0o077) !== 0
    )
      return yield* helperConfigError("unsafe-config-directory");
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(path, constants.O_RDONLY | noFollow),
        catch: () => helperConfigError("unsafe-config-file"),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: () => helperConfigError("unsafe-config-file"),
          });
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES)
            return yield* helperConfigError("unsafe-config-file");
          if ((stat.mode & 0o077) !== 0) return yield* helperConfigError("unsafe-config-mode");
          const source = yield* Effect.tryPromise({
            try: () => handle.readFile({ encoding: "utf8" }),
            catch: () => helperConfigError("invalid-config"),
          });
          if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES)
            return yield* helperConfigError("oversized-config");
          const decoded = Schema.decodeUnknownOption(configFromJson, {
            onExcessProperty: "error",
          })(source);
          if (Option.isNone(decoded)) return yield* helperConfigError("invalid-config");
          return decoded.value;
        }),
      (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
    );
  });

const makeSerializedWriter = (
  stream: NodeJS.WritableStream,
  maximumWrites = MAX_PENDING_WRITES,
): SerializedWriter => {
  let tail = Promise.resolve();
  let pending = 0;
  let closed = false;
  const write = <ValueInput>(value: ValueInput): Promise<void> => {
    if (closed || pending >= maximumWrites) return Promise.reject(new Error("write-capacity"));
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
      return Promise.reject(new Error("write-size"));
    pending += 1;
    const operation = tail.then(
      () =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          stream.write(line, "utf8", (error?: Error | null) =>
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

const attachLineReader = (
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onFailure: () => void,
): (() => void) => {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let failed = false;
  const fail = (): void => {
    if (failed) return;
    failed = true;
    buffered = "";
    onFailure();
  };
  const emit = (final: boolean): void => {
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
  const onData = (chunk: string | Buffer): void => {
    if (failed) return;
    buffered += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    emit(false);
  };
  const onEnd = (): void => {
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

const configPath = configArgument();
if (!configPath) {
  fixedDiagnostic("Private supervisor helper configuration argument is invalid.");
  process.exit(2);
}

const configExit = await Effect.runPromiseExit(readConfig(configPath));
if (Exit.isFailure(configExit)) {
  fixedDiagnostic("Private supervisor helper could not open its bounded channel configuration.");
  process.exit(2);
}
const config: SupervisorChannelConfig = configExit.value;

const stdout = makeSerializedWriter(process.stdout);
const activeCalls = new Map<string, AbortController>();
const rpcScope = await Effect.runPromise(Scope.make());
let assignmentEpoch = 0;
let channelClosed = false;
let initialized = false;
let supervisorClient:
  | RpcClient.FromGroup<typeof SupervisorRpcGroup, RpcClientError.RpcClientError>
  | undefined;

const closeRpcScope = (): void => {
  void Effect.runPromise(Scope.close(rpcScope, Exit.void).pipe(Effect.ignore));
};

const failChannel = (): void => {
  if (channelClosed) return;
  channelClosed = true;
  closeRpcScope();
  process.stdin.destroy();
};

const sendRpc = <MessageInput>(message: MessageInput): Promise<void> =>
  stdout.write(message).catch(() => {
    failChannel();
  });

const rpcError = (id: RpcId | null, code: number, message: string): Promise<void> =>
  sendRpc({ jsonrpc: "2.0", id, error: { code, message } });

const toolResult = (id: RpcId, text: string, isError = false): Promise<void> => {
  const result: McpToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return sendRpc({ jsonrpc: "2.0", id, result });
};

const authenticatedPayload = () => ({
  version: VERSION,
  runId: config.runId,
  token: config.token,
});

const runSupervisor = <Success, Error>(
  effect: Effect.Effect<Success, Error>,
  signal?: AbortSignal,
  timeout = true,
): Promise<Success> =>
  Effect.runPromise(
    timeout ? effect.pipe(Effect.timeout(CHANNEL_TIMEOUT_MILLIS)) : effect,
    signal ? { signal } : undefined,
  ).catch(<FailureInput>(failure: FailureInput) => {
    if (failure instanceof SupervisorRpcFailure) throw failure;
    if (signal?.aborted) throw { code: "request_cancelled", message: "MCP request was cancelled." };
    throw {
      code: "delivery_outcome_uncertain",
      message: "Supervisor RPC delivery did not settle within its bound.",
    };
  });

const clientOpenExit = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const socket = yield* NodeSocket.makeNet({
      host: config.host,
      port: config.port,
      openTimeout: CONNECT_TIMEOUT_MILLIS,
    });
    const serialization = RpcSerialization.makeNdjson({
      maxBufferSize: MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
    });
    const protocol = yield* RpcClient.makeProtocolSocket().pipe(
      Effect.provideService(RpcSerialization.RpcSerialization, serialization),
      Effect.provideService(Socket.Socket, socket),
    );
    const client = yield* RpcClient.make(SupervisorRpcGroup).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
    const opened = yield* client
      .SupervisorOpenSession(authenticatedPayload())
      .pipe(Effect.timeout(CONNECT_TIMEOUT_MILLIS));
    return { client, opened } as const;
  }).pipe(Scope.provide(rpcScope)),
);
if (Exit.isFailure(clientOpenExit)) {
  fixedDiagnostic("Private supervisor helper authentication failed or parent channel closed.");
  closeRpcScope();
  process.exit(2);
}
const { client, opened } = clientOpenExit.value;
supervisorClient = client;
assignmentEpoch = opened.assignmentEpoch;
Fiber.runIn(
  Effect.runFork(
    client.SupervisorWatchAssignments(authenticatedPayload()).pipe(
      Stream.runForEach((update) =>
        Effect.gen(function* () {
          if (update.assignmentEpoch <= assignmentEpoch)
            return yield* Effect.die(new Error("non-monotonic-assignment-epoch"));
          assignmentEpoch = update.assignmentEpoch;
          yield* client.SupervisorAcknowledgeAssignment({
            ...authenticatedPayload(),
            assignmentEpoch,
            updateId: update.updateId,
          });
        }),
      ),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.sync(failChannel) : Effect.void)),
    ),
  ),
  rpcScope,
);

const liveClient = (): RpcClient.FromGroup<
  typeof SupervisorRpcGroup,
  RpcClientError.RpcClientError
> => {
  if (channelClosed || !supervisorClient || assignmentEpoch < 1)
    throw {
      code: "channel_unavailable",
      message: "Private supervisor channel is unavailable or has no active assignment.",
    };
  return supervisorClient;
};

const callProgress = async (message: string, signal?: AbortSignal): Promise<void> => {
  const client = liveClient();
  await runSupervisor(
    client.SupervisorProgress({
      ...authenticatedPayload(),
      assignmentEpoch,
      requestId: SupervisorChannelIdSchema.make(randomUUID()),
      message,
    }),
    signal,
  );
};

const callWarning = async (message: string, signal?: AbortSignal): Promise<void> => {
  const client = liveClient();
  await runSupervisor(
    client.SupervisorWarning({
      ...authenticatedPayload(),
      assignmentEpoch,
      requestId: SupervisorChannelIdSchema.make(randomUUID()),
      message,
    }),
    signal,
  );
};

const callQuestion = async (
  message: string,
  signal?: AbortSignal,
): Promise<{ readonly message: string }> => {
  const client = liveClient();
  const questionEpoch = assignmentEpoch;
  const response = await runSupervisor(
    client.SupervisorQuestion({
      ...authenticatedPayload(),
      assignmentEpoch: questionEpoch,
      requestId: SupervisorChannelIdSchema.make(randomUUID()),
      message,
    }),
    signal,
    false,
  );
  await runSupervisor(
    client.SupervisorAcknowledgeQuestionReply({
      ...authenticatedPayload(),
      assignmentEpoch: questionEpoch,
      questionId: response.questionId,
    }),
  );
  return { message: response.message };
};

const callReport = async (
  deliveryId: ReturnType<typeof SupervisorDeliveryIdSchema.make>,
  text: string,
  signal?: AbortSignal,
): Promise<{ readonly duplicate: boolean; readonly sequence: number }> => {
  const client = liveClient();
  return runSupervisor(
    client.SupervisorReport({
      ...authenticatedPayload(),
      assignmentEpoch,
      requestId: SupervisorChannelIdSchema.make(randomUUID()),
      deliveryId,
      text,
    }),
    signal,
  );
};

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

const decodeToolArguments = <ValueInput>(
  name: string,
  value: ValueInput,
): DecodedToolArguments | undefined => {
  if (name === "supervisor_submit_report") {
    if (
      !exactKeys(value, ["delivery_id", "report"], ["delivery_id", "report"]) ||
      !Predicate.isString(value.delivery_id) ||
      value.delivery_id.length > MAX_DELIVERY_ID_CHARS ||
      !DELIVERY_ID_PATTERN.test(value.delivery_id) ||
      !boundedString(value.report, MAX_REPORT_CHARS)
    )
      return undefined;
    const deliveryId = SupervisorDeliveryIdSchema.makeOption(value.delivery_id);
    if (Option.isNone(deliveryId)) return undefined;
    return { kind: "report", deliveryId: deliveryId.value, report: value.report };
  }
  if (
    !["supervisor_progress", "supervisor_warning", "supervisor_question"].includes(name) ||
    !exactKeys(value, ["message"], ["message"]) ||
    !boundedString(value.message, MAX_MESSAGE_CHARS)
  )
    return undefined;
  return { kind: "message", message: value.message };
};

const decodeMcpMessage = <ValueInput>(value: ValueInput): DecodedMcpMessage | undefined => {
  if (
    !exactKeys(value, ["jsonrpc", "id", "method", "params"], ["jsonrpc", "method"]) ||
    value.jsonrpc !== "2.0" ||
    !Predicate.isString(value.method) ||
    value.method.length < 1 ||
    value.method.length > 128
  )
    return undefined;
  const rawId = value.id;
  const id = validRpcId(rawId) ? rawId : undefined;
  if (own(value, "id") && id === undefined) return undefined;
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
      return { method: "initialize", id, protocolVersion: value.params.protocolVersion };
    case "notifications/initialized":
      return id === undefined && validMeta(value.params)
        ? { method: "notifications/initialized" }
        : undefined;
    case "notifications/cancelled":
      if (
        id !== undefined ||
        !exactKeys(value.params, ["requestId", "reason", "_meta"], ["requestId"]) ||
        !validRpcId(value.params.requestId) ||
        (value.params.reason !== undefined && !boundedString(value.params.reason, 512, false)) ||
        (own(value.params, "_meta") && !boundedMetadata(value.params._meta))
      )
        return undefined;
      return { method: "notifications/cancelled", requestId: value.params.requestId };
    case "ping":
    case "tools/list":
      return id !== undefined && validMeta(value.params) ? { method: value.method, id } : undefined;
    case "tools/call":
      if (
        id === undefined ||
        !exactKeys(value.params, ["name", "arguments", "_meta"], ["name", "arguments"]) ||
        !boundedString(value.params.name, 128) ||
        (own(value.params, "_meta") && !boundedMetadata(value.params._meta))
      )
        return undefined;
      return {
        method: "tools/call",
        id,
        name: value.params.name,
        arguments: value.params.arguments,
      };
    default:
      return id === undefined
        ? { method: "unknown", requestedMethod: value.method }
        : { method: "unknown", requestedMethod: value.method, id };
  }
};

const executeTool = async (request: ToolCall, signal: AbortSignal): Promise<void> => {
  const args = decodeToolArguments(request.name, request.arguments);
  if (!args) {
    await toolResult(request.id, "Tool input is malformed, excessive, or unsupported.", true);
    return;
  }
  switch (request.name) {
    case "supervisor_progress":
      if (args.kind !== "message") break;
      await callProgress(args.message, signal);
      await toolResult(request.id, "Progress delivered to the parent projection.");
      return;
    case "supervisor_warning":
      if (args.kind !== "message") break;
      await callWarning(args.message, signal);
      await toolResult(request.id, "Warning recorded in parent-visible run status.");
      return;
    case "supervisor_question": {
      if (args.kind !== "message") break;
      const result = await callQuestion(args.message, signal);
      await toolResult(request.id, `Parent reply: ${result.message}`);
      return;
    }
    case "supervisor_submit_report": {
      if (args.kind !== "report") break;
      const result = await callReport(args.deliveryId, args.report, signal);
      await toolResult(
        request.id,
        `${result.duplicate ? "Final report retry accepted" : "Final report accepted"}; sequence ${result.sequence}.`,
      );
      return;
    }
  }
  await toolResult(request.id, "Tool input is malformed, excessive, or unsupported.", true);
};

const failureCode = <FailureInput>(failure: FailureInput): string | undefined =>
  failure instanceof SupervisorRpcFailure
    ? failure.code
    : isJsonObject(failure) && Predicate.isString(failure.code)
      ? failure.code
      : undefined;

const failureMessage = <FailureInput>(failure: FailureInput): string | undefined =>
  failure instanceof SupervisorRpcFailure
    ? failure.message
    : isJsonObject(failure) && boundedString(failure.message, 512)
      ? failure.message
      : undefined;

const isCancellationCode = (code: string | undefined): boolean =>
  code === "request_cancelled" ||
  code === "question_cancelled" ||
  code === "question_cancelled_by_report" ||
  code === "question_assignment_advanced";

const dispatchMcp = (request: DecodedMcpMessage): void => {
  switch (request.method) {
    case "initialize":
      initialized = true;
      void sendRpc({
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
    case "notifications/cancelled":
      activeCalls.get(rpcKey(request.requestId))?.abort();
      return;
    case "ping":
      void sendRpc({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    case "tools/list":
      if (!initialized) {
        void rpcError(request.id, -32002, "MCP helper is not initialized.");
        return;
      }
      void sendRpc({ jsonrpc: "2.0", id: request.id, result: { tools: toolDefinitions } });
      return;
    case "tools/call": {
      if (!initialized) {
        void rpcError(request.id, -32002, "MCP helper is not initialized.");
        return;
      }
      if (activeCalls.size >= MAX_CONCURRENT_CALLS) {
        void rpcError(request.id, -32000, "Bounded concurrent MCP call capacity is full.");
        return;
      }
      const key = rpcKey(request.id);
      if (activeCalls.has(key)) {
        void rpcError(request.id, -32600, "An MCP request with this id is already active.");
        return;
      }
      const controller = new AbortController();
      activeCalls.set(key, controller);
      void executeTool(request, controller.signal)
        .catch(<FailureInput>(failure: FailureInput) => {
          const code = failureCode(failure);
          return rpcError(
            request.id,
            isCancellationCode(code) ? -32800 : -32000,
            failureMessage(failure) ?? "Private supervisor tool delivery failed.",
          );
        })
        .finally(() => activeCalls.delete(key));
      return;
    }
    default:
      if (request.id !== undefined) void rpcError(request.id, -32601, "Method not found.");
  }
};

const detachStdin = attachLineReader(
  process.stdin,
  (line) => {
    const decoded = Schema.decodeUnknownOption(unknownFromJson)(line);
    if (Option.isNone(decoded)) {
      void rpcError(null, -32700, "Parse error.");
      return;
    }
    const value = decoded.value;
    const request = decodeMcpMessage(value);
    if (!request) {
      const id = isJsonObject(value) && validRpcId(value.id) ? value.id : null;
      void rpcError(id, -32600, "Invalid or excessive JSON-RPC request.");
      return;
    }
    dispatchMcp(request);
  },
  () => {
    void rpcError(null, -32600, "JSON-RPC input exceeds the bounded line limit.");
    process.stdin.destroy();
  },
);

let inputClosed = false;
const closeInput = (): void => {
  if (inputClosed) return;
  inputClosed = true;
  for (const call of activeCalls.values()) call.abort();
  activeCalls.clear();
  detachStdin();
  stdout.close();
  closeRpcScope();
};
process.stdin.once("end", closeInput);
process.stdin.once("close", closeInput);
