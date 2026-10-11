import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Schedule from "effect/Schedule";
import { invokeHostCallback } from "pi-cosmic-core";
import type {
  SubagentNotificationDelivery,
  SubagentWorkflowNotification,
} from "../boundary/host-notifier.ts";

export const DELIVERY_RETRY_INITIAL_MS = 100;
export const DELIVERY_RETRY_MAX_MS = 30_000;

const DELIVERY_RETRY = Schedule.min([
  Schedule.exponential(DELIVERY_RETRY_INITIAL_MS),
  Schedule.spaced(DELIVERY_RETRY_MAX_MS),
]);

export type WorkflowNotify = (
  notification: SubagentWorkflowNotification,
) => SubagentNotificationDelivery | undefined;

export const makeWorkflowDelivery = Effect.fnUntraced(function* (
  notify: WorkflowNotify | undefined,
) {
  const deliveries = yield* FiberSet.make();
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }),
  );

  const deliver = (notification: SubagentWorkflowNotification): Effect.Effect<boolean> =>
    Effect.sync(
      () =>
        !closed &&
        (!notify || invokeHostCallback(() => notify(notification)?.actionAccepted === true, false)),
    ).pipe(Effect.repeat({ schedule: DELIVERY_RETRY, until: (accepted) => accepted || closed }));

  return {
    closed: Effect.sync(() => closed),
    report: (
      notification: SubagentWorkflowNotification | undefined,
      accepted: Effect.Effect<void>,
    ): Effect.Effect<void> =>
      notification
        ? FiberSet.run(
            deliveries,
            Effect.uninterruptibleMask((restore) =>
              restore(deliver(notification)).pipe(
                Effect.flatMap((delivered) => (delivered ? accepted : Effect.void)),
              ),
            ),
          ).pipe(Effect.asVoid)
        : accepted,
    send: (notification: SubagentWorkflowNotification): Effect.Effect<void> =>
      FiberSet.run(deliveries, deliver(notification)).pipe(Effect.asVoid),
  };
});
