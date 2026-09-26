import type { Client } from "@modelcontextprotocol/client";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  openDuplexProcess,
  type DuplexProcessError,
  type DuplexProcessHandle,
  type DuplexProcessOptions,
} from "pi-cosmic-core";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import { decodeSdkExchange } from "./sdk-elicitation.ts";
import { mapSdkClientError } from "./sdk-protocol-error.ts";
import { selectProtocol } from "./mcp-protocol/select.ts";
import { boundedSdkCleanup } from "./mcp-protocol/shared/bounded-cleanup.ts";
import { negotiateStdio } from "./mcp-protocol/shared/stdio-negotiation.ts";
import {
  MCP_BOUNDARY_LIMITS,
  type McpConnection,
  type McpRequest,
  type McpDispatchOptions,
} from "../client/model.ts";
import { makeSdkEvents, type SdkConnectionState, type SdkEvents } from "./sdk-events.ts";
import { decodeMcpRequest, executeSdkRequest, makeSdkClient } from "./sdk-client.ts";
import { boundedInt, openSdkConnection, SdkLimitFields } from "./sdk-lifecycle.ts";
import {
  makeSdkStdioTransport,
  SdkStdioTransportError,
  type SdkStdioTransport,
} from "./sdk-stdio-transport.ts";

const OptionsSchema = Schema.Struct({
  ...SdkLimitFields,
  command: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  /** Exact child environment. No parent environment is inherited implicitly. */
  environment: Schema.Record(Schema.String.check(Schema.isMinLength(1)), Schema.String),
  stderrBytes: boundedInt(0, 64 * 1024 * 1024).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(MCP_BOUNDARY_LIMITS.stderrBytes)),
  ),
});

export type SdkStdioOptions = typeof OptionsSchema.Encoded & {
  /** Installed before acquisition; reports full local cleanup, including failed startup. */
  readonly onCleanup?: (confirmed: boolean) => void;
};

const snapshotOptions = (options: SdkStdioOptions) =>
  Effect.try({
    try: () => {
      const decoded = Schema.decodeUnknownSync(OptionsSchema)(options);
      if (options.onCleanup !== undefined && !Predicate.isFunction(options.onCleanup)) {
        throw new Error("Invalid cleanup observer.");
      }
      return Object.freeze({
        ...decoded,
        onCleanup: options.onCleanup,
        args: Object.freeze([...decoded.args]),
        environment: Object.freeze({ ...decoded.environment }),
      });
    },
    catch: () => boundaryError("invalid-input", "not-sent", "Invalid MCP stdio options."),
  });

type SdkStdioSnapshot = Effect.Success<ReturnType<typeof snapshotOptions>>;

const labels = {
  deadline: "MCP stdio acquisition deadline expired.",
  cleanup: "MCP stdio cleanup was not confirmed.",
};

const cleanupFailure = () => boundaryError("cleanup", "unknown", labels.cleanup);

const processFailure = (error: DuplexProcessError): McpBoundaryError => {
  if (error.operation === "cleanup" || error.operation === "close") return cleanupFailure();
  if (error.reason === "timeout") {
    return boundaryError("timeout", "not-sent", "MCP stdio operation timed out.");
  }
  if (error.reason === "unsupported-platform") {
    return boundaryError("unavailable", "not-sent", "MCP stdio is unavailable on this platform.");
  }
  return boundaryError("transport", "not-sent", "MCP stdio transport failed.");
};

const transportFailure = <Value>(
  error: Value,
  outcome: McpBoundaryError["outcome"],
): McpBoundaryError => {
  if (error instanceof SdkStdioTransportError) {
    switch (error.kind) {
      case "input-limit":
        return boundaryError(
          "invalid-input",
          "not-sent",
          "MCP stdio request exceeds its byte limit.",
        );
      case "output-limit":
        return boundaryError("output-limit", outcome, "MCP stdio output exceeds its byte limit.");
      case "not-started":
      case "closed":
        return boundaryError("connection", "not-sent", "MCP stdio connection is unavailable.");
      case "cancelled":
        return boundaryError("cancelled", outcome, "MCP request was cancelled.");
      default:
        return boundaryError("transport", outcome, "MCP stdio transport failed.");
    }
  }
  // Public protocol errors are terminal replies. During acquisition no application
  // request has been sent; after dispatch, preserve the reply evidence.
  return (
    mapSdkClientError(
      error,
      outcome === "not-sent" ? "not-sent" : "completed",
      "MCP stdio connection is unavailable.",
    ) ?? boundaryError("transport", outcome, "MCP stdio transport failed.")
  );
};

const closeProcess = (process: DuplexProcessHandle): Effect.Effect<void, McpBoundaryError> =>
  process.close.pipe(
    Effect.mapError(cleanupFailure),
    Effect.andThen(process.cleanupState),
    Effect.flatMap((state) =>
      state === "confirmed" ? Effect.void : Effect.fail(cleanupFailure()),
    ),
  );

const closeSdk = (
  client: Client,
  transport: SdkStdioTransport,
  process: DuplexProcessHandle,
  cleanupTimeoutMs: number,
): Effect.Effect<void, McpBoundaryError> =>
  Effect.gen(function* () {
    // Revoke transport admission even if connect failed before SDK ownership.
    const sdk = yield* boundedSdkCleanup(
      () =>
        Promise.allSettled([transport.close(), client.close()]).then((settled) => {
          if (settled.some((result) => result.status === "rejected")) throw cleanupFailure();
        }),
      cleanupTimeoutMs,
      cleanupFailure(),
    ).pipe(Effect.result);
    yield* closeProcess(process);
    if (sdk._tag === "Failure") return yield* sdk.failure;
  });

