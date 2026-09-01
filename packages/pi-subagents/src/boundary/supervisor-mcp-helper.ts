#!/usr/bin/env node
// The executable MCP edge deliberately owns native stdio and no-follow config reads.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { isJsonObject, runtimeTypeName, type JsonObject, type JsonValue } from "pi-cosmic-core";
import { randomUUID } from "node:crypto";
import { attachBoundedLineParser } from "./bounded-line-parser.ts";
import { nodeFsConstants as constants, nodeFsPromises, nodePath } from "./node-builtins.ts";
import { decodeUnknownJsonOption } from "./wire-shared.ts";
import {
  MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
  MAX_SUPERVISOR_CONFIG_BYTES,
  SUPERVISOR_CHANNEL_VERSION,
  SupervisorChannelConfigSchema,
  SupervisorChannelIdSchema,
  SupervisorDeliveryIdSchema,
  type SupervisorChannelConfig,
  SupervisorRpcFailure,
  SupervisorRpcGroup,
} from "../supervisor/protocol.ts";
import {
  isSupervisorMcpMessageArguments,
  isSupervisorMcpProxyArguments,
  isSupervisorMcpReportArguments,
  MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
  MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
  MAX_SUPERVISOR_MCP_REPORT_CHARS,
  MAX_SUPERVISOR_MCP_PROXY_JSON_CHARS,
  MAX_SUPERVISOR_MCP_PROXY_TOOL_CHARS,
  SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE,
  SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS,
  SUPERVISOR_MCP_MESSAGE_TOOL_NAMES,
  SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
  SUPERVISOR_MCP_PROXY_ARGUMENT_KEYS,
  SUPERVISOR_MCP_PROXY_TOOL_NAME,
  SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";

const { lstat, open } = nodeFsPromises;
const { dirname, isAbsolute, resolve } = nodePath;

// The helper scrubs its entire inherited environment snapshot before any other work.
const scrubEnvironment = (environment: NodeJS.ProcessEnv): void => {
  for (const key of Object.keys(environment)) delete environment[key];
};
scrubEnvironment(process.env);

const VERSION = SUPERVISOR_CHANNEL_VERSION;
const SERVER_NAME = "pi-subagents-supervisor";

class McpToolCallFailure extends Data.TaggedError("McpToolCallFailure")<{
  readonly failure: unknown;
}> {}

class McpWriteFailure extends Data.TaggedError("McpWriteFailure")<{
  readonly reason: "capacity" | "closed" | "size" | "stream";
}> {}

class HelperStartupFailure extends Data.TaggedError("HelperStartupFailure")<{
  readonly diagnostic: string;
}> {
  override readonly [Runtime.errorExitCode] = 2;
  override readonly [Runtime.errorReported] = false;
}

const startupFailure = (diagnostic: string) => new HelperStartupFailure({ diagnostic });
const SERVER_VERSION = "3.0.0";
const MAX_LINE_BYTES = MAX_SUPERVISOR_CHANNEL_LINE_BYTES;
const MAX_QUEUED_INPUT_BYTES = 2 * MAX_LINE_BYTES;
const MAX_ID_CHARS = 256;
const MAX_CONCURRENT_CALLS = 16;
const MAX_PENDING_WRITES = 64;
const CHANNEL_TIMEOUT_MILLIS = 10_000;
const CONNECT_TIMEOUT_MILLIS = 5_000;

type RpcId = string | number;

type DecodedMcpMessage =
  | {
      readonly method: "initialize";
      readonly id: RpcId;
      readonly protocolVersion: string;
      readonly piBridge: boolean;
    }
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
  | { readonly kind: "proxy"; readonly tool: string; readonly argumentsJson: string }
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
const decodeConfigJsonOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(SupervisorChannelConfigSchema),
  { onExcessProperty: "error" },
);

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
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SUPERVISOR_CONFIG_BYTES)
            return yield* helperConfigError("unsafe-config-file");
          if ((stat.mode & 0o077) !== 0) return yield* helperConfigError("unsafe-config-mode");
          const source = yield* Effect.tryPromise({
            try: () => handle.readFile({ encoding: "utf8" }),
            catch: () => helperConfigError("invalid-config"),
          });
          if (Buffer.byteLength(source, "utf8") > MAX_SUPERVISOR_CONFIG_BYTES)
            return yield* helperConfigError("oversized-config");
          const decoded = decodeConfigJsonOption(source);
          if (Option.isNone(decoded)) return yield* helperConfigError("invalid-config");
          return decoded.value;
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: () => helperConfigError("config-close-failed"),
        }).pipe(Effect.ignore),
    );
  });

