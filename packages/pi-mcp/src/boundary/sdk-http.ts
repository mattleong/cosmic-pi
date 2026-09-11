import {
  Client,
  isInputRequiredResult,
  StreamableHTTPClientTransport,
  type FetchLike,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import * as Scope from "effect/Scope";
import { McpBoundaryError, boundaryError } from "../client/errors.ts";
import {
  MCP_BOUNDARY_LIMITS,
  McpRequestSchema,
  type McpConnection,
  type McpCapabilities,
  type McpReply,
  type McpRequest,
} from "../client/model.ts";
import {
  decodeMcpReply,
  decodeMcpRequest,
  executeSdkRequest,
  makeSdkClient,
  sdkHandshake,
} from "./sdk-client.ts";
import { SDK_OPERATION_HEADER, makeSdkFetch } from "./sdk-fetch.ts";
import {
  makeSdkEvents,
  observeSdkCleanup,
  sdkCapabilities,
  type SdkConnectionState,
  type SdkEvents,
} from "./sdk-events.ts";
import { makeSdkHttpControl } from "./sdk-http-control.ts";
import {
  closeSdkTransport,
  makeSdkHttpTransport,
  mapSdkFailure,
  SdkHttpOperationRegistry,
  type SdkHttpTransportOperation,
} from "./sdk-http-transport.ts";

export interface SdkHttpOptions {
  readonly url: URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly token?: string;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  /** Explicit test/I/O seam. The eventual model-facing gateway does not accept this. */
  readonly fetch?: FetchLike;
  /** Installed before acquisition; reports full local cleanup, including failed startup. */
  readonly onCleanup?: (confirmed: boolean) => void;
}

interface SdkHttpSnapshot {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly token: string | undefined;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly fetch: FetchLike | undefined;
  readonly onCleanup: ((confirmed: boolean) => void) | undefined;
}

interface TokenState {
  value: string | undefined;
  readonly headers: Record<string, string>;
}

const MAX_CONNECT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_REQUEST_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_CLEANUP_TIMEOUT_MS = 30 * 1_000;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const invalidHttpOptions = () =>
  boundaryError("invalid-input", "not-sent", "Invalid MCP HTTP options.");

const positiveBounded = (
  value: number | undefined,
  fallback: number,
  maximum: number,
): number | undefined => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return undefined;
  }
  return value;
};

const snapshotOptions = (
  options: SdkHttpOptions,
): Effect.Effect<SdkHttpSnapshot, McpBoundaryError> =>
  Effect.try({
    try: () => {
      if (!(options.url instanceof URL)) throw invalidHttpOptions();
      if (
        (options.url.protocol !== "http:" && options.url.protocol !== "https:") ||
        options.url.username !== "" ||
        options.url.password !== ""
      ) {
        throw invalidHttpOptions();
      }
      if (options.fetch !== undefined && !Predicate.isFunction(options.fetch)) {
        throw invalidHttpOptions();
      }

      const connectTimeoutMs = positiveBounded(
        options.connectTimeoutMs,
        MCP_BOUNDARY_LIMITS.connectTimeoutMs,
        MAX_CONNECT_TIMEOUT_MS,
      );
      const requestTimeoutMs = positiveBounded(
        options.requestTimeoutMs,
        MCP_BOUNDARY_LIMITS.requestTimeoutMs,
        MAX_REQUEST_TIMEOUT_MS,
      );
      const cleanupTimeoutMs = positiveBounded(
        options.cleanupTimeoutMs,
        MCP_BOUNDARY_LIMITS.cleanupTimeoutMs,
        MAX_CLEANUP_TIMEOUT_MS,
      );
      const requestBytes = positiveBounded(
        options.requestBytes,
        MCP_BOUNDARY_LIMITS.requestBytes,
        MAX_MESSAGE_BYTES,
      );
      const responseBytes = positiveBounded(
        options.responseBytes,
        MCP_BOUNDARY_LIMITS.responseBytes,
        MAX_MESSAGE_BYTES,
      );
      if (
        connectTimeoutMs === undefined ||
        requestTimeoutMs === undefined ||
        cleanupTimeoutMs === undefined ||
        requestBytes === undefined ||
        responseBytes === undefined
      ) {
        throw invalidHttpOptions();
      }

      if (options.onCleanup !== undefined && !Predicate.isFunction(options.onCleanup)) {
        throw invalidHttpOptions();
      }
      validateToken(options.token);
      const sourceHeaders = new Headers(options.headers);
      const headers: Record<string, string> = {};
      for (const [name, value] of sourceHeaders.entries()) {
        const lowerName = name.toLowerCase();
        if (lowerName === SDK_OPERATION_HEADER) continue;
        // The SDK's token-only provider is authoritative when a token snapshot exists.
        if (options.token !== undefined && lowerName === "authorization") continue;
        headers[name] = value;
      }
      return Object.freeze({
        url: new URL(options.url.href),
        headers: Object.freeze(headers),
        token: options.token,
        connectTimeoutMs,
        requestTimeoutMs,
        cleanupTimeoutMs,
        requestBytes,
        responseBytes,
        fetch: options.fetch,
        onCleanup: options.onCleanup,
      });
    },
    catch: (error) => (error instanceof McpBoundaryError ? error : invalidHttpOptions()),
  });

