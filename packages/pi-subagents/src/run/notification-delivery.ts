import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type {
  SubagentNotification,
  SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import {
  acknowledgePendingCompletions,
  collectPendingCompletionNotifications,
  deliveredCompletionKeys,
  queuePendingCompletion,
  removePendingCompletion,
} from "./completion.ts";
import type { RunRecord } from "./internal.ts";
import { COMPLETION_RETRY_INITIAL_MILLIS, COMPLETION_RETRY_MAX_MILLIS } from "./limits.ts";

export type SubagentQuestionNotification = Extract<
  SubagentNotification,
  { readonly type: "question" }
>;

export interface RunNotificationDeliveryDependencies {
  /** Owner scope for the retry fibers; closing it ends every pending redelivery. */
  readonly ownerScope: Scope.Scope;
  readonly records: ReadonlyMap<string, RunRecord>;
  /** The shared service lock. Every `*Locked` method requires the caller to hold it. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** The shared completion gate serializing delivery ownership against claim acquisition. */
  readonly withCompletionGate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Host boundary; must be called outside the service lock. */
  readonly notify: (notification: SubagentNotification) => SubagentNotificationDelivery | undefined;
}

/**
 * Owns the completion/question delivery outbox: the pending maps, scheduler
 * flags, retry backoff, and owner-scoped delivery fibers. Mutations are exposed
 * only through caller-lock-required methods so committed record transitions and
 * outbox state stay in the same critical section.
 */
export function makeRunNotificationDelivery(dependencies: RunNotificationDeliveryDependencies) {
  const { ownerScope, records, withLock, withCompletionGate, notify } = dependencies;
  const pendingCompletions = new Map<
    string,
    { readonly id: string; readonly generation: number }
  >();
  const pendingActionNotifications = new Map<string, SubagentQuestionNotification>();
  let completionFlushScheduled = false;
  let actionFlushScheduled = false;
  let completionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
  let actionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;

  let scheduleCompletionFlush: Effect.Effect<void> = Effect.void;
  const flushPendingCompletions = Effect.suspend(() =>
    Effect.sleep(completionRetryDelayMillis).pipe(
      Effect.andThen(
        withCompletionGate(
          withLock(
            Effect.sync(() => collectPendingCompletionNotifications(records, pendingCompletions)),
          ).pipe(
            Effect.flatMap((runs) =>
              runs.length === 0
                ? withLock(
                    Effect.sync(() => {
                      completionFlushScheduled = false;
                      completionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
                    }),
                  )
                : Effect.sync(() => notify({ type: "completed", runs })).pipe(
                    Effect.flatMap((delivery) =>
                      withLock(
                        Effect.sync(() => {
                          const acknowledged = acknowledgePendingCompletions(
                            records,
                            pendingCompletions,
                            runs,
                            deliveredCompletionKeys(delivery, runs),
                          );
                          completionFlushScheduled = false;
                          completionRetryDelayMillis =
                            pendingCompletions.size === 0 || acknowledged > 0
                              ? COMPLETION_RETRY_INITIAL_MILLIS
                              : Math.min(
                                  COMPLETION_RETRY_MAX_MILLIS,
                                  completionRetryDelayMillis * 2,
                                );
                        }),
                      ),
                    ),
                  ),
            ),
          ),
        ),
      ),
      Effect.andThen(scheduleCompletionFlush),
      Effect.asVoid,
    ),
  );

  scheduleCompletionFlush = withLock(
    Effect.sync(() => {
      if (completionFlushScheduled || pendingCompletions.size === 0) return false;
      completionFlushScheduled = true;
      return true;
    }),
  ).pipe(
    Effect.flatMap((shouldSchedule) =>
      shouldSchedule
        ? flushPendingCompletions.pipe(
            Effect.forkIn(ownerScope, { startImmediately: true }),
            Effect.asVoid,
          )
        : Effect.void,
    ),
  );

  const queueCompletion = (record: RunRecord, generation: number) =>
    withLock(
      Effect.sync(() => queuePendingCompletion(pendingCompletions, record, generation)),
    ).pipe(Effect.andThen(scheduleCompletionFlush));

  const actionSlot = (notification: SubagentQuestionNotification) =>
    `${notification.id}:question:default`;
  const actionDeliveryKey = (notification: SubagentQuestionNotification) =>
    `${actionSlot(notification)}:${notification.generation}`;
  const actionRelevant = (notification: SubagentQuestionNotification): boolean => {
    const record = records.get(notification.id);
    // Question queueing stamps the record's current notification generation and
    // every later record transition increments it, so a queued question is
    // relevant exactly while it still matches that generation.
    return (
      record !== undefined &&
      record.notificationGeneration === notification.generation &&
      record.view.state === "waiting_for_parent" &&
      record.view.question?.requestId === notification.requestId
    );
  };

  type ActionDeliveryState =
    | { readonly retry: false }
    | { readonly retry: true; readonly immediate: true }
    | {
        readonly retry: true;
        readonly immediate: false;
        readonly wake: Deferred.Deferred<void>;
      };
  let scheduleActionFlush: Effect.Effect<void> = Effect.void;
  let actionDeliveryLoop: Effect.Effect<void> = Effect.void;
  let actionRetryWake: Deferred.Deferred<void> | undefined;
  actionDeliveryLoop = Effect.suspend(() =>
    withCompletionGate(
      withLock(
        Effect.sync(() => {
          const notifications = [...pendingActionNotifications.values()].filter((notification) => {
            if (actionRelevant(notification)) return true;
            pendingActionNotifications.delete(actionSlot(notification));
            return false;
          });
          // Clear the scheduler flag in the same critical section that observes no pending work.
          // A producer arriving afterward sees false and necessarily starts a replacement loop.
          if (notifications.length === 0) {
            actionFlushScheduled = false;
            actionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
            actionRetryWake = undefined;
          }
          return notifications;
        }),
      ).pipe(
        Effect.flatMap((notifications) =>
          notifications.length === 0
            ? Effect.succeed<ActionDeliveryState>({ retry: false })
            : Effect.sync(() =>
                notifications.map((notification) => ({
                  notification,
                  delivery: notify(notification),
                })),
              ).pipe(
                Effect.flatMap((deliveries) =>
                  withLock(
                    Effect.sync<ActionDeliveryState>(() => {
                      let acknowledged = 0;
                      const attempted = new Set(
                        deliveries.map(({ notification }) => actionDeliveryKey(notification)),
                      );
                      for (const { notification, delivery } of deliveries) {
                        const delivered = new Set(
                          delivery?.deliveredActionKeys ?? [actionDeliveryKey(notification)],
                        );
                        if (!delivered.has(actionDeliveryKey(notification))) continue;
                        if (
                          pendingActionNotifications.get(actionSlot(notification)) === notification
                        )
                          pendingActionNotifications.delete(actionSlot(notification));
                        acknowledged += 1;
                      }
                      actionRetryDelayMillis =
                        pendingActionNotifications.size === 0 || acknowledged > 0
                          ? COMPLETION_RETRY_INITIAL_MILLIS
                          : Math.min(COMPLETION_RETRY_MAX_MILLIS, actionRetryDelayMillis * 2);
                      if (pendingActionNotifications.size === 0) {
                        actionFlushScheduled = false;
                        actionRetryWake = undefined;
                        return { retry: false };
                      }
                      const immediate = [...pendingActionNotifications.values()].some(
                        (notification) => !attempted.has(actionDeliveryKey(notification)),
                      );
                      if (immediate) {
                        actionRetryWake = undefined;
                        return { retry: true, immediate: true };
                      }
                      const wake = Deferred.makeUnsafe<void>();
                      actionRetryWake = wake;
                      return { retry: true, immediate: false, wake };
                    }),
                  ),
                ),
              ),
        ),
      ),
    ).pipe(
      Effect.flatMap((state) => {
        if (!state.retry) return Effect.void;
        if (state.immediate) return actionDeliveryLoop;
        return Effect.raceFirst(
          Effect.sleep(actionRetryDelayMillis),
          Deferred.await(state.wake),
        ).pipe(
          Effect.andThen(
            withLock(
              Effect.sync(() => {
                if (actionRetryWake === state.wake) actionRetryWake = undefined;
              }),
            ),
          ),
          Effect.andThen(actionDeliveryLoop),
        );
      }),
    ),
  );

  scheduleActionFlush = withLock(
    Effect.sync(() => {
      if (actionFlushScheduled || pendingActionNotifications.size === 0) return false;
      actionFlushScheduled = true;
      return true;
    }),
  ).pipe(
    Effect.flatMap((shouldSchedule) =>
      shouldSchedule
        ? actionDeliveryLoop.pipe(
            Effect.forkIn(ownerScope, { startImmediately: true }),
            Effect.asVoid,
          )
        : Effect.void,
    ),
  );

  const queueActionNotification = (
    record: RunRecord,
    notification: Omit<SubagentQuestionNotification, "generation">,
  ) =>
    withLock(
      Effect.sync(() => {
        const generation = ++record.notificationGeneration;
        const queued = { ...notification, generation } as SubagentQuestionNotification;
        pendingActionNotifications.set(actionSlot(queued), queued);
        if (actionRetryWake) Deferred.doneUnsafe(actionRetryWake, Effect.void);
      }),
    ).pipe(Effect.andThen(scheduleActionFlush));

  return {
    /** Best-effort scheduler; safe to run whenever queued work may exist. */
    scheduleCompletionFlush,
    /** Locks internally, queues one completion generation, and schedules delivery. */
    queueCompletion,
    /** Locks internally, stamps the question generation, queues it, and wakes a sleeping retry. */
    queueActionNotification,
    /** Caller must hold the service lock; schedule the flush after the critical section commits. */
    queueCompletionLocked: (record: RunRecord, generation: number): void =>
      queuePendingCompletion(pendingCompletions, record, generation),
    /** Caller must hold the service lock (claim acquisition and consumption paths). */
    removeCompletionLocked: (id: string, generation: number): void =>
      removePendingCompletion(pendingCompletions, id, generation),
    /** Caller must hold the service lock; requeues a released claim for redelivery. */
    requeueCompletionLocked: (record: RunRecord, generation: number): void =>
      queuePendingCompletion(pendingCompletions, record, generation),
    /** Caller must hold the service lock; drops the run's single default question slot. */
    discardQuestionLocked: (id: string): void =>
      void pendingActionNotifications.delete(`${id}:question:default`),
    /** Caller must hold the service lock; drops every queued question owned by the run. */
    discardRunQuestionsLocked: (id: string): void => {
      for (const [slot, notification] of pendingActionNotifications)
        if (notification.id === id) pendingActionNotifications.delete(slot);
    },
  };
}

export type RunNotificationDelivery = ReturnType<typeof makeRunNotificationDelivery>;
