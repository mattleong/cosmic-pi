import { ProtocolError } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { boundaryError } from "../../../client/errors.ts";
import type { McpProtocolAdapter } from "../contract.ts";
import { boundedSdkCleanup } from "../shared/bounded-cleanup.ts";
import { closeSubscription, subscriptionRequestOptions } from "../shared/subscription-close.ts";
import { mapSubscriptionFailure } from "../shared/subscription-failure.ts";

/** Legacy list notifications use the connection's unsolicited channel. */
export const legacyProtocol: McpProtocolAdapter = {
  observe: () => Effect.void,
  subscribeResource: (client, events, uri, timeout, cleanupTimeout, identity) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const traffic = yield* events.beginSubscription(identity);
        let establishmentUnknown = false;
        yield* Effect.addFinalizer(() =>
          traffic.close.pipe(
            Effect.tapError(() => Effect.sync(events.cleanupFailed)),
            Effect.ensuring(
              Effect.sync(() => {
                if (establishmentUnknown) events.cleanupFailed();
              }),
            ),
            Effect.ignore,
          ),
        );
        yield* restore(
          Effect.tryPromise({
            try: (signal) => {
              establishmentUnknown = true;
              return client.request(
                { method: "resources/subscribe", params: { uri } },
                subscriptionRequestOptions(traffic, signal, timeout),
              );
            },
            catch: (cause) => {
              const error = (traffic.mapFailure ?? mapSubscriptionFailure)(cause);
              // A rejected request or proven non-dispatch cannot establish a lease.
              // Other completed failures may be malformed successful acknowledgements.
              if (cause instanceof ProtocolError || error.outcome === "not-sent")
                establishmentUnknown = false;
              return error;
            },
          }),
        );
        establishmentUnknown = false;
        traffic.acknowledge({ resourceSubscriptions: [uri] });
        const ended = yield* Deferred.make<void>();
        const close = yield* closeSubscription(
          events,
          traffic,
          Effect.gen(function* () {
            if (!(yield* events.health).closed)
              yield* boundedSdkCleanup(
                (signal) =>
                  client
                    .request(
                      { method: "resources/unsubscribe", params: { uri } },
                      subscriptionRequestOptions(traffic, signal, cleanupTimeout),
                    )
                    // An error reply is still the server's answer: nothing is left in flight.
                    .catch((error) => {
                      if (!(error instanceof ProtocolError)) throw error;
                    }),
                cleanupTimeout,
                boundaryError("cleanup", "unknown", "MCP resource unsubscribe cleanup failed."),
                boundaryError("cleanup", "unknown", "MCP resource unsubscribe cleanup timed out."),
              );
            yield* Deferred.succeed(ended, undefined);
          }),
        );
        yield* Effect.addFinalizer(() => close.pipe(Effect.ignore));
        return {
          identity: traffic.identity,
          close,
          closed: Effect.raceFirst(Deferred.await(ended), events.terminal.pipe(Effect.ignore)),
        };
      }),
    ),
};