const makeSerializedWriter = Effect.fn("SupervisorMcpHelper.makeSerializedWriter")(function* (
  stream: NodeJS.WritableStream,
  maximumWrites = MAX_PENDING_WRITES,
) {
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const frames = yield* Queue.bounded<{
    readonly line: string;
    readonly ack: Deferred.Deferred<void, McpWriteFailure>;
  }>(maximumWrites);
  const acknowledgements = new Set<Deferred.Deferred<void, McpWriteFailure>>();
  let pending = 0;
  let closed = false;
  const writeLine = (line: string) =>
    Effect.callback<void, McpWriteFailure>((resume) => {
      stream.write(line, "utf8", (error?: Error | null) =>
        resume(error ? Effect.fail(new McpWriteFailure({ reason: "stream" })) : Effect.void),
      );
    });
  yield* Effect.forever(
    Queue.take(frames).pipe(
      Effect.flatMap((frame) =>
        Effect.exit(writeLine(frame.line)).pipe(
          Effect.flatMap((exit) => Deferred.done(frame.ack, exit)),
          Effect.ensuring(
            Effect.sync(() => {
              acknowledgements.delete(frame.ack);
              pending = Math.max(0, pending - 1);
            }),
          ),
        ),
      ),
    ),
  ).pipe(Effect.forkScoped({ startImmediately: true }));
  const write = <ValueInput>(value: ValueInput): Promise<void> => {
    if (closed) return runPromise(Effect.fail(new McpWriteFailure({ reason: "closed" })));
    if (pending >= maximumWrites)
      return runPromise(Effect.fail(new McpWriteFailure({ reason: "capacity" })));
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
      return runPromise(Effect.fail(new McpWriteFailure({ reason: "size" })));
    const ack = Deferred.makeUnsafe<void, McpWriteFailure>();
    acknowledgements.add(ack);
    pending += 1;
    if (!Queue.offerUnsafe(frames, { line, ack })) {
      acknowledgements.delete(ack);
      pending -= 1;
      return runPromise(Effect.fail(new McpWriteFailure({ reason: "capacity" })));
    }
    return runPromise(Deferred.await(ack));
  };
  return {
    write,
    close: () => {
      if (closed) return;
      closed = true;
      const failure = new McpWriteFailure({ reason: "closed" });
      for (const acknowledgement of acknowledgements)
        Deferred.doneUnsafe(acknowledgement, Effect.fail(failure));
      acknowledgements.clear();
      pending = 0;
    },
  } satisfies SerializedWriter;
});

let config: SupervisorChannelConfig;
let stdout: SerializedWriter;
let activeCalls: FiberMap.FiberMap<string>;
let assignmentEpoch = 0;
let channelClosed = false;
let initialized = false;
let piBridgeClient = false;
let requestMainShutdown = (): void => {};
let supervisorClient:
  | RpcClient.FromGroup<typeof SupervisorRpcGroup, RpcClientError.RpcClientError>
  | undefined;

const failChannel = (): void => {
  if (channelClosed) return;
  channelClosed = true;
  process.stdin.destroy();
  requestMainShutdown();
};

const sendRpc = <MessageInput>(message: MessageInput): Promise<void> =>
  stdout.write(message).catch(() => {
    failChannel();
  });

const rpcError = (id: RpcId | null, code: number, message: string): Promise<void> =>
  sendRpc({ jsonrpc: "2.0", id, error: { code, message } });

