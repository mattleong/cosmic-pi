import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
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
import type { CompletionGenerationRecord, RunContext, RunRecord, WithRunLock } from "./internal.ts";
import { COMPLETION_RETRY_INITIAL_MILLIS, COMPLETION_RETRY_MAX_MILLIS } from "./limits.ts";
import { keepsTakingNotifications } from "./notification-routing.ts";

type SubagentQuestionNotification = Extract<SubagentNotification, { readonly type: "question" }>;

interface RunNotificationDeliveryDependencies extends Pick<
  RunContext,
  "ownerScope" | "records" | "withLock"
> {
  readonly withCompletionGate: WithRunLock;
  readonly notify: (
    notification: SubagentNotification,
  ) => Effect.Effect<SubagentNotificationDelivery | undefined>;
}

const nextRetryDelay = (delayMillis: number, reset: boolean): number =>
  reset ? COMPLETION_RETRY_INITIAL_MILLIS : Math.min(COMPLETION_RETRY_MAX_MILLIS, delayMillis * 2);

type ActionDeliveryState = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Retry: { readonly immediate: boolean; readonly delayMillis: number };
}>;
const ActionDeliveryState = Data.taggedEnum<ActionDeliveryState>();

export const notificationDelivery = Effect.fn("RunNotificationDelivery.acquire")(function* (
  dependencies: RunNotificationDeliveryDependencies,
) {
  const { ownerScope, records, withLock, withCompletionGate, notify } = dependencies;
  // Each question reaches the model whole only through its notice, even while an await shows
  // its preview, so nothing claims or acknowledges it elsewhere.
  const pendingActionNotifications = new Map<string, SubagentQuestionNotification>();
  // Question notices an ancestor run took, by asking run. A run that stops taking notices before
  // its descendant's question is answered hands that question on to the next recipient.
  const takenQuestions = new Map<
    string,
    { readonly notification: SubagentQuestionNotification; readonly recipientRunId: string }
  >();
  const completionWake = yield* Latch.make();
  const actionWake = yield* Latch.make();
  // Completions leave the outbox, or become claimed, without a new projection revision. Each such
  // change under the run lock completes this and replaces it, so a waiter that read it in the same
  // lock hold as its check can't miss the change.
  let outboxChanged = yield* Deferred.make<void>();
  const signalOutboxChangedLocked = (): void => {
    Deferred.doneUnsafe(outboxChanged, Effect.void);
    outboxChanged = Deferred.makeUnsafe<void>();
  };
  // The delay is shared worker state, not a Schedule: it resets whenever a batch is acknowledged,
  // across worker wakes, and doubles only while every eligible notice stays unacknowledged.
  let completionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
  let actionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;

  const deliverCompletionBatch: Effect.Effect<boolean> = withCompletionGate(
    Effect.gen(function* () {
      const selected = yield* withLock(
        Effect.sync(() => {
          Latch.closeUnsafe(completionWake);
          return collectCompletionDeliveryBatch(records);
        }),
      );
      if (selected.length === 0) {
        completionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
        return false;
      }
      const runs = Arr.map(selected, (item) => item.notification);
      const delivery = yield* notify({ type: "completed", runs });
      return yield* withLock(
        Effect.sync(() => {
          const acknowledged = acknowledgeCompletionSelections(
            selected,
            deliveredCompletionKeys(delivery, runs),
          );
          if (acknowledged > 0) signalOutboxChangedLocked();
          const eligibleRemain = hasEligibleCompletion(records);
          completionRetryDelayMillis = nextRetryDelay(
            completionRetryDelayMillis,
            !eligibleRemain || acknowledged > 0,
          );
          if (eligibleRemain) Latch.openUnsafe(completionWake);
          return eligibleRemain && acknowledged > 0;
        }),
      );
    }),
  );

  const flushPendingCompletions = Effect.suspend(() =>
    Effect.sleep(Duration.millis(completionRetryDelayMillis)),
  ).pipe(Effect.andThen(deliverCompletionBatch));

  // Delivers every eligible completion now, batch by batch, while the notifier keeps accepting.
  const deliverPendingCompletions: Effect.Effect<void> = deliverCompletionBatch.pipe(
    Effect.flatMap((more) => (more ? deliverPendingCompletions : Effect.void)),
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

  const takeQuestionLocked = (
    notification: SubagentQuestionNotification,
    recipientRunId: string,
  ): void => {
    const recipient = records.get(recipientRunId);
    // The recipient may have stopped taking notices while the notice was in flight.
    if (!recipient || !keepsTakingNotifications(recipient))
      requeueTakenQuestionLocked(notification);
    else if (actionRelevant(notification))
      takenQuestions.set(notification.id, { notification, recipientRunId });
  };

  const flushPendingActions: Effect.Effect<ActionDeliveryState> = withCompletionGate(
    withLock(
      Effect.sync(() => {
        Latch.closeUnsafe(actionWake);
        const notifications = Arr.filter(
          [...pendingActionNotifications.values()],
          (notification) => {
            if (actionRelevant(notification)) return true;
            if (pendingActionNotifications.get(notification.id) === notification)
              pendingActionNotifications.delete(notification.id);
            return false;
          },
        );
        if (notifications.length === 0) actionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
        return notifications;
      }),
    ).pipe(
      Effect.flatMap((notifications) =>
        notifications.length === 0
          ? Effect.succeed(ActionDeliveryState.Idle())
          : Effect.forEach(
              notifications,
              (notification) =>
                notify(notification).pipe(
                  Effect.map((delivery) => ({
                    notification,
                    accepted: delivery?.actionAccepted ?? true,
                    recipientRunId: delivery?.recipientRunId,
                  })),
                ),
              { concurrency: 4 },
            ).pipe(
              Effect.flatMap((deliveries) =>
                withLock(
                  Effect.sync<ActionDeliveryState>(() => {
                    let acknowledged = 0;
                    const attempted = new Set(
                      Arr.map(deliveries, ({ notification }) => notification),
                    );
                    for (const { notification, accepted, recipientRunId } of deliveries) {
                      if (!accepted) continue;
                      if (pendingActionNotifications.get(notification.id) === notification)
                        pendingActionNotifications.delete(notification.id);
                      acknowledged += 1;
                      if (recipientRunId !== undefined)
                        takeQuestionLocked(notification, recipientRunId);
                    }
                    actionRetryDelayMillis = nextRetryDelay(
                      actionRetryDelayMillis,
                      pendingActionNotifications.size === 0 || acknowledged > 0,
                    );
                    if (pendingActionNotifications.size === 0) return ActionDeliveryState.Idle();
                    const immediate = Arr.some(
                      [...pendingActionNotifications.values()],
                      (notification) =>
                        !attempted.has(notification) && actionRelevant(notification),
                    );
                    return ActionDeliveryState.Retry({
                      immediate,
                      delayMillis: actionRetryDelayMillis,
                    });
                  }),
                ),
              ),
            ),
      ),
    ),
  );

  const deliverPendingActions = (): Effect.Effect<void> =>
    flushPendingActions.pipe(
      Effect.flatMap(
        ActionDeliveryState.$match({
          Idle: () => Effect.void,
          Retry: ({ immediate, delayMillis }) =>
            (immediate
              ? Effect.void
              : Effect.raceFirst(
                  Effect.sleep(Duration.millis(delayMillis)),
                  Latch.await(actionWake),
                )
            ).pipe(Effect.flatMap(() => deliverPendingActions())),
        }),
      ),
    );

  const actionWorker = Effect.forever(
    Latch.await(actionWake).pipe(Effect.flatMap(() => deliverPendingActions())),
  );

  yield* Effect.forkIn(completionWorker, ownerScope, { startImmediately: true });
  yield* Effect.forkIn(actionWorker, ownerScope, { startImmediately: true });

  const queueActionNotificationLocked = (
    record: RunRecord,
    notification: Omit<SubagentQuestionNotification, "generation">,
  ): void => {
    const queued: SubagentQuestionNotification = {
      ...notification,
      generation: ++record.notificationGeneration,
    };
    takenQuestions.delete(record.view.id);
    pendingActionNotifications.set(record.view.id, queued);
    Latch.openUnsafe(actionWake);
  };

  // Queues a taken question again under a new generation, so the next recipient's key differs.
  // A run being stopped needs no answer.
  const requeueTakenQuestionLocked = (notification: SubagentQuestionNotification): void => {
    takenQuestions.delete(notification.id);
    const record = records.get(notification.id);
    if (record && !record.stoppedByParent && actionRelevant(notification))
      queueActionNotificationLocked(record, notification);
  };
  return {
    deliverPendingCompletions,
    queueActionNotificationLocked,
    insertCompletionLocked: (record: RunRecord, completion: CompletionGenerationRecord): void => {
      record.completionGenerations.set(completion.generation, completion);
      Latch.openUnsafe(completionWake);
    },
    wakeCompletionLocked: (): void => {
      Latch.openUnsafe(completionWake);
    },
    /** Completes once a completion is consumed, acknowledged, or claimed after this call. */
    outboxChangedLocked: (): Deferred.Deferred<void> => outboxChanged,
    signalOutboxChangedLocked,
    discardQuestionLocked: (id: string): void => {
      pendingActionNotifications.delete(id);
      takenQuestions.delete(id);
    },
    /**
     * Hands on the questions `runId` took and hasn't seen answered; called in the same transition
     * that stops it taking notices.
     */
    requeueQuestionsTakenByLocked: (runId: string): void => {
      for (const { notification, recipientRunId } of takenQuestions.values())
        if (recipientRunId === runId) requeueTakenQuestionLocked(notification);
    },
  };
});

export type RunNotificationDelivery = Effect.Success<ReturnType<typeof notificationDelivery>>;
