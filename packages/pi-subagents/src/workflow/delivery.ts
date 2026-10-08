import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Schedule from "effect/Schedule";
import { invokeHostCallback } from "pi-cosmic-core";
import type {
  SubagentNotificationDelivery,
  SubagentWorkflowNotification,
} from "../boundary/host-notifier.ts";

/** The first retry waits this long; each later one waits twice as long, up to the maximum. */
export const DELIVERY_RETRY_INITIAL_MS = 100;
export const DELIVERY_RETRY_MAX_MS = 30_000;

const DELIVERY_RETRY = Schedule.min([
  Schedule.exponential(DELIVERY_RETRY_INITIAL_MS),
  Schedule.spaced(DELIVERY_RETRY_MAX_MS),
]);

/** The host's notifier; a delivery it didn't accept is retried. */
export type WorkflowNotify = (
  notification: SubagentWorkflowNotification,
) => SubagentNotificationDelivery | undefined;

/**
 * Completion delivery for the session's runs, built in the caller's scope. Its finalizers run in
 * reverse: the closed flag first, then the background deliveries are interrupted.
 */
export const makeWorkflowDelivery = Effect.fnUntraced(function* (
  notify: WorkflowNotify | undefined,
) {
  const deliveries = yield* FiberSet.make();
  let closed = false;
  // Added after the FiberSet, so it runs before deliveries end: nothing is sent during teardown.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }),
  );

  /**
   * Retries with backoff until the host accepts the notification, and reports whether it did.
   * Without a host nothing can accept it, so it counts as delivered; a closed session drops it.
   */
  const deliver = (notification: SubagentWorkflowNotification): Effect.Effect<boolean> =>
    Effect.sync(
      () =>
        !closed &&
        (!notify || invokeHostCallback(() => notify(notification)?.actionAccepted === true, false)),
    ).pipe(Effect.repeat({ schedule: DELIVERY_RETRY, until: (accepted) => accepted || closed }));

  return {
    /** Set once teardown starts; a closed session publishes and delivers nothing. */
    closed: Effect.sync(() => closed),
    /**
     * Delivers a run's report in the background and runs `accepted`, which closes the run, once
     * the host accepts it, so a report a teardown drops is still announced by the next
     * activation. A run without a report is closed at once.
     */
    report: (
      notification: SubagentWorkflowNotification | undefined,
      accepted: Effect.Effect<void>,
    ): Effect.Effect<void> =>
      notification
        ? FiberSet.run(
            deliveries,
            // Only the delivery is interruptible: once Pi accepts the report, a teardown waits
            // for the close, so an announced run never stays open to be announced again.
            Effect.uninterruptibleMask((restore) =>
              restore(deliver(notification)).pipe(
                Effect.flatMap((delivered) => (delivered ? accepted : Effect.void)),
              ),
            ),
          ).pipe(Effect.asVoid)
        : accepted,
    /** Delivers in the background for a run that is already closed. */
    send: (notification: SubagentWorkflowNotification): Effect.Effect<void> =>
      FiberSet.run(deliveries, deliver(notification)).pipe(Effect.asVoid),
  };
});