const toolResult = (text: string, isError = false): McpToolResult => {
  const result: McpToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
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

const callProgress = (message: string, signal?: AbortSignal): Promise<void> => {
  const client = liveClient();
  return runSupervisor(
    client.SupervisorProgress({
      ...authenticatedPayload(),
      assignmentEpoch,
      requestId: SupervisorChannelIdSchema.make(randomUUID()),
      message,
    }),
    signal,
  ).then(() => undefined);
};

const callWarning = (message: string, signal?: AbortSignal): Promise<void> => {
  const client = liveClient();
  return runSupervisor(
    client.SupervisorWarning({
      ...authenticatedPayload(),
      assignmentEpoch,
      requestId: SupervisorChannelIdSchema.make(randomUUID()),
      message,
    }),
    signal,
  ).then(() => undefined);
};

const callQuestion = (
  message: string,
  signal?: AbortSignal,
): Promise<{ readonly message: string }> => {
  const client = liveClient();
  const questionEpoch = assignmentEpoch;
  return runSupervisor(
    client.SupervisorQuestion({
      ...authenticatedPayload(),
      assignmentEpoch: questionEpoch,
      requestId: SupervisorChannelIdSchema.make(randomUUID()),
      message,
    }),
    signal,
    false,
  ).then((response) =>
    runSupervisor(
      client.SupervisorAcknowledgeQuestionReply({
        ...authenticatedPayload(),
        assignmentEpoch: questionEpoch,
        questionId: response.questionId,
      }),
    ).then(() => ({ message: response.message })),
  );
};

const callReport = (
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

const callProxy = (
  tool: string,
  argumentsJson: string,
  signal?: AbortSignal,
): Promise<{ readonly ok: boolean; readonly payloadJson: string }> => {
  const client = liveClient();
  return runSupervisor(
    client.SupervisorProxy({
      ...authenticatedPayload(),
      requestId: SupervisorChannelIdSchema.make(randomUUID()),
      tool,
      argumentsJson,
    }),
    signal,
    false,
  );
};

const messageInputSchema = {
  type: "object",
  properties: {
    message: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
      pattern: SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
    },
  },
  required: SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS,
  additionalProperties: false,
} as const;
const toolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const toolDefinitions = [
  {
    name: SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[0],
    description: "Publish bounded assignment progress to the parent projection.",
    inputSchema: messageInputSchema,
    annotations: toolAnnotations,
  },
  {
    name: SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[1],
    description:
      "Record one bounded non-blocking assignment warning in parent-visible run status; repeat it in the final report. Ask a question instead when the risk could invalidate work the parent is doing now.",
    inputSchema: messageInputSchema,
    annotations: toolAnnotations,
  },
  {
    name: SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[2],
    description:
      "Ask the parent this assignment's one correlated blocking question and wait for its exact reply.",
    inputSchema: messageInputSchema,
    annotations: toolAnnotations,
  },
  {
    name: SUPERVISOR_MCP_TOOL_NAMES[3],
    description:
      "Submit the complete bounded final report with a stable delivery identity for explicit idempotent retry.",
    inputSchema: {
      type: "object",
      properties: {
        delivery_id: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
          pattern: SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE,
        },
        report: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SUPERVISOR_MCP_REPORT_CHARS,
          pattern: SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
        },
      },
      required: SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS,
      additionalProperties: false,
    },
    annotations: { ...toolAnnotations, idempotentHint: true },
  },
];

const proxyToolDefinition = {
  name: SUPERVISOR_MCP_PROXY_TOOL_NAME,
  description: "Private delegated-Pi coordinator proxy.",
  inputSchema: {
    type: "object",
    properties: {
      tool: { type: "string", minLength: 1, maxLength: MAX_SUPERVISOR_MCP_PROXY_TOOL_CHARS },
      arguments_json: { type: "string", maxLength: MAX_SUPERVISOR_MCP_PROXY_JSON_CHARS },
    },
    required: SUPERVISOR_MCP_PROXY_ARGUMENT_KEYS,
    additionalProperties: false,
  },
  annotations: toolAnnotations,
} as const;

