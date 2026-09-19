import {
  Client,
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client";
import * as Cause from "effect/Cause";
import { makeNativeContext } from "pi-cosmic-core";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
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
import { type McpConnection, type McpCapabilities } from "../client/model.ts";
import { makeSdkClient, sdkHandshake } from "./sdk-client.ts";
import { terminalExchange } from "./sdk-elicitation.ts";
import { finalizeOperation, makeSdkHttpExchange } from "./sdk-http-request.ts";
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
  protocol: McpProtocolAdapter,
): McpConnection => {
  const exchange = makeSdkHttpExchange(client, registry, snapshot, state, capabilities, events);

  return {
    subscribeResource: (uri, identity) =>
      protocol.subscribeResource(
        client,
        events,
        uri,
        snapshot.requestTimeoutMs,
        snapshot.cleanupTimeoutMs,
        identity,
      ),
    exchange,
    request: (input, options) => exchange(input, options).pipe(Effect.flatMap(terminalExchange)),
    close,
    capabilities,
    ...handshake,
    changes: events.changes,
    remoteEvents: events.remoteEvents,
    remoteEventDrops: events.remoteEventDrops,
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
      const context = yield* makeNativeContext<SdkHttpTransportOperation>().pipe(
        Effect.mapError(() =>
          boundaryError("connection", "not-sent", "MCP native transport context is unavailable."),
        ),
      );
      const registry = new SdkHttpOperationRegistry(1, context);
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
          currentOperation: registry.current,
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
                options: { signal: owned.signal, headers: { [SDK_OPERATION_HEADER]: owned.tag } },
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
          yield* sdkCapabilities(client, true),
          acquiredEvents,
          token,
          yield* sdkHandshake(client),
          protocol,
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
