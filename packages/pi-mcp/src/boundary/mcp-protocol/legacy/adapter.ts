import { SdkHttpError } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { boundaryError } from "../../../client/errors.ts";
import type { McpProtocolAdapter } from "../contract.ts";

/** Legacy list notifications use the connection's unsolicited channel. */
export const legacyProtocol: McpProtocolAdapter = {
  observe: () => Effect.void,
  subscribeResource: (client, events, uri, timeout, cleanupTimeout, identity) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const traffic = yield* events.beginSubscription(identity);
        let acknowledged = false;
        let attempted = false;
        yield* Effect.addFinalizer(() =>
          traffic.close.pipe(
            Effect.tapError(() => Effect.sync(events.cleanupFailed)),
            Effect.ensuring(
              Effect.sync(() => {
                if (attempted && !acknowledged) events.cleanupFailed();
              }),
            ),
            Effect.ignore,
          ),
        );
        yield* restore(
          Effect.tryPromise({
            try: (signal) => {
              attempted = true;
              return client.request(
                { method: "resources/subscribe", params: { uri } },
                {
                  ...traffic.options,
                  signal: traffic.options.signal
                    ? AbortSignal.any([signal, traffic.options.signal])
                    : signal,
                  timeout,
                  maxTotalTimeout: timeout,
                },
              );
            },
            catch: () =>
              boundaryError(
                "connection",
                "unknown",
                "MCP resource subscription was not acknowledged.",
              ),
          }),
        );
        acknowledged = true;
        traffic.acknowledge({ resourceSubscriptions: [uri] });
        const ended = yield* Deferred.make<void>();
        const close = yield* Effect.cached(
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (!(yield* events.health).closed)
                yield* Effect.tryPromise({
                  try: (signal) =>
                    client.request(
                      { method: "resources/unsubscribe", params: { uri } },
                      {
                        ...traffic.options,
                        signal: traffic.options.signal
                          ? AbortSignal.any([signal, traffic.options.signal])
                          : signal,
                        timeout: cleanupTimeout,
                        maxTotalTimeout: cleanupTimeout,
                      },
                    ),
                  catch: () =>
                    boundaryError("cleanup", "unknown", "MCP resource unsubscribe cleanup failed."),
                }).pipe(
                  Effect.interruptible,
                  Effect.timeoutOrElse({
                    duration: cleanupTimeout,
                    orElse: () =>
                      Effect.fail(
                        boundaryError(
                          "cleanup",
                          "unknown",
                          "MCP resource unsubscribe cleanup timed out.",
                        ),
                      ),
                  }),
                );
              yield* Deferred.succeed(ended, undefined);
            }).pipe(
              Effect.ensuring(
                traffic.close.pipe(
                  Effect.tapError(() => Effect.sync(events.cleanupFailed)),
                  Effect.ignore,
                ),
              ),
              Effect.andThen(traffic.close),
              Effect.tapError(() => Effect.sync(events.cleanupFailed)),
            ),
          ),
        );
        yield* Effect.addFinalizer(() => close.pipe(Effect.ignore));
        return {
          identity: traffic.identity,
          close,
          closed: Effect.raceFirst(Deferred.await(ended), events.terminal.pipe(Effect.ignore)),
        };
      }),
    ),
  isObservationRequest: () => false,
  sessionExpired: (status, headers) => status === 404 && headers.has("mcp-session-id"),
  terminate: (transport) =>
    transport.terminateSession().catch((error) => {
      // Remote absence does not settle any local fetch, body, or SDK owner.
      if (!(error instanceof SdkHttpError) || error.data?.status !== 404) throw error;
    }),
};