const decodeToolArguments = <ValueInput>(
  name: string,
  value: ValueInput,
): DecodedToolArguments | undefined => {
  if (name === SUPERVISOR_MCP_PROXY_TOOL_NAME) {
    if (!piBridgeClient || !isSupervisorMcpProxyArguments(value)) return undefined;
    return { kind: "proxy", tool: value.tool, argumentsJson: value.arguments_json };
  }
  if (name === SUPERVISOR_MCP_TOOL_NAMES[3]) {
    if (!isSupervisorMcpReportArguments(value)) return undefined;
    const deliveryId = SupervisorDeliveryIdSchema.makeOption(value.delivery_id);
    if (Option.isNone(deliveryId)) return undefined;
    return { kind: "report", deliveryId: deliveryId.value, report: value.report };
  }
  if (
    !SUPERVISOR_MCP_MESSAGE_TOOL_NAMES.some((toolName) => toolName === name) ||
    !isSupervisorMcpMessageArguments(value)
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
      return {
        method: "initialize",
        id,
        protocolVersion: value.params.protocolVersion,
        piBridge:
          isJsonObject(value.params.clientInfo) &&
          value.params.clientInfo.name === "pi-subagents-pi-bridge",
      };
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

const executeTool = (request: ToolCall, signal: AbortSignal): Promise<McpToolResult> => {
  const args = decodeToolArguments(request.name, request.arguments);
  const malformed = () =>
    Promise.resolve(toolResult("Tool input is malformed, excessive, or unsupported.", true));
  if (!args) return malformed();
  switch (request.name) {
    case SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[0]:
      if (args.kind !== "message") break;
      return callProgress(args.message, signal).then(() =>
        toolResult("Progress delivered to the parent projection."),
      );
    case SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[1]:
      if (args.kind !== "message") break;
      return callWarning(args.message, signal).then(() =>
        toolResult("Warning recorded in parent-visible run status."),
      );
    case SUPERVISOR_MCP_MESSAGE_TOOL_NAMES[2]:
      if (args.kind !== "message") break;
      return callQuestion(args.message, signal).then((result) =>
        toolResult(`Parent reply: ${result.message}`),
      );
    case SUPERVISOR_MCP_TOOL_NAMES[3]:
      if (args.kind !== "report") break;
      return callReport(args.deliveryId, args.report, signal).then((result) =>
        toolResult(
          `${result.duplicate ? "Final report retry accepted" : "Final report accepted"}; sequence ${result.sequence}.`,
        ),
      );
    case SUPERVISOR_MCP_PROXY_TOOL_NAME:
      if (args.kind !== "proxy" || !piBridgeClient) break;
      return callProxy(args.tool, args.argumentsJson, signal).then((result) =>
        toolResult(result.payloadJson, !result.ok),
      );
  }
  return malformed();
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

const toolResponseFromExit = (id: RpcId, exit: Exit.Exit<McpToolResult, McpToolCallFailure>) => {
  if (Exit.isSuccess(exit)) return { jsonrpc: "2.0", id, result: exit.value };
  if (Cause.hasInterruptsOnly(exit.cause))
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32800, message: "MCP request was cancelled." },
    };
  const wrapped = Cause.findErrorOption(exit.cause);
  const failure = Option.isSome(wrapped) ? wrapped.value.failure : undefined;
  const code = failureCode(failure);
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: isCancellationCode(code) ? -32800 : -32000,
      message: failureMessage(failure) ?? "Private supervisor tool delivery failed.",
    },
  };
};

const writeToolResponse = <ValueInput>(value: ValueInput): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => stdout.write(value),
    catch: () => new McpWriteFailure({ reason: "stream" }),
  }).pipe(Effect.catch(() => Effect.sync(failChannel)));