const validateToken = (token: string | undefined): void => {
  if (token === undefined) return;
  if (!Predicate.isString(token) || token.length > 65_536 || /[\r\n\0]/u.test(token)) {
    throw invalidHttpOptions();
  }
};

const requestByteLength = (value: McpRequest): Effect.Effect<number, McpBoundaryError> =>
  Schema.encodeEffect(Schema.fromJsonString(McpRequestSchema))(value).pipe(
    Effect.map((json) => new TextEncoder().encode(json).byteLength),
    Effect.mapError(() =>
      boundaryError("invalid-input", "not-sent", "MCP request is not serializable."),
    ),
  );

const finalizeOperation = (
  operation: SdkHttpTransportOperation,
  registry: SdkHttpOperationRegistry,
  state: SdkConnectionState,
  cleanupTimeoutMs: number,
): Effect.Effect<boolean> =>
  Effect.sync(operation.abort).pipe(
    Effect.andThen(
      operation
        .awaitIdle()
        .pipe(Effect.interruptible, Effect.timeoutOption(Duration.millis(cleanupTimeoutMs))),
    ),
    Effect.flatMap((result) => {
      if (Option.isSome(result)) {
        registry.remove(operation);
        return Effect.succeed(true);
      }
      // Keep the operation in the registry. Its ownership is unresolved, so this
      // connection must not admit another operation or silently claim cleanup.
      state.cleanupUnconfirmed = true;
      state.closing = true;
      registry.closeAdmissions();
      return Effect.succeed(false);
    }),
  );

