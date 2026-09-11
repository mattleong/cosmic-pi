import {
  isInputRequiredResult,
  MissingRequiredClientCapabilityError,
  SdkError,
  SdkErrorCode,
  ProtocolError,
  UnsupportedProtocolVersionError,
  UrlElicitationRequiredError,
  type Client,
} from "@modelcontextprotocol/client";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  openDuplexProcess,
  type DuplexProcessError,
  type DuplexProcessHandle,
  type DuplexProcessOptions,
} from "pi-cosmic-core";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import { mapSdkProtocolError } from "./sdk-protocol-error.ts";
import {
  MCP_BOUNDARY_LIMITS,
  type McpCapabilities,
  type McpConnection,
  type McpRequest,
} from "../client/model.ts";
import {
  makeSdkEvents,
  observeSdkCleanup,
  sdkCapabilities,
  type SdkConnectionState,
  type SdkEvents,
} from "./sdk-events.ts";
import {
  decodeMcpReply,
  decodeMcpRequest,
  executeSdkRequest,
  makeSdkClient,
  sdkHandshake,
} from "./sdk-client.ts";
import {
  makeSdkStdioTransport,
  SdkStdioTransportError,
  type SdkStdioTransport,
} from "./sdk-stdio-transport.ts";

export interface SdkStdioOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  /** Exact child environment. No parent environment is inherited implicitly. */
  readonly environment: Readonly<Record<string, string>>;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  readonly stderrBytes?: number;
  /** Installed before acquisition; reports full local cleanup, including failed startup. */
  readonly onCleanup?: (confirmed: boolean) => void;
}

const positive = (maximum: number) =>
  Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(maximum),
  );
const OptionsSchema = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  environment: Schema.Record(Schema.String.check(Schema.isMinLength(1)), Schema.String),
  connectTimeoutMs: Schema.optionalKey(positive(600_000)),
  requestTimeoutMs: Schema.optionalKey(positive(3_600_000)),
  cleanupTimeoutMs: Schema.optionalKey(positive(30_000)),
  requestBytes: Schema.optionalKey(positive(64 * 1024 * 1024)),
  responseBytes: Schema.optionalKey(positive(64 * 1024 * 1024)),
  stderrBytes: Schema.optionalKey(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(64 * 1024 * 1024),
    ),
  ),
});

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
        connectTimeoutMs: decoded.connectTimeoutMs ?? MCP_BOUNDARY_LIMITS.connectTimeoutMs,
        requestTimeoutMs: decoded.requestTimeoutMs ?? MCP_BOUNDARY_LIMITS.requestTimeoutMs,
        cleanupTimeoutMs: decoded.cleanupTimeoutMs ?? MCP_BOUNDARY_LIMITS.cleanupTimeoutMs,
        requestBytes: decoded.requestBytes ?? MCP_BOUNDARY_LIMITS.requestBytes,
        responseBytes: decoded.responseBytes ?? MCP_BOUNDARY_LIMITS.responseBytes,
        stderrBytes: decoded.stderrBytes ?? MCP_BOUNDARY_LIMITS.stderrBytes,
      });
    },
    catch: () => boundaryError("invalid-input", "not-sent", "Invalid MCP stdio options."),
  });

type SdkStdioSnapshot = Effect.Success<ReturnType<typeof snapshotOptions>>;

