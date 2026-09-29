import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client";
import { makeNativeContext } from "pi-cosmic-core";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import { FetchHttpClient } from "effect/unstable/http";
import type * as Scope from "effect/Scope";
import { McpBoundaryError, boundaryError } from "../client/errors.ts";
import { requireSecureBearerDestination } from "../auth/policy.ts";
import {
  snapshotOptions,
  validateToken,
  invalidHttpOptions,
  type SdkHttpOptions,
  type TokenState,
} from "./sdk-http-options.ts";
import { selectProtocol } from "./mcp-protocol/select.ts";
import type { McpConnection, McpCapabilities } from "../client/model.ts";
import { makeSdkClient } from "./sdk-client.ts";
import { finalizeOperation, makeSdkHttpExchange } from "./sdk-http-request.ts";
import { SDK_OPERATION_HEADER, makeSdkFetch } from "./sdk-fetch.ts";
import { makeSdkEvents, type SdkEvents } from "./sdk-events.ts";
import { openSdkConnection } from "./sdk-lifecycle.ts";
import { makeSdkHttpControl } from "./sdk-http-control.ts";
import {
  closeSdkTransport,
  makeSdkHttpTransport,
  mapSdkFailure,
  SdkHttpOperationRegistry,
  type SdkHttpOperation,
} from "./sdk-http-transport.ts";

export type { SdkHttpOptions } from "./sdk-http-options.ts";

/** Open and initialize one scoped Streamable HTTP SDK connection. */
export const openSdkHttp = (
  options: SdkHttpOptions,
): Effect.Effect<McpConnection, McpBoundaryError, Scope.Scope> =>
  Effect.gen(function* () {
    const snapshot = yield* snapshotOptions(options);
    if (snapshot.token !== undefined) yield* requireSecureBearerDestination(snapshot.url.href);
    const context = yield* makeNativeContext<SdkHttpOperation>().pipe(
      Effect.mapError(() =>
        boundaryError("connection", "not-sent", "MCP native transport context is unavailable."),
      ),
    );
    const registry = new SdkHttpOperationRegistry(context);
    const token: TokenState = { value: snapshot.token, headers: { ...snapshot.headers } };
    let events: SdkEvents | undefined;
    let acquisition: SdkHttpOperation | undefined;
    return yield* openSdkConnection({
      transport: "http",
      labels: {
        deadline: "MCP acquisition deadline expired.",
        cleanup: "MCP transport cleanup failed.",
      },
      snapshot,
      onClosing: () => registry.closeAdmissions(),
      events: () => events,
      connect: ({ state, remaining, restore, setCleanup }) =>
        Effect.gen(function* () {
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
            currentOperation: registry.current,
            onObservationFailure: () => events?.observationFailed(),
            onResponse: (status, headers) => {
              // Only a stateful legacy session sends its id; a 404 then means the server
              // forgot the session. Modern stateless HTTP never sends one.
              if (!state.closing && status === 404 && headers.has("mcp-session-id")) {
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
          const acquiredEvents = yield* makeSdkEvents(
            client,
            state,
            () =>
              Effect.gen(function* () {
                const owned = registry.begin();
                if (!owned)
                  return yield* boundaryError(
                    "connection",
                    "not-sent",
                    "MCP subscription ownership is unavailable.",
                  );
                const close = yield* Effect.cached(
                  Effect.uninterruptible(
                    finalizeOperation(owned, registry, state, snapshot.cleanupTimeoutMs).pipe(
                      Effect.flatMap((confirmed) =>
                        confirmed
                          ? Effect.void
                          : Effect.fail(
                              boundaryError(
                                "cleanup",
                                "unknown",
                                "MCP subscription native cleanup is unconfirmed.",
                              ),
                            ),
                      ),
                    ),
                  ),
                );
                return {
                  options: {
                    signal: owned.signal,
                    headers: { [SDK_OPERATION_HEADER]: owned.tag },
                  },
                  mapFailure: (cause: unknown) =>
                    cause instanceof McpBoundaryError
                      ? cause
                      : mapSdkFailure(
                          Predicate.isError(cause) ? cause : new Error("MCP SDK operation failed."),
                          owned,
                        ),
                  close,
                  run: <A>(callback: () => A): A => registry.run(owned, callback),
                };
              }),
            { timeoutMs: snapshot.cleanupTimeoutMs, requireCancellationWrite: false },
          );
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
          const decorated = acquiredEvents.bindTransport(
            makeSdkHttpTransport(transport, registry, () => acquisition),
          );
          setCleanup(
            // The SDK sends DELETE only when it holds a session id.
            closeSdkTransport(client, transport, registry, controls, snapshot.cleanupTimeoutMs),
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
              client.connect(decorated, {
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
            return yield* boundaryError("cleanup", "unknown", "MCP connection cleanup failed.");
          }
          if (Exit.isFailure(connectExit)) return yield* Effect.failCause(connectExit.cause);
          return {
            client,
            events: acquiredEvents,
            protocol: yield* selectProtocol(client),
            exchange: (capabilities: McpCapabilities) =>
              makeSdkHttpExchange(client, registry, snapshot, state, capabilities, acquiredEvents),
            setToken: (value: string | undefined) =>
              (value === undefined
                ? Effect.void
                : requireSecureBearerDestination(snapshot.url.href)
              ).pipe(
                Effect.andThen(
                  Effect.try({
                    try: () => {
                      if (state.closing || state.closed) {
                        throw boundaryError(
                          "unavailable",
                          "not-sent",
                          "MCP connection is unavailable.",
                        );
                      }
                      validateToken(value);
                      // Explicit token publication also revokes any configured static authorization.
                      for (const name of Object.keys(token.headers)) {
                        if (name.toLowerCase() === "authorization") delete token.headers[name];
                      }
                      token.value = value;
                    },
                    catch: (error) =>
                      error instanceof McpBoundaryError ? error : invalidHttpOptions(),
                  }),
                ),
              ),
          };
        }),
    });
  });
