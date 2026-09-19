#!/usr/bin/env node
// The executable MCP edge deliberately owns native stdio and no-follow config reads.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Stream from "effect/Stream";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { isJsonObject } from "pi-cosmic-core";
import { randomUUID } from "node:crypto";
import { attachBoundedLineParser } from "./bounded-line-parser.ts";
import { decodeUnknownJsonOption } from "./wire-shared.ts";
import {
  MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
  SUPERVISOR_CHANNEL_VERSION,
  SupervisorChannelIdSchema,
  SupervisorDeliveryIdSchema,
  type SupervisorChannelConfig,
  SupervisorRpcFailure,
  SupervisorRpcGroup,
} from "../supervisor/protocol.ts";
import {
  SUPERVISOR_MCP_MESSAGE_TOOL_NAMES,
  SUPERVISOR_MCP_PROXY_TOOL_NAME,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";
import {
  boundedString,
  validRpcId,
  rpcKey,
  toolDefinitions,
  proxyToolDefinition,
  decodeToolArguments,
  decodeMcpMessage,
  toolResult,
  toolResponseFromExit,
  McpToolCallFailure,
  type RpcId,
  type DecodedMcpMessage,
  type ToolCall,
  type McpToolResult,
} from "../supervisor/mcp-wire.ts";
import { configArgument, readConfig } from "./supervisor-mcp-config.ts";
import { makeSerializedWriter, McpWriteFailure } from "./supervisor-mcp-writer.ts";

// The helper scrubs its entire inherited environment snapshot before any other work.
const scrubEnvironment = (environment: NodeJS.ProcessEnv): void => {
  for (const key of Object.keys(environment)) delete environment[key];
};
scrubEnvironment(process.env);

const VERSION = SUPERVISOR_CHANNEL_VERSION;
const SERVER_NAME = "pi-subagents-supervisor";

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
const MAX_CONCURRENT_CALLS = 16;
const CHANNEL_TIMEOUT_MILLIS = 10_000;
const CONNECT_TIMEOUT_MILLIS = 5_000;

interface SerializedWriter {
  readonly write: <ValueInput>(value: ValueInput) => Promise<void>;
  readonly close: () => void;
}

const fixedDiagnostic = <MessageInput>(message: MessageInput): void => {
  const text = boundedString(message, 512) ? message : "Private supervisor helper failed.";
  process.stderr.write(`${text}\n`);
};

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

const executeTool = (request: ToolCall, signal: AbortSignal): Promise<McpToolResult> => {
  const args = decodeToolArguments(request.name, request.arguments, piBridgeClient);
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
  const configPath = configArgument(process.argv);
  if (!configPath)
    return yield* startupFailure("Private supervisor helper configuration argument is invalid.");
  config = yield* readConfig(configPath).pipe(
    Effect.mapError(() =>
      startupFailure("Private supervisor helper could not open its bounded channel configuration."),
    ),
  );
  const writer = yield* makeSerializedWriter(process.stdout);
  const runWriter = Effect.runPromiseWith(yield* Effect.context<never>());
  stdout = { write: (value) => runWriter(writer.write(value)), close: writer.close };
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
