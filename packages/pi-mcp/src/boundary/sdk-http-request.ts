import type { Client } from "@modelcontextprotocol/client";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import {
  MCP_BOUNDARY_LIMITS,
  type McpCapabilities,
  type McpRequest,
  type McpDispatchOptions,
} from "../client/model.ts";
import type { McpExchange } from "../interaction/model.ts";
import { decodeMcpRequest, executeSdkRequest, preflightSdkHeaders } from "./sdk-client.ts";
import { decodeSdkExchange } from "./sdk-elicitation.ts";
import type { SdkConnectionState, SdkEvents } from "./sdk-events.ts";
import { SDK_OPERATION_HEADER } from "./sdk-fetch.ts";
import type { SdkHttpSnapshot } from "./sdk-http-options.ts";
import {
  mapSdkFailure,
  type SdkHttpOperation,
  type SdkHttpOperationRegistry,
} from "./sdk-http-transport.ts";

export const finalizeOperation = (
  operation: SdkHttpOperation,
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

/** Execute against the connection's existing registry and cleanup evidence. */
export const makeSdkHttpExchange = (
  client: Client,
  registry: SdkHttpOperationRegistry,
  snapshot: SdkHttpSnapshot,
  state: SdkConnectionState,
  capabilities: McpCapabilities,
  events: SdkEvents,
) => {
  const exchange = (
    input: McpRequest,
    options?: McpDispatchOptions,
  ): Effect.Effect<McpExchange, McpBoundaryError> =>
    Effect.suspend(() => {
      if (state.closing || state.closed || state.cleanupUnconfirmed) {
        return Effect.fail(
          boundaryError("unavailable", "not-sent", "MCP connection is unavailable."),
        );
      }
      // The global request limit stays authoritative when a transport limit is larger.
      return decodeMcpRequest(
        input,
        Math.min(snapshot.requestBytes, MCP_BOUNDARY_LIMITS.requestBytes),
      ).pipe(
        Effect.tap((decoded) =>
          capabilities.parameterHeaders ? preflightSdkHeaders(decoded) : Effect.void,
        ),
        Effect.flatMap((decoded) =>
          Effect.uninterruptibleMask((restore) => {
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
            if (options?.logLevel && options.onlog)
              operation.logScope = { threshold: options.logLevel, publish: options.onlog };
            const core = Effect.tryPromise({
              try: () =>
                events.withProgress(options, (dispatch) =>
                  executeSdkRequest(
                    client,
                    decoded,
                    {
                      timeout: snapshot.requestTimeoutMs,
                      maxTotalTimeout: snapshot.requestTimeoutMs,
                      signal: operation.signal,
                      headers: {
                        ...options?.parameterHeaders,
                        [SDK_OPERATION_HEADER]: operation.tag,
                      },
                    },
                    dispatch,
                  ),
                ),
              catch: (error) =>
                mapSdkFailure(
                  Predicate.isError(error) ? error : new Error("MCP SDK operation failed."),
                  operation,
                ),
            }).pipe(
              Effect.raceFirst(operation.awaitFailure()),
              Effect.flatMap((result) => decodeSdkExchange(decoded.action, result)),
              Effect.timeoutOrElse({
                duration: Duration.millis(snapshot.requestTimeoutMs),
                orElse: () =>
                  Effect.fail(boundaryError("timeout", "unknown", "MCP request timed out.")),
              }),
            );
            return Effect.exit(restore(core)).pipe(
              Effect.flatMap((exit) =>
                finalizeOperation(operation, registry, state, snapshot.cleanupTimeoutMs).pipe(
                  Effect.flatMap((cleaned) => {
                    if (!cleaned)
                      events.finish(
                        boundaryError("cleanup", "unknown", "MCP request cleanup failed."),
                      );
                    if (!cleaned && Exit.isSuccess(exit)) {
                      return Effect.succeed(
                        exit.value.kind === "complete"
                          ? {
                              ...exit.value,
                              reply: { ...exit.value.reply, cleanupUnconfirmed: true },
                            }
                          : { ...exit.value, cleanupUnconfirmed: true },
                      );
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
      );
    });
  return exchange;
};
