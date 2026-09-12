import {
  Client,
  isInputRequiredResult,
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
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
import { requireSecureBearerDestination } from "../auth/policy.ts";
import {
  snapshotOptions,
  validateToken,
  invalidHttpOptions,
  type SdkHttpOptions,
  type SdkHttpSnapshot,
  type TokenState,
} from "./sdk-http-options.ts";
import { selectProtocol, guardNegotiation } from "./mcp-protocol/select.ts";
import type { McpProtocolAdapter } from "./mcp-protocol/contract.ts";
import {
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

export type { SdkHttpOptions } from "./sdk-http-options.ts";

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
      (value === undefined ? Effect.void : requireSecureBearerDestination(snapshot.url.href)).pipe(
        Effect.andThen(
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
        ),
      ),
  };
};

/** Open and initialize one scoped Streamable HTTP SDK connection. */
export const openSdkHttp = (
  options: SdkHttpOptions,
): Effect.Effect<McpConnection, McpBoundaryError, Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const snapshot = yield* restore(snapshotOptions(options));
      if (snapshot.token !== undefined)
        yield* restore(requireSecureBearerDestination(snapshot.url.href));
      const deadline = started + snapshot.connectTimeoutMs;
      const remaining = Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          now < deadline
            ? Effect.succeed(deadline - now)
            : Effect.fail(
                boundaryError("timeout", "not-sent", "MCP acquisition deadline expired."),
              ),
        ),
      );
      const owner = yield* Scope.fork(yield* Effect.scope);
      const registry = new SdkHttpOperationRegistry(1);
      const state: SdkConnectionState = {
        closing: false,
        closed: false,
        cleanupUnconfirmed: false,
      };
      const token: TokenState = { value: snapshot.token, headers: { ...snapshot.headers } };
      let events: SdkEvents | undefined;
      let protocol: McpProtocolAdapter | undefined;
      let acquisition: SdkHttpTransportOperation | undefined;
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
              state.cleanupUnconfirmed =
                Exit.isFailure(exit) || state.observationCleanupFailed === true;
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
          isObservationRequest: (method) => protocol?.isObservationRequest(method) === true,
          onObservationFailure: () => events?.observationFailed(),
          onResponse: (status, headers) => {
            if (!state.closing && protocol?.sessionExpired(status, headers)) {
              state.closing = true;
              registry.closeAdmissions();
              events?.finish(
                boundaryError(
                  "connection",
                  "unknown",
                  "MCP session expired; a new connection is required.",
                ),
              );
            }
          },
        });
        const client = yield* makeSdkClient(snapshot.protocol, yield* remaining);
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
        const decorated = makeSdkHttpTransport(transport, registry, () => acquisition);
        cleanup = closeSdkTransport(
          client,
          transport,
          registry,
          controls,
          snapshot.cleanupTimeoutMs,
          () =>
            protocol === undefined ? transport.terminateSession() : protocol.terminate(transport),
        );

        const connectOperation = registry.begin();
        if (connectOperation === undefined) {
          return yield* Effect.fail(
            boundaryError("connection", "not-sent", "Unable to initialize MCP connection."),
          );
        }
        acquisition = connectOperation;
        const connectBudget = yield* remaining;
        const connectCore = Effect.tryPromise({
          try: () =>
            client.connect(guardNegotiation(decorated), {
              timeout: connectBudget,
              maxTotalTimeout: connectBudget,
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
            duration: Duration.millis(connectBudget),
            orElse: () =>
              Effect.fail(boundaryError("timeout", "unknown", "MCP connection timed out.")),
          }),
        );
        const connectExit = yield* Effect.exit(restore(connectCore));
        acquisition = undefined;
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
        protocol = yield* selectProtocol(client);
        const observationBudget = yield* remaining;
        yield* restore(
          protocol.observe(client, acquiredEvents, observationBudget, snapshot.cleanupTimeoutMs),
        ).pipe(
          Effect.timeoutOrElse({
            duration: observationBudget,
            orElse: () =>
              Effect.fail(
                boundaryError("timeout", "not-sent", "MCP metadata observation timed out."),
              ),
          }),
        );
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
