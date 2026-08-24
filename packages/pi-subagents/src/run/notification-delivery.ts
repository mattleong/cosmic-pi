import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import type * as Scope from "effect/Scope";
import type {
  SubagentNotification,
  SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import {
  acknowledgeCompletionSelections,
  collectCompletionDeliveryBatch,
  deliveredCompletionKeys,
  hasEligibleCompletion,
} from "./completion.ts";
import type { CompletionGenerationRecord, RunRecord } from "./internal.ts";
import { COMPLETION_RETRY_INITIAL_MILLIS, COMPLETION_RETRY_MAX_MILLIS } from "./limits.ts";

export type SubagentQuestionNotification = Extract<
  SubagentNotification,
  { readonly type: "question" }
>;

export interface RunNotificationDeliveryDependencies {
  /** Owner scope for the persistent outbox workers. */
  readonly ownerScope: Scope.Scope;
  readonly records: ReadonlyMap<string, RunRecord>;
  /** The shared service lock. Every `*Locked` method requires the caller to hold it. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Serializes completion delivery ownership against claim acquisition. */
  readonly withCompletionGate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Host boundary; must be called outside the service lock. */
  readonly notify: (notification: SubagentNotification) => SubagentNotificationDelivery | undefined;
}

type ActionDeliveryState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Retry"; readonly immediate: boolean; readonly delayMillis: number };

/**
 * Owns completion and question delivery. Completion payloads live only in each
 * RunRecord's completionGenerations map; the reusable latch is only a wakeup.
 */
export const makeRunNotificationDelivery = Effect.fn("RunNotificationDelivery.make")(function* (
  dependencies: RunNotificationDeliveryDependencies,
) {
  const { ownerScope, records, withLock, withCompletionGate, notify } = dependencies;
  const pendingActionNotifications = new Map<string, SubagentQuestionNotification>();
  const completionWake = yield* Latch.make();
  const actionWake = yield* Latch.make();
  let completionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
  let actionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;

  const flushPendingCompletions = Effect.suspend(() =>
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(completionRetryDelayMillis));
      yield* withCompletionGate(
        Effect.gen(function* () {
          const selected = yield* withLock(
            Effect.sync(() => {
              Latch.closeUnsafe(completionWake);
              return collectCompletionDeliveryBatch(records);
            }),
          );
          if (selected.length === 0) {
            completionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
            return;
          }
          const runs = selected.map((item) => item.notification);
          const delivery = yield* Effect.sync(() => notify({ type: "completed", runs }));
          yield* withLock(
            Effect.sync(() => {
              const acknowledged = acknowledgeCompletionSelections(
                selected,
                deliveredCompletionKeys(delivery, runs),
              );
              const eligibleRemain = hasEligibleCompletion(records);
              completionRetryDelayMillis =
                !eligibleRemain || acknowledged > 0
                  ? COMPLETION_RETRY_INITIAL_MILLIS
                  : Math.min(COMPLETION_RETRY_MAX_MILLIS, completionRetryDelayMillis * 2);
              if (eligibleRemain) Latch.openUnsafe(completionWake);
            }),
          );
        }),
      );
    }),
  );

  const completionWorker = Effect.forever(
    Latch.await(completionWake).pipe(Effect.andThen(flushPendingCompletions)),
  );

  const actionRelevant = (notification: SubagentQuestionNotification): boolean => {
    const record = records.get(notification.id);
    return (
      record !== undefined &&
      record.notificationGeneration === notification.generation &&
      record.view.state === "waiting_for_parent" &&
      record.view.question?.requestId === notification.requestId
    );
  };

  const flushPendingActions: Effect.Effect<ActionDeliveryState> = withLock(
    Effect.sync(() => {
      Latch.closeUnsafe(actionWake);
      const notifications = [...pendingActionNotifications.values()].filter((notification) => {
        if (actionRelevant(notification)) return true;
        if (pendingActionNotifications.get(notification.id) === notification)
          pendingActionNotifications.delete(notification.id);
        return false;
      });
      if (notifications.length === 0) actionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
      return notifications;
    }),
  ).pipe(
    Effect.flatMap((notifications) =>
      notifications.length === 0
        ? Effect.succeed<ActionDeliveryState>({ _tag: "Idle" })
        : Effect.sync(() =>
            notifications.map((notification) => ({
              notification,
              accepted: notify(notification)?.actionAccepted ?? true,
            })),
          ).pipe(
            Effect.flatMap((deliveries) =>
              withLock(
                Effect.sync<ActionDeliveryState>(() => {
                  let acknowledged = 0;
                  const attempted = new Set(deliveries.map(({ notification }) => notification));
                  for (const { notification, accepted } of deliveries) {
                    if (!accepted) continue;
                    if (pendingActionNotifications.get(notification.id) === notification)
                      pendingActionNotifications.delete(notification.id);
                    acknowledged += 1;
                  }
                  actionRetryDelayMillis =
                    pendingActionNotifications.size === 0 || acknowledged > 0
                      ? COMPLETION_RETRY_INITIAL_MILLIS
                      : Math.min(COMPLETION_RETRY_MAX_MILLIS, actionRetryDelayMillis * 2);
                  if (pendingActionNotifications.size === 0) return { _tag: "Idle" };
                  const immediate = [...pendingActionNotifications.values()].some(
                    (notification) => !attempted.has(notification),
                  );
                  return {
                    _tag: "Retry",
                    immediate,
                    delayMillis: actionRetryDelayMillis,
                  };
                }),
              ),
            ),
          ),
    ),
  );

  const deliverPendingActions = (): Effect.Effect<void> =>
    flushPendingActions.pipe(
      Effect.flatMap((state) => {
        if (state._tag === "Idle") return Effect.void;
        const retry = state.immediate
          ? Effect.void
          : Effect.raceFirst(
              Effect.sleep(Duration.millis(state.delayMillis)),
              Latch.await(actionWake),
            );
        return retry.pipe(Effect.flatMap(() => deliverPendingActions()));
      }),
    );

  const actionWorker = Effect.forever(
    Latch.await(actionWake).pipe(Effect.flatMap(() => deliverPendingActions())),
  );

  yield* Effect.forkIn(completionWorker, ownerScope, { startImmediately: true });
  yield* Effect.forkIn(actionWorker, ownerScope, { startImmediately: true });

  const queueActionNotification = (
    record: RunRecord,
    notification: Omit<SubagentQuestionNotification, "generation">,
  ) =>
    withLock(
      Effect.sync(() => {
        const generation = ++record.notificationGeneration;
        // SAFETY: The typed owner constructs the queued notification on this path.
        const queued = { ...notification, generation } as SubagentQuestionNotification;
        pendingActionNotifications.set(record.view.id, queued);
        Latch.openUnsafe(actionWake);
      }),
    );

  return {
    /** Locks internally, stamps the question generation, queues it, and wakes delivery. */
    queueActionNotification,
    /** Caller must hold the service lock; inserts one payload and wakes delivery atomically. */
    insertCompletionLocked: (record: RunRecord, completion: CompletionGenerationRecord): void => {
      record.completionGenerations.set(completion.generation, completion);
      Latch.openUnsafe(completionWake);
    },
    /** Caller must hold the service lock; used when a matching claim is released. */
    wakeCompletionLocked: (): void => {
      Latch.openUnsafe(completionWake);
    },
    /** Caller must hold the service lock; drops the run's queued question. */
    discardQuestionLocked: (id: string): void => void pendingActionNotifications.delete(id),
  };
});

export type RunNotificationDelivery =
  ReturnType<typeof makeRunNotificationDelivery> extends Effect.Effect<
    infer Success,
    unknown,
    unknown
  >
    ? Success
    : never;
