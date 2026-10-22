#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import { constVoid } from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
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
import { decodeSupervisorToolCall, runSupervisorTool } from "../supervisor/tool-call.ts";
import { openSupervisorClient } from "./supervisor-client.ts";
import { configArgument, readConfig } from "./supervisor-mcp-config.ts";
import { serializedWriter } from "./supervisor-mcp-writer.ts";

const scrubEnvironment = (environment: NodeJS.ProcessEnv): void => {
  for (const key of Object.keys(environment)) delete environment[key];
};
scrubEnvironment(process.env);

const SERVER_NAME = "pi-subagents-supervisor";

class HelperStartupFailure extends Schema.TaggedError<HelperStartupFailure>()(
  "HelperStartupFailure",
  { diagnostic: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = 2;
  override readonly [Runtime.errorReported] = false;
}

const startupFailure = (diagnostic: string) => new HelperStartupFailure({ diagnostic });
const SERVER_VERSION = "3.0.0";
const MAX_QUEUED_INPUT_BYTES = 2 * MAX_SUPERVISOR_CHANNEL_LINE_BYTES;
const MAX_CONCURRENT_CALLS = 16;

const fixedDiagnostic = (message: string): void => {
  const text = boundedString(message, 512) ? message : "Private supervisor helper failed.";
  process.stderr.write(`${text}\n`);
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
  const stdout = yield* serializedWriter(process.stdout);
  const activeCalls = yield* FiberMap.make<string>();
  const done = yield* Deferred.make<void>();
  // Stdin callbacks start their writes here, so main's scope interrupts any still outstanding.
  const runPromise = yield* FiberSet.makeRuntimePromise();
  let channelClosed = false;
  let initialized = false;

  const failChannel = (): void => {
    if (channelClosed) return;
    channelClosed = true;
    process.stdin.destroy();
    Deferred.doneUnsafe(done, Effect.void);
  };

  const sendRpc = (message: Schema.Json): Promise<void> =>
    runPromise(stdout.write(message)).catch(() => {
      failChannel();
    });

  const rpcError = (id: RpcId | null, code: number, message: string): Promise<void> =>
    sendRpc({ jsonrpc: "2.0", id, error: { code, message } });

  const supervisor = yield* openSupervisorClient(config).pipe(
    Effect.mapError(() =>
      startupFailure("Private supervisor helper authentication failed or parent channel closed."),
    ),
  );
  yield* Deferred.await(supervisor.closed).pipe(
    Effect.andThen(Effect.sync(failChannel)),
    Effect.forkScoped({ startImmediately: true }),
  );

  const writeToolResponse = (value: Schema.Json): Effect.Effect<void> =>
    stdout.write(value).pipe(Effect.catch(() => Effect.sync(failChannel)));

  // Each call writes exactly one response; a call cancelled after the parent's reply was consumed
  // still writes that reply.
  const executeTool = (request: ToolCall): Effect.Effect<void> => {
    const call = decodeSupervisorToolCall(request.name, request.arguments);
    return Result.isSuccess(call)
      ? runSupervisorTool(
          supervisor,
          call.success,
          (exit) =>
            writeToolResponse(
              toolResponseFromExit(
                request.id,
                Exit.map(exit, (result) => toolResult(result.text, result.isError)),
              ),
            ),
          { nativeThreadId: request.nativeThreadId },
        )
      : Effect.uninterruptible(
          writeToolResponse(
            toolResponseFromExit(
              request.id,
              Exit.succeed(toolResult(`Not delivered: ${call.failure}`, true)),
            ),
          ),
        );
  };

  const dispatchMcp = (request: DecodedMcpMessage): void => {
    if (!initialized && (request.method === "tools/list" || request.method === "tools/call")) {
      rpcError(request.id, -32002, "MCP helper is not initialized.").catch(failChannel);
      return;
    }
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
        }).catch(failChannel);
        break;
      case "notifications/initialized":
        break;
      case "notifications/cancelled":
        runPromise(FiberMap.remove(activeCalls, rpcKey(request.requestId))).catch(failChannel);
        break;
      case "ping":
        sendRpc({ jsonrpc: "2.0", id: request.id, result: {} }).catch(failChannel);
        break;
      case "tools/list":
        sendRpc({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: toolDefinitions },
        }).catch(failChannel);
        break;
      case "tools/call": {
        if ([...activeCalls].length >= MAX_CONCURRENT_CALLS) {
          rpcError(request.id, -32000, "Bounded concurrent MCP call capacity is full.").catch(
            failChannel,
          );
          return;
        }
        const key = rpcKey(request.id);
        if (FiberMap.hasUnsafe(activeCalls, key)) {
          rpcError(request.id, -32600, "An MCP request with this id is already active.").catch(
            failChannel,
          );
          return;
        }
        runPromise(
          FiberMap.run(activeCalls, key, { onlyIfMissing: true, startImmediately: true })(
            executeTool(request),
          ),
        ).catch(failChannel);
        break;
      }
      case "unknown":
        if (request.id !== undefined)
          rpcError(request.id, -32601, "Method not found.").catch(failChannel);
    }
  };

  let inputClosed = false;
  let detachStdin: () => void = constVoid;
  const closeInput = (): void => {
    if (inputClosed) return;
    inputClosed = true;
    detachStdin();
    stdout.close();
    Deferred.doneUnsafe(done, Effect.void);
  };
  const onLine = (line: string): void => {
    const decoded = decodeUnknownJsonOption(line);
    if (Option.isNone(decoded)) {
      rpcError(null, -32700, "Parse error.").catch(failChannel);
      return;
    }
    const value = decoded.value;
    const request = decodeMcpMessage(value);
    if (!request) {
      const id = isJsonObject(value) && validRpcId(value.id) ? value.id : null;
      rpcError(id, -32600, "Invalid or excessive JSON-RPC request.").catch(failChannel);
      return;
    }
    dispatchMcp(request);
  };
  let inputFailureStarted = false;
  const onInputFailure = (): void => {
    if (inputFailureStarted || inputClosed) return;
    inputFailureStarted = true;
    rpcError(null, -32600, "JSON-RPC input exceeds its bounded capacity.")
      .finally(() => {
        process.stdin.destroy();
      })
      .catch(failChannel);
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      detachStdin = attachBoundedLineParser(process.stdin, {
        maxLineBytes: MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
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
  yield* Effect.addFinalizer(() => Effect.sync(closeInput));
  yield* Deferred.await(done);
  return undefined;
});

NodeRuntime.runMain(
  main.pipe(
    Effect.scoped,
    Effect.tapError((error) => Effect.sync(() => fixedDiagnostic(error.diagnostic))),
    Effect.tapDefect(() => Effect.sync(() => fixedDiagnostic("Private supervisor helper failed."))),
  ),
  { disableErrorReporting: true },
);
