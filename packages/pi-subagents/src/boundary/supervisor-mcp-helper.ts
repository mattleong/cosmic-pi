#!/usr/bin/env node
// The executable MCP edge deliberately owns native stdio and no-follow config reads.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import { isJsonObject } from "pi-cosmic-core";
import { attachBoundedLineParser } from "./bounded-line-parser.ts";
import { decodeUnknownJsonOption } from "./wire-shared.ts";
import { MAX_SUPERVISOR_CHANNEL_LINE_BYTES } from "../supervisor/protocol.ts";
import {
  boundedString,
  validRpcId,
  rpcKey,
  toolDefinitions,
  decodeMcpMessage,
  toolResult,
  toolResponseFromExit,
  type RpcId,
  type DecodedMcpMessage,
  type ToolCall,
} from "../supervisor/mcp-wire.ts";
import {
  decodeSupervisorToolCall,
  runSupervisorTool,
  type SupervisorToolClient,
} from "../supervisor/tool-call.ts";
import { openSupervisorClient } from "./supervisor-client.ts";
import { configArgument, readConfig } from "./supervisor-mcp-config.ts";
import { makeSerializedWriter } from "./supervisor-mcp-writer.ts";

// The helper scrubs its entire inherited environment snapshot before any other work.
const scrubEnvironment = (environment: NodeJS.ProcessEnv): void => {
  for (const key of Object.keys(environment)) delete environment[key];
};
scrubEnvironment(process.env);

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

const fixedDiagnostic = <MessageInput>(message: MessageInput): void => {
  const text = boundedString(message, 512) ? message : "Private supervisor helper failed.";
  process.stderr.write(`${text}\n`);
};

let stdout: Effect.Success<ReturnType<typeof makeSerializedWriter>>;
let activeCalls: FiberMap.FiberMap<string>;
let supervisor: SupervisorToolClient;
let channelClosed = false;
let initialized = false;
let requestMainShutdown = (): void => {};

const failChannel = (): void => {
  if (channelClosed) return;
  channelClosed = true;
  process.stdin.destroy();
  requestMainShutdown();
};

const sendRpc = <MessageInput>(message: MessageInput): Promise<void> =>
  Effect.runPromise(stdout.write(message)).catch(() => {
    failChannel();
  });

const rpcError = (id: RpcId | null, code: number, message: string): Promise<void> =>
  sendRpc({ jsonrpc: "2.0", id, error: { code, message } });

const executeTool = (request: ToolCall) => {
  const call = decodeSupervisorToolCall(request.name, request.arguments);
  return call
    ? runSupervisorTool(supervisor, call).pipe(
        Effect.map((result) => toolResult(result.text, result.isError)),
      )
    : Effect.succeed(toolResult("Tool input is malformed, excessive, or unsupported.", true));
};

const writeToolResponse = <ValueInput>(value: ValueInput): Effect.Effect<void> =>
  stdout.write(value).pipe(Effect.catch(() => Effect.sync(failChannel)));

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
        result: { tools: toolDefinitions },
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
      // Only the supervisor operation is interruptible. Once its Exit is selected, one narrow
      // uninterruptible writer commit publishes and acknowledges exactly one JSON-RPC response.
      const call = Effect.uninterruptibleMask((restore) =>
        Effect.exit(restore(executeTool(request))).pipe(
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
  const config = yield* readConfig(configPath).pipe(
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

  supervisor = yield* openSupervisorClient(config).pipe(
    Effect.mapError(() =>
      startupFailure("Private supervisor helper authentication failed or parent channel closed."),
    ),
  );
  yield* Deferred.await(supervisor.closed).pipe(
    Effect.andThen(Effect.sync(failChannel)),
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