const dispatchMcp = (request: DecodedMcpMessage): void => {
  switch (request.method) {
    case "initialize":
      initialized = true;
      piBridgeClient = request.piBridge;
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
      void Effect.runPromise(FiberMap.remove(activeCalls, rpcKey(request.requestId)));
      return;
    case "ping":
      void sendRpc({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    case "tools/list":
      if (!initialized) {
        void rpcError(request.id, -32002, "MCP helper is not initialized.");
        return;
      }
      void sendRpc({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: piBridgeClient ? [...toolDefinitions, proxyToolDefinition] : toolDefinitions,
        },
      });
      return;
    case "tools/call": {
      if (!initialized) {
        void rpcError(request.id, -32002, "MCP helper is not initialized.");
        return;
      }
      if ([...activeCalls].length >= MAX_CONCURRENT_CALLS) {
        void rpcError(request.id, -32000, "Bounded concurrent MCP call capacity is full.");
        return;
      }
      const key = rpcKey(request.id);
      if (FiberMap.hasUnsafe(activeCalls, key)) {
        void rpcError(request.id, -32600, "An MCP request with this id is already active.");
        return;
      }
      const operation = Effect.tryPromise({
        try: (signal) => executeTool(request, signal),
        catch: <FailureInput>(failure: FailureInput) => new McpToolCallFailure({ failure }),
      });
      // Only the supervisor operation is interruptible. Once its Exit is selected, one narrow
      // uninterruptible writer commit publishes and acknowledges exactly one JSON-RPC response.
      const call = Effect.uninterruptibleMask((restore) =>
        Effect.exit(restore(operation)).pipe(
          Effect.map((exit) => toolResponseFromExit(request.id, exit)),
          Effect.flatMap(writeToolResponse),
        ),
      );
      void Effect.runPromise(
        FiberMap.run(activeCalls, key, { onlyIfMissing: true, startImmediately: true })(call),
      );
      return;
    }
    default:
      if (request.id !== undefined) void rpcError(request.id, -32601, "Method not found.");
  }
};

const main = Effect.gen(function* () {
  const configPath = configArgument();
  if (!configPath)
    return yield* startupFailure("Private supervisor helper configuration argument is invalid.");
  config = yield* readConfig(configPath).pipe(
    Effect.mapError(() =>
      startupFailure("Private supervisor helper could not open its bounded channel configuration."),
    ),
  );
  stdout = yield* makeSerializedWriter(process.stdout);
  activeCalls = yield* FiberMap.make<string>();
  const done = yield* Deferred.make<void>();
  requestMainShutdown = () => {
    Deferred.doneUnsafe(done, Effect.void);
  };

  const openedClient = yield* Effect.gen(function* () {
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
  }).pipe(
    Effect.mapError(() =>
      startupFailure("Private supervisor helper authentication failed or parent channel closed."),
    ),
  );
  const { client, opened } = openedClient;
  supervisorClient = client;
  assignmentEpoch = opened.assignmentEpoch;
  yield* client.SupervisorWatchAssignments(authenticatedPayload()).pipe(
    Stream.runForEach((update) =>
      Effect.gen(function* () {
        if (update.kind === "notification") {
          yield* Effect.tryPromise({
            try: () =>
              stdout.write({
                jsonrpc: "2.0",
                method: "notifications/pi_subagents",
                params: { updateId: update.updateId, message: update.message },
              }),
            catch: () => new McpWriteFailure({ reason: "stream" }),
          });
          yield* client.SupervisorAcknowledgeNotification({
            ...authenticatedPayload(),
            updateId: update.updateId,
          });
          return;
        }
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
    Effect.forkScoped({ startImmediately: true }),
  );

  let inputClosed = false;
  let detachStdin = (): void => {};
  const closeInput = (): void => {
    if (inputClosed) return;
    inputClosed = true;
    detachStdin();
    stdout.close();
    requestMainShutdown();
  };
  const onLine = (line: string): void => {
    const decoded = decodeUnknownJsonOption(line);
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
  };
  let inputFailureStarted = false;
  const onInputFailure = (): void => {
    if (inputFailureStarted || inputClosed) return;
    inputFailureStarted = true;
    void rpcError(null, -32600, "JSON-RPC input exceeds its bounded capacity.").finally(() => {
      process.stdin.destroy();
    });
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      detachStdin = attachBoundedLineParser(process.stdin, {
        maxLineBytes: MAX_LINE_BYTES,
        maxQueuedBytes: MAX_QUEUED_INPUT_BYTES,
        onLine,
        onOverflow: onInputFailure,
      });
      process.stdin.once("end", closeInput);
      process.stdin.once("close", closeInput);
    }),
    () =>
      Effect.sync(() => {
        detachStdin();
        process.stdin.off("end", closeInput);
        process.stdin.off("close", closeInput);
      }),
  );
  // Register last so the writer closes before FiberMap and socket finalizers interrupt calls.
  yield* Effect.addFinalizer(() => Effect.sync(closeInput));
  yield* Deferred.await(done);
});

NodeRuntime.runMain(
  main.pipe(
    Effect.scoped,
    Effect.tapError((error) => Effect.sync(() => fixedDiagnostic(error.diagnostic))),
    Effect.tapDefect(() => Effect.sync(() => fixedDiagnostic("Private supervisor helper failed."))),
  ),
  { disableErrorReporting: true },
);