const makeConnection = (
  client: Client,
  registry: SdkHttpOperationRegistry,
  snapshot: SdkHttpSnapshot,
  state: SdkConnectionState,
  close: Effect.Effect<void, McpBoundaryError>,
  capabilities: McpCapabilities,
  events: SdkEvents,
  token: TokenState,
  handshake: Pick<McpConnection, "protocolVersion" | "instructions">,
): McpConnection => {
  const request = (input: McpRequest): Effect.Effect<McpReply, McpBoundaryError> =>
    Effect.suspend(() => {
      if (state.closing || state.closed || state.cleanupUnconfirmed) {
        return Effect.fail(
          boundaryError("unavailable", "not-sent", "MCP connection is unavailable."),
        );
      }
      return decodeMcpRequest(input).pipe(
        Effect.flatMap((decoded) =>
          requestByteLength(decoded).pipe(
            Effect.flatMap((bytes) =>
              bytes > snapshot.requestBytes
                ? Effect.fail(
                    boundaryError(
                      "invalid-input",
                      "not-sent",
                      "MCP request exceeds its byte limit.",
                    ),
                  )
                : Effect.uninterruptibleMask((restore) => {
                    if (state.closing || state.closed || state.cleanupUnconfirmed) {
                      return Effect.fail(
                        boundaryError("unavailable", "not-sent", "MCP connection is unavailable."),
                      );
                    }
                    const operation = registry.begin();
                    if (operation === undefined) {
                      return Effect.fail(
                        boundaryError("unavailable", "not-sent", "MCP connection is unavailable."),
                      );
                    }
                    const core = Effect.tryPromise({
                      try: () =>
                        executeSdkRequest(client, decoded, {
                          timeout: snapshot.requestTimeoutMs,
                          maxTotalTimeout: snapshot.requestTimeoutMs,
                          signal: operation.signal,
                          headers: {
                            [SDK_OPERATION_HEADER]: operation.tag,
                          },
                        }),
                      catch: (error) =>
                        mapSdkFailure(
                          Predicate.isError(error) ? error : new Error("MCP SDK operation failed."),
                          operation,
                        ),
                    }).pipe(
                      Effect.raceFirst(operation.awaitFailure()),
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
                          Effect.fail(
                            boundaryError("timeout", "unknown", "MCP request timed out."),
                          ),
                      }),
                    );
                    return Effect.exit(restore(core)).pipe(
                      Effect.flatMap((exit) =>
                        finalizeOperation(
                          operation,
                          registry,
                          state,
                          snapshot.cleanupTimeoutMs,
                        ).pipe(
                          Effect.flatMap((cleaned) => {
                            if (!cleaned)
                              events.finish(
                                boundaryError("cleanup", "unknown", "MCP request cleanup failed."),
                              );
                            if (!cleaned && Exit.isSuccess(exit)) {
                              return Effect.succeed({ ...exit.value, cleanupUnconfirmed: true });
                            }
                            if (!cleaned) {
                              return Effect.fail(
                                boundaryError("cleanup", "unknown", "MCP request cleanup failed."),
                              );
                            }
                            return Exit.isFailure(exit)
                              ? Effect.failCause(exit.cause)
                              : Effect.succeed(exit.value);
                          }),
                        ),
                      ),
                    );
                  }),
            ),
          ),
        ),
      );
    });

  return {
    request,
    close,
    capabilities,
    ...handshake,
    changes: events.changes,
    terminal: events.terminal,
    health: events.health,
    setToken: (value) =>
      Effect.try({
        try: () => {
          if (state.closing || state.closed) {
            throw boundaryError("unavailable", "not-sent", "MCP connection is unavailable.");
          }
          validateToken(value);
          // Explicit token publication also revokes any configured static authorization.
          for (const name of Object.keys(token.headers)) {
            if (name.toLowerCase() === "authorization") delete token.headers[name];
          }
          token.value = value;
        },
        catch: (error) => (error instanceof McpBoundaryError ? error : invalidHttpOptions()),
      }),
  };
};