const processFailure = (error: DuplexProcessError): McpBoundaryError => {
  if (error.operation === "cleanup" || error.operation === "close") {
    return boundaryError("cleanup", "unknown", "MCP stdio cleanup was not confirmed.");
  }
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
  if (
    error instanceof UrlElicitationRequiredError ||
    error instanceof MissingRequiredClientCapabilityError ||
    error instanceof UnsupportedProtocolVersionError
  ) {
    // These public protocol errors are terminal replies. During acquisition no
    // application request has been sent; after dispatch, preserve the reply evidence.
    return boundaryError(
      "unsupported",
      outcome === "not-sent" ? "not-sent" : "completed",
      "MCP server requires an unsupported interaction, capability, or protocol version.",
    );
  }
  if (error instanceof ProtocolError)
    return mapSdkProtocolError(error, outcome === "not-sent" ? "not-sent" : "completed");
  if (error instanceof SdkError) {
    switch (error.code) {
      case SdkErrorCode.RequestTimeout:
        return boundaryError("timeout", "unknown", "MCP request timed out.");
      case SdkErrorCode.InvalidResult:
      case SdkErrorCode.UnsupportedResultType:
        return boundaryError("protocol", "completed", "MCP returned an invalid result.");
      case SdkErrorCode.NotConnected:
      case SdkErrorCode.NotInitialized:
      case SdkErrorCode.AlreadyConnected:
        return boundaryError("connection", "not-sent", "MCP stdio connection is unavailable.");
      default:
        return boundaryError("transport", outcome, "MCP stdio transport failed.");
    }
  }
  return boundaryError("transport", outcome, "MCP stdio transport failed.");
};

const cleanupFailure = () =>
  boundaryError("cleanup", "unknown", "MCP stdio cleanup was not confirmed.");

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
    const sdk = yield* Effect.tryPromise({
      // Revoke transport admission even if connect failed before SDK ownership.
      try: () => Promise.all([transport.close(), client.close()]),
      catch: cleanupFailure,
    }).pipe(
      // Only the deadline's child wait is interruptible, not cached cleanup.
      Effect.interruptible,
      Effect.timeoutOrElse({
        duration: Duration.millis(cleanupTimeoutMs),
        orElse: () => Effect.fail(cleanupFailure()),
      }),
      Effect.result,
    );
    yield* closeProcess(process);
    if (sdk._tag === "Failure") return yield* sdk.failure;
  });

const makeConnection = (
  client: Client,
  transport: SdkStdioTransport,
  snapshot: SdkStdioSnapshot,
  state: SdkConnectionState,
  close: Effect.Effect<void, McpBoundaryError>,
  capabilities: McpCapabilities,
  events: SdkEvents,
  handshake: Pick<McpConnection, "protocolVersion" | "instructions">,
): McpConnection => ({
  capabilities,
  ...handshake,
  changes: events.changes,
  terminal: events.terminal,
  health: events.health,
  setToken: () => Effect.void,
  request: (input: McpRequest) =>
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
              executeSdkRequest(client, decoded, {
                signal,
                timeout: snapshot.requestTimeoutMs,
                maxTotalTimeout: snapshot.requestTimeoutMs,
              }),
            catch: (error) => transportFailure(transport.failure ?? error, "unknown"),
          }).pipe(
            Effect.flatMap((result) =>
              isInputRequiredResult(result)
                ? Effect.fail(
                    boundaryError(
                      "unsupported",
                      "completed",
                      "MCP input requests are unsupported.",
                    ),
                  )
                : decodeMcpReply(decoded.action, result),
            ),
            Effect.timeoutOrElse({
              duration: Duration.millis(snapshot.requestTimeoutMs),
              orElse: () =>
                Effect.fail(boundaryError("timeout", "unknown", "MCP request timed out.")),
            }),
          );
        }),
      ),
    ),
  close,
});