const stdioExchange =
  (
    client: Client,
    transport: SdkStdioTransport,
    snapshot: SdkStdioSnapshot,
    state: SdkConnectionState,
    events: SdkEvents,
  ) =>
  (input: McpRequest, options?: McpDispatchOptions) =>
    decodeMcpRequest(input).pipe(
      Effect.flatMap((decoded) =>
        Effect.suspend(() => {
          if (state.closing) {
            return Effect.fail(
              boundaryError("connection", "not-sent", "MCP stdio connection is unavailable."),
            );
          }
          return Effect.tryPromise({
            try: (signal) =>
              events.withProgress(options, (dispatch) =>
                executeSdkRequest(
                  client,
                  decoded,
                  {
                    signal,
                    timeout: snapshot.requestTimeoutMs,
                    maxTotalTimeout: snapshot.requestTimeoutMs,
                  },
                  dispatch,
                ),
              ),
            catch: (error) => transportFailure(transport.failure ?? error, "unknown"),
          }).pipe(
            Effect.flatMap((result) => decodeSdkExchange(decoded.action, result)),
            Effect.timeoutOrElse({
              duration: Duration.millis(snapshot.requestTimeoutMs),
              orElse: () =>
                Effect.fail(boundaryError("timeout", "unknown", "MCP request timed out.")),
            }),
          );
        }),
      ),
    );

/** Open and initialize one scoped macOS stdio SDK connection. */
export const openSdkStdio = (
  options: SdkStdioOptions,
): Effect.Effect<McpConnection, McpBoundaryError, Scope.Scope> =>
  Effect.gen(function* () {
    const snapshot = yield* snapshotOptions(options);
    let events: SdkEvents | undefined;
    return yield* openSdkConnection({
      transport: "stdio",
      labels,
      snapshot,
      events: () => events,
      connect: ({ state, remaining, restore, setCleanup }) =>
        Effect.gen(function* () {
          const openNative = Effect.gen(function* () {
            const budget = yield* remaining;
            const processOptions: DuplexProcessOptions = {
              command: snapshot.command,
              args: snapshot.args,
              environment: snapshot.environment,
              maxReadQueueBytes: snapshot.responseBytes,
              maxStderrBytes: snapshot.stderrBytes,
              maxStderrQueueBytes: Math.max(1, snapshot.stderrBytes),
              maxWriteBytes: snapshot.requestBytes,
              maxWriteQueueBytes: snapshot.requestBytes,
              writeTimeoutMs: snapshot.requestTimeoutMs,
              startTimeoutMs: budget,
              cleanupTimeoutMs: snapshot.cleanupTimeoutMs,
              onCleanup: (confirmed) => {
                if (!confirmed) state.cleanupUnconfirmed = true;
              },
            };
            const process = yield* restore(
              openDuplexProcess(
                snapshot.cwd === undefined
                  ? processOptions
                  : { ...processOptions, cwd: snapshot.cwd },
              ).pipe(
                Effect.mapError(processFailure),
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    if (error.kind === "cleanup") state.cleanupUnconfirmed = true;
                  }),
                ),
              ),
            );
            setCleanup(closeProcess(process));
            const client = yield* makeSdkClient(
              snapshot.protocol,
              Math.max(1, Math.min(1_000, Math.floor(budget / 3))),
            );
            const transport = yield* makeSdkStdioTransport(process, {
              maxBufferSize: snapshot.responseBytes,
              maxWriteBytes: snapshot.requestBytes,
            });
            const nativeClose = closeSdk(client, transport, process, snapshot.cleanupTimeoutMs);
            setCleanup(nativeClose);
            return { client, transport, close: nativeClose };
          });
          const prior =
            snapshot.protocol === "legacy"
              ? { kind: "legacy" as const }
              : yield* negotiateStdio(openNative, remaining);
          // negotiateStdio returns only after its scoped child and native cleanup join.
          if (state.cleanupUnconfirmed) return yield* cleanupFailure();
          const { client, transport } = yield* openNative;
          const acquiredEvents = yield* makeSdkEvents(client, state, undefined, {
            timeoutMs: snapshot.cleanupTimeoutMs,
            requireCancellationWrite: true,
          });
          events = acquiredEvents;
          const budget = yield* remaining;
          yield* restore(
            Effect.tryPromise({
              try: (signal) =>
                client.connect(acquiredEvents.bindTransport(transport), {
                  signal,
                  timeout: budget,
                  maxTotalTimeout: budget,
                  prior,
                }),
              catch: (error) => transportFailure(transport.failure ?? error, "not-sent"),
            }).pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(budget),
                orElse: () =>
                  Effect.fail(
                    boundaryError("timeout", "unknown", "MCP stdio connection timed out."),
                  ),
              }),
            ),
          );
          return {
            client,
            events: acquiredEvents,
            protocol: yield* selectProtocol(client),
            exchange: () => stdioExchange(client, transport, snapshot, state, acquiredEvents),
          };
        }),
    });
  });