/** Open and initialize one scoped Streamable HTTP SDK connection. */
export const openSdkHttp = (
  options: SdkHttpOptions,
): Effect.Effect<McpConnection, McpBoundaryError, Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const snapshot = yield* restore(snapshotOptions(options));
      const owner = yield* Scope.fork(yield* Effect.scope);
      const registry = new SdkHttpOperationRegistry(1);
      const state: SdkConnectionState = {
        closing: false,
        closed: false,
        cleanupUnconfirmed: false,
      };
      const token: TokenState = { value: snapshot.token, headers: { ...snapshot.headers } };
      let events: SdkEvents | undefined;
      let opening: Fiber.Fiber<McpConnection, McpBoundaryError> | undefined;
      let cleanup: Effect.Effect<void, McpBoundaryError> = Effect.void;
      const cachedClose = yield* Effect.cached(
        Effect.uninterruptible(
          Effect.sync(() => {
            state.closing = true;
            registry.closeAdmissions();
          }).pipe(
            // No acquisition can hand off new resources after cleanup publication.
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
              // Full close joins every operation, including any previously timed-out lease.
              state.cleanupUnconfirmed = Exit.isFailure(exit);
              observeSdkCleanup(snapshot.onCleanup, !state.cleanupUnconfirmed);
              const failure = state.cleanupUnconfirmed
                ? boundaryError("cleanup", "unknown", "MCP transport cleanup failed.")
                : undefined;
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
          return yield* boundaryError("connection", "not-sent", "MCP connection is unavailable.");
        const controls = yield* makeSdkHttpControl({
          lifetimeMs: snapshot.requestTimeoutMs,
          cleanupTimeoutMs: snapshot.cleanupTimeoutMs,
          onUnconfirmed: () => {
            state.cleanupUnconfirmed = true;
            state.closing = true;
            registry.closeAdmissions();
            events?.finish(boundaryError("cleanup", "unknown", "MCP control cleanup failed."));
          },
        });
        const nativeFetch = yield* FetchHttpClient.Fetch;
        const sdkFetch = makeSdkFetch({
          maxBytes: snapshot.responseBytes,
          fetch: snapshot.fetch ?? nativeFetch,
          session: registry.traffic,
          beginControl: controls.begin,
          lookupOperation: registry.lookupRequestId,
        });
        const client = yield* makeSdkClient();
        const acquiredEvents = yield* makeSdkEvents(client, state);
        events = acquiredEvents;
        const transport = yield* Effect.try({
          try: () => {
            const transportOptions: StreamableHTTPClientTransportOptions = {
              requestInit: { headers: token.headers },
              fetch: sdkFetch,
              // Private synchronous token snapshot only. No refresh, runners or retry hooks.
              authProvider: { token: () => Promise.resolve(token.value) },
              onInsufficientScope: "throw",
              maxStepUpRetries: 0,
              reconnectionOptions: {
                maxReconnectionDelay: 1,
                initialReconnectionDelay: 1,
                reconnectionDelayGrowFactor: 1,
                maxRetries: 0,
              },
            };
            return new StreamableHTTPClientTransport(snapshot.url, transportOptions);
          },
          catch: () =>
            boundaryError("connection", "not-sent", "Unable to initialize MCP transport."),
        });
        const decorated = makeSdkHttpTransport(transport, registry);
        cleanup = closeSdkTransport(
          client,
          transport,
          registry,
          controls,
          snapshot.cleanupTimeoutMs,
        );

        const connectOperation = registry.begin();
        if (connectOperation === undefined) {
          return yield* Effect.fail(
            boundaryError("connection", "not-sent", "Unable to initialize MCP connection."),
          );
        }
        const connectCore = Effect.tryPromise({
          try: () =>
            client.connect(decorated, {
              timeout: snapshot.connectTimeoutMs,
              maxTotalTimeout: snapshot.connectTimeoutMs,
              signal: connectOperation.signal,
              headers: { [SDK_OPERATION_HEADER]: connectOperation.tag },
            }),
          catch: (error) =>
            mapSdkFailure(
              Predicate.isError(error) ? error : new Error("MCP SDK operation failed."),
              connectOperation,
            ),
        }).pipe(
          Effect.raceFirst(connectOperation.awaitFailure()),
          Effect.timeoutOrElse({
            duration: Duration.millis(snapshot.connectTimeoutMs),
            orElse: () =>
              Effect.fail(boundaryError("timeout", "unknown", "MCP connection timed out.")),
          }),
        );
        const connectExit = yield* Effect.exit(restore(connectCore));
        const connectCleaned = yield* finalizeOperation(
          connectOperation,
          registry,
          state,
          snapshot.cleanupTimeoutMs,
        );
        if (!connectCleaned) {
          return yield* Effect.fail(
            boundaryError("cleanup", "unknown", "MCP connection cleanup failed."),
          );
        }
        if (Exit.isFailure(connectExit)) return yield* Effect.failCause(connectExit.cause);
        return makeConnection(
          client,
          registry,
          snapshot,
          state,
          close,
          yield* sdkCapabilities(client),
          acquiredEvents,
          token,
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
  );
