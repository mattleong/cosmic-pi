import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type {
  SubagentNotificationDelivery,
  SubagentWorkflowNotification,
} from "../boundary/host-notifier.ts";

/** The first retry waits this long; each later one waits twice as long, up to the maximum. */
export const DELIVERY_RETRY_INITIAL_MS = 100;
export const DELIVERY_RETRY_MAX_MS = 30_000;

/** The host's notifier; a delivery it didn't accept is retried. */
export type WorkflowNotify = (
  notification: SubagentWorkflowNotification,
) => SubagentNotificationDelivery | undefined;

/** Completion delivery for the session's runs, and whether the session has closed. */
export interface WorkflowDelivery {
  /** Set once teardown starts; a closed session publishes and delivers nothing. */
  readonly closed: Effect.Effect<boolean>;
  /**
   * Delivers a run's report in the background and runs `accepted`, which closes the run, once
   * the host accepts it, so a report a teardown drops is still announced by the next activation.
   * A run without a report is closed at once.
   */
  readonly report: (
    notification: SubagentWorkflowNotification | undefined,
    accepted: Effect.Effect<void>,
  ) => Effect.Effect<void>;
  /** Delivers in the background for a run that is already closed. */
  readonly send: (notification: SubagentWorkflowNotification) => Effect.Effect<void>;
}

/**
 * Builds delivery in the caller's scope. Its finalizers run in reverse: the closed flag first,
 * then the background deliveries are interrupted.
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
  const deliver = (notification: SubagentWorkflowNotification): Effect.Effect<boolean> => {
    const attempt = (delay: number): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        if (closed) return Effect.succeed(false);
        if (!notify) return Effect.succeed(true);
        return Effect.try(() => notify(notification)?.actionAccepted === true).pipe(
          Effect.orElseSucceed(() => false),
          Effect.flatMap((accepted) =>
            accepted
              ? Effect.succeed(true)
              : Effect.sleep(delay).pipe(
                  Effect.andThen(attempt(Math.min(delay * 2, DELIVERY_RETRY_MAX_MS))),
                ),
          ),
        );
      });
    return attempt(DELIVERY_RETRY_INITIAL_MS);
  };

  const report: WorkflowDelivery["report"] = (notification, accepted) =>
    notification
      ? FiberSet.run(
          deliveries,
          // Only the delivery is interruptible: once Pi accepts the report, a teardown waits for
          // the close, so an announced run never stays open to be announced again.
          Effect.uninterruptibleMask((restore) =>
            restore(deliver(notification)).pipe(
              Effect.flatMap((delivered) => (delivered ? accepted : Effect.void)),
            ),
          ),
        ).pipe(Effect.asVoid)
      : accepted;

  const send: WorkflowDelivery["send"] = (notification) =>
    FiberSet.run(deliveries, deliver(notification)).pipe(Effect.asVoid);

  return { closed: Effect.sync(() => closed), report, send } satisfies WorkflowDelivery;
});