/** Open and initialize one scoped macOS stdio SDK connection. */
export const openSdkStdio = (
  options: SdkStdioOptions,
): Effect.Effect<McpConnection, McpBoundaryError, Scope.Scope> =>
  snapshotOptions(options).pipe(
    Effect.flatMap((snapshot) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const owner = yield* Scope.fork(yield* Effect.scope);
          const state: SdkConnectionState = {
            closing: false,
            closed: false,
            cleanupUnconfirmed: false,
          };
          let events: SdkEvents | undefined;
          let opening: Fiber.Fiber<McpConnection, McpBoundaryError> | undefined;
          let cleanup: Effect.Effect<void, McpBoundaryError> = Effect.void;
          // The owned cleanup and its cached result stay masked. Interrupting
          // the first caller cannot cache an interrupted, incomplete close.
          // Native cleanup retains its own bounded escalation policy.
          const cachedClose = yield* Effect.cached(
            Effect.uninterruptible(
              Effect.sync(() => {
                state.closing = true;
              }).pipe(
                // Scope replacement joins initialization before observing cleanup.
                Effect.andThen(
                  Effect.suspend(() =>
                    opening === undefined ? Effect.void : Fiber.interrupt(opening),
                  ),
                ),
                Effect.andThen(Effect.suspend(() => cleanup)),
                Effect.ensuring(Scope.close(owner, Exit.void)),
                Effect.exit,
                Effect.flatMap((exit) => {
                  state.closed = true;
                  state.cleanupUnconfirmed ||= Exit.isFailure(exit);
                  observeSdkCleanup(snapshot.onCleanup, !state.cleanupUnconfirmed);
                  const failure = state.cleanupUnconfirmed ? cleanupFailure() : undefined;
                  events?.finish(failure);
                  return failure === undefined ? Effect.void : Effect.fail(failure);
                }),
              ),
            ),
          );
          const close = Effect.uninterruptible(cachedClose);
          yield* Effect.addFinalizer(() => close.pipe(Effect.ignore));
          const acquire = Effect.gen(function* () {
            if (state.closing)
              return yield* boundaryError(
                "connection",
                "not-sent",
                "MCP connection is unavailable.",
              );
            const processOptions: DuplexProcessOptions = {
              command: snapshot.command,
              args: snapshot.args,
              environment: snapshot.environment,
              maxBufferBytes: snapshot.responseBytes,
              maxReadQueueBytes: snapshot.responseBytes,
              maxStderrBytes: snapshot.stderrBytes,
              maxStderrQueueBytes: Math.max(1, snapshot.stderrBytes),
              maxWriteBytes: snapshot.requestBytes,
              maxWriteQueueBytes: snapshot.requestBytes,
              writeTimeoutMs: snapshot.requestTimeoutMs,
              startTimeoutMs: snapshot.connectTimeoutMs,
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
            cleanup = closeProcess(process);
            const client = yield* makeSdkClient();
            const acquiredEvents = yield* makeSdkEvents(client, state);
            events = acquiredEvents;
            const transport = yield* makeSdkStdioTransport(process, {
              maxBufferSize: snapshot.responseBytes,
              maxWriteBytes: snapshot.requestBytes,
            });
            cleanup = closeSdk(client, transport, process, snapshot.cleanupTimeoutMs);
            yield* restore(
              Effect.tryPromise({
                try: (signal) =>
                  client.connect(transport, { signal, timeout: snapshot.connectTimeoutMs }),
                catch: (error) => transportFailure(transport.failure ?? error, "not-sent"),
              }).pipe(
                Effect.timeoutOrElse({
                  duration: Duration.millis(snapshot.connectTimeoutMs),
                  orElse: () =>
                    Effect.fail(
                      boundaryError("timeout", "unknown", "MCP stdio connection timed out."),
                    ),
                }),
              ),
            );
            return makeConnection(
              client,
              transport,
              snapshot,
              state,
              close,
              yield* sdkCapabilities(client),
              acquiredEvents,
              yield* sdkHandshake(client),
            );
          }).pipe(Effect.provideService(Scope.Scope, owner));
          opening = yield* Effect.forkIn(acquire, owner, { uninterruptible: true });
          return yield* restore(Fiber.join(opening)).pipe(
            Effect.catchCause((cause) =>
              (Cause.hasInterrupts(cause) ? close.pipe(Effect.ignore) : close).pipe(
                Effect.andThen(Effect.failCause(cause)),
              ),
            ),
          );
        }),
      ),
    ),
  );
