import type { Client, SubscriptionFilter } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import { boundaryError } from "../../../client/errors.ts";
import type { SdkEvents } from "../../sdk-events.ts";
import { mapSubscriptionFailure } from "../shared/subscription-failure.ts";

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
      const close = yield* Effect.cached(
        Effect.uninterruptible(
          Effect.tryPromise({
            try: () => traffic.run(() => subscription.close()),
            catch: () => boundaryError("cleanup", "unknown", "MCP subscription cleanup failed."),
          }).pipe(
            Effect.interruptible,
            Effect.timeoutOrElse({
              duration: cleanupTimeoutMs,
              orElse: () =>
                Effect.fail(
                  boundaryError("cleanup", "unknown", "MCP subscription cleanup timed out."),
                ),
            }),
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
      const honored = subscription.honoredFilter;
      if (
        !!filter.toolsListChanged !== !!honored.toolsListChanged ||
        !!filter.resourcesListChanged !== !!honored.resourcesListChanged ||
        !!filter.promptsListChanged !== !!honored.promptsListChanged ||
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
      return {
        identity: traffic.identity,
        close,
        closed: Effect.promise(() => subscription.closed).pipe(Effect.asVoid),
      };
    }),
  );
