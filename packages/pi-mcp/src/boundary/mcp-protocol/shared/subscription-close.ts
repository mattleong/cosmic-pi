import type { RequestOptions } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import type { McpBoundaryError } from "../../../client/errors.ts";
import type { SdkEvents, SdkSubscriptionTraffic } from "../../sdk-events.ts";

/** Subscription traffic keeps its own owner signal alongside the caller's. */
export const subscriptionRequestOptions = (
  traffic: Pick<SdkSubscriptionTraffic, "options">,
  signal: AbortSignal,
  timeoutMs: number,
): RequestOptions => ({
  ...traffic.options,
  signal: traffic.options.signal ? AbortSignal.any([signal, traffic.options.signal]) : signal,
  timeout: timeoutMs,
  maxTotalTimeout: timeoutMs,
});

/**
 * One cached, uninterruptible close for either era: the era's bounded remote cleanup,
 * then the traffic ledger even if that failed. Any failure marks cleanup unconfirmed.
 */
export const closeSubscription = (
  events: SdkEvents,
  traffic: Pick<SdkSubscriptionTraffic, "close">,
  cleanup: Effect.Effect<void, McpBoundaryError>,
) =>
  Effect.cached(
    Effect.uninterruptible(
      cleanup.pipe(
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
