import type { Client, SubscriptionFilter } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import { boundaryError } from "../../../client/errors.ts";
import type { SdkEvents } from "../../sdk-events.ts";

/** SDK timeout bounds acknowledgement only. The connection scope owns stream lifetime. */
export const ownSubscription = (
  client: Client,
  filter: SubscriptionFilter,
  events: SdkEvents,
  ackTimeoutMs: number,
  cleanupTimeoutMs: number,
) =>
  Effect.gen(function* () {
    const controller = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
    const subscription = yield* Effect.tryPromise({
      try: () => client.listen(filter, { signal: controller.signal, timeout: ackTimeoutMs }),
      catch: () =>
        boundaryError("connection", "not-sent", "MCP metadata subscription was not acknowledged."),
    });
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        try: () => subscription.close(),
        catch: () => boundaryError("cleanup", "unknown", "MCP subscription cleanup failed."),
      }).pipe(
        Effect.interruptible,
        Effect.timeoutOrElse({
          duration: cleanupTimeoutMs,
          orElse: () =>
            Effect.fail(boundaryError("cleanup", "unknown", "MCP subscription cleanup timed out.")),
        }),
        Effect.catch(() => Effect.sync(events.cleanupFailed)),
      ),
    );
    const honored = subscription.honoredFilter;
    if (
      (filter.toolsListChanged && !honored.toolsListChanged) ||
      (filter.resourcesListChanged && !honored.resourcesListChanged) ||
      (filter.promptsListChanged && !honored.promptsListChanged)
    ) {
      return yield* boundaryError(
        "connection",
        "not-sent",
        "MCP metadata subscription was not honored.",
      );
    }
    yield* Effect.forkScoped(
      Effect.promise(() => subscription.closed).pipe(
        Effect.flatMap((reason) =>
          Effect.sync(() => {
            if (reason !== "local") events.observationFailed();
          }),
        ),
      ),
    );
  });
