import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
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
  /** Owner scope for the persistent outbox workers. */
  readonly ownerScope: Scope.Scope;
  readonly records: ReadonlyMap<string, RunRecord>;
  /** The shared service lock. Every `*Locked` method requires the caller to hold it. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** The shared completion gate serializing delivery ownership against claim acquisition. */
  readonly withCompletionGate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Host boundary; must be called outside the service lock. */
  readonly notify: (notification: SubagentNotification) => SubagentNotificationDelivery | undefined;
}

type ActionDeliveryState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Retry"; readonly immediate: boolean; readonly delayMillis: number };

/**
 * Owns the completion/question delivery outbox. Two owner-scoped workers stay
 * alive for the service lifetime and sleep on reusable latches while idle.
 * Mutations remain caller-lock-required so record transitions and outbox state
 * commit in one critical section.
 */
export const makeRunNotificationDelivery = Effect.fn("RunNotificationDelivery.make")(function* (
  dependencies: RunNotificationDeliveryDependencies,
) {
  const { ownerScope, records, withLock, withCompletionGate, notify } = dependencies;
  const pendingCompletions = new Map<
    string,
    { readonly id: string; readonly generation: number }
  >();
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
          const runs = yield* withLock(
            Effect.sync(() => {
              Latch.closeUnsafe(completionWake);
              return collectPendingCompletionNotifications(records, pendingCompletions);
            }),
          );
          if (runs.length === 0) {
            yield* withLock(
              Effect.sync(() => {
                completionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
              }),
            );
            return;
          }
          const delivery = yield* Effect.sync(() => notify({ type: "completed", runs }));
          yield* withLock(
            Effect.sync(() => {
              const acknowledged = acknowledgePendingCompletions(
                records,
                pendingCompletions,
                runs,
                deliveredCompletionKeys(delivery, runs),
              );
              completionRetryDelayMillis =
                pendingCompletions.size === 0 || acknowledged > 0
                  ? COMPLETION_RETRY_INITIAL_MILLIS
                  : Math.min(COMPLETION_RETRY_MAX_MILLIS, completionRetryDelayMillis * 2);
              if (pendingCompletions.size > 0) Latch.openUnsafe(completionWake);
            }),
          );
        }),
      );
    }),
  );

  const completionWorker = Effect.forever(
    Latch.await(completionWake).pipe(Effect.andThen(flushPendingCompletions)),
  );

  const scheduleCompletionFlush = withLock(
    Effect.sync(() => {
      if (pendingCompletions.size > 0) Latch.openUnsafe(completionWake);
    }),
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
    return (
      record !== undefined &&
      record.notificationGeneration === notification.generation &&
      record.view.state === "waiting_for_parent" &&
      record.view.question?.requestId === notification.requestId
    );
  };

  const flushPendingActions: Effect.Effect<ActionDeliveryState> = withCompletionGate(
    withLock(
      Effect.sync(() => {
        Latch.closeUnsafe(actionWake);
        const notifications = [...pendingActionNotifications.values()].filter((notification) => {
          if (actionRelevant(notification)) return true;
          pendingActionNotifications.delete(actionSlot(notification));
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
                      if (pendingActionNotifications.get(actionSlot(notification)) === notification)
                        pendingActionNotifications.delete(actionSlot(notification));
                      acknowledged += 1;
                    }
                    actionRetryDelayMillis =
                      pendingActionNotifications.size === 0 || acknowledged > 0
                        ? COMPLETION_RETRY_INITIAL_MILLIS
                        : Math.min(COMPLETION_RETRY_MAX_MILLIS, actionRetryDelayMillis * 2);
                    if (pendingActionNotifications.size === 0) return { _tag: "Idle" };
                    const immediate = [...pendingActionNotifications.values()].some(
                      (notification) => !attempted.has(actionDeliveryKey(notification)),
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
        pendingActionNotifications.set(actionSlot(queued), queued);
        Latch.openUnsafe(actionWake);
      }),
    );

  return {
    /** Best-effort wakeup; safe whenever queued completion work may exist. */
    scheduleCompletionFlush,
    /** Locks internally, queues one completion generation, and wakes delivery. */
    queueCompletion,
    /** Locks internally, stamps the question generation, queues it, and wakes delivery. */
    queueActionNotification,
    /** Caller must hold the service lock; wake completion delivery after commit. */
    queueCompletionLocked: (record: RunRecord, generation: number): void =>
      queuePendingCompletion(pendingCompletions, record, generation),
    /** Caller must hold the service lock. */
    removeCompletionLocked: (id: string, generation: number): void =>
      removePendingCompletion(pendingCompletions, id, generation),
    /** Caller must hold the service lock; wake completion delivery after commit. */
    requeueCompletionLocked: (record: RunRecord, generation: number): void =>
      queuePendingCompletion(pendingCompletions, record, generation),
    /** Caller must hold the service lock; drops the run's default question slot. */
    discardQuestionLocked: (id: string): void =>
      void pendingActionNotifications.delete(`${id}:question:default`),
    /** Caller must hold the service lock; drops every queued question owned by the run. */
    discardRunQuestionsLocked: (id: string): void => {
      for (const [slot, notification] of pendingActionNotifications)
        if (notification.id === id) pendingActionNotifications.delete(slot);
    },
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
