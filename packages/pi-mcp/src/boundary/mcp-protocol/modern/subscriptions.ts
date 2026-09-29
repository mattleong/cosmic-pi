import type { Client, SubscriptionFilter } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import { boundaryError } from "../../../client/errors.ts";
import type { SdkEvents } from "../../sdk-events.ts";
import { boundedSdkCleanup } from "../shared/bounded-cleanup.ts";
import { closeSubscription } from "../shared/subscription-close.ts";
import { mapSubscriptionFailure } from "../shared/subscription-failure.ts";

const LIST_CHANGES = ["toolsListChanged", "resourcesListChanged", "promptsListChanged"] as const;

/** SDK timeout bounds acknowledgement only. The connection scope owns stream lifetime. */
export const ownSubscription = (
  client: Client,
  filter: SubscriptionFilter,
  events: SdkEvents,
  ackTimeoutMs: number,
  cleanupTimeoutMs: number,
  metadata = true,
  identity?: symbol,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const traffic = yield* events.beginSubscription(identity);
      const controller = new AbortController();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => traffic.run(() => controller.abort())).pipe(
          Effect.andThen(traffic.close),
          Effect.tapError(() => Effect.sync(events.cleanupFailed)),
          Effect.ignore,
        ),
      );
      const subscription = yield* restore(
        Effect.tryPromise({
          try: () =>
            traffic.run(() =>
              client.listen(filter, {
                ...traffic.options,
                signal: traffic.options.signal
                  ? AbortSignal.any([controller.signal, traffic.options.signal])
                  : controller.signal,
                timeout: ackTimeoutMs,
              }),
            ),
          catch: (error) => (traffic.mapFailure ?? mapSubscriptionFailure)(error),
        }),
      );
      const close = yield* closeSubscription(
        events,
        traffic,
        boundedSdkCleanup(
          () => traffic.run(() => subscription.close()),
          cleanupTimeoutMs,
          boundaryError("cleanup", "unknown", "MCP subscription cleanup failed."),
          boundaryError("cleanup", "unknown", "MCP subscription cleanup timed out."),
        ),
      );
      yield* Effect.addFinalizer(() => close.pipe(Effect.ignore));
      const honored = subscription.honoredFilter;
      // A server may honor a subset of list-change families; the rest stay unobserved,
      // as when a legacy server omits listChanged. It may not add families, and a
      // resource subscription must be honored exactly.
      if (
        LIST_CHANGES.some((family) => !!honored[family] && !filter[family]) ||
        (honored.resourceSubscriptions?.length ?? 0) !==
          (filter.resourceSubscriptions?.length ?? 0) ||
        (filter.resourceSubscriptions?.some(
          (uri) => !honored.resourceSubscriptions?.includes(uri),
        ) ??
          false)
      ) {
        return yield* boundaryError(
          "protocol",
          "completed",
          "MCP metadata subscription was not honored.",
        );
      }
      traffic.acknowledge(honored);
      yield* Effect.forkScoped(
        Effect.promise(() => subscription.closed).pipe(
          Effect.flatMap((reason) =>
            Effect.sync(() => {
              if (metadata && reason !== "local") events.observationFailed();
            }),
          ),
        ),
      );
      // Nothing to observe: release the stream rather than hold it open.
      if (metadata && !LIST_CHANGES.some((family) => honored[family])) yield* close;
      return {
        identity: traffic.identity,
        close,
        closed: Effect.promise(() => subscription.closed).pipe(Effect.asVoid),
      };
    }),
  );
