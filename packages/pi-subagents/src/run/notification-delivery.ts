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

export type SubagentQuestionNotification = Extract<
  SubagentNotification,
  { readonly type: "question" }
>;

export interface RunNotificationDeliveryDependencies extends Pick<
  RunContext,
  "ownerScope" | "records" | "withLock"
> {
  readonly withCompletionGate: WithRunLock;
  readonly notify: (
    notification: SubagentNotification,
  ) => Effect.Effect<SubagentNotificationDelivery | undefined>;
}

export interface QuestionNotificationReceipt {
  readonly id: string;
  readonly generation: number;
  readonly requestId: string;
  readonly claimToken: string;
}

const nextRetryDelay = (delayMillis: number, reset: boolean): number =>
  reset ? COMPLETION_RETRY_INITIAL_MILLIS : Math.min(COMPLETION_RETRY_MAX_MILLIS, delayMillis * 2);

type ActionDeliveryState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Retry"; readonly immediate: boolean; readonly delayMillis: number };

export const makeRunNotificationDelivery = Effect.fn("RunNotificationDelivery.make")(function* (
  dependencies: RunNotificationDeliveryDependencies,
) {
  const { ownerScope, records, withLock, withCompletionGate, notify } = dependencies;
  const pendingActionNotifications = new Map<string, SubagentQuestionNotification>();
  const questionClaims = new Map<string, string>();
  const completionWake = yield* Latch.make();
  const actionWake = yield* Latch.make();
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
      const runs = selected.map((item) => item.notification);
      const delivery = yield* notify({ type: "completed", runs });
      return yield* withLock(
        Effect.sync(() => {
          const acknowledged = acknowledgeCompletionSelections(
            selected,
            deliveredCompletionKeys(delivery, runs),
          );
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

  const flushPendingActions: Effect.Effect<ActionDeliveryState> = withCompletionGate(
    withLock(
      Effect.sync(() => {
        Latch.closeUnsafe(actionWake);
        const notifications = [...pendingActionNotifications.values()].filter((notification) => {
          if (questionClaims.has(notification.id)) return false;
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
          : Effect.forEach(
              notifications,
              (notification) =>
                notify(notification).pipe(
                  Effect.map((delivery) => ({
                    notification,
                    accepted: delivery?.actionAccepted ?? true,
                  })),
                ),
              { concurrency: 4 },
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
                    actionRetryDelayMillis = nextRetryDelay(
                      actionRetryDelayMillis,
                      pendingActionNotifications.size === 0 || acknowledged > 0,
                    );
                    if (pendingActionNotifications.size === 0) return { _tag: "Idle" };
                    const immediate = [...pendingActionNotifications.values()].some(
                      (notification) =>
                        !attempted.has(notification) &&
                        actionRelevant(notification) &&
                        !questionClaims.has(notification.id),
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

  const queueActionNotificationLocked = (
    record: RunRecord,
    notification: Omit<SubagentQuestionNotification, "generation">,
  ): void => {
    const queued: SubagentQuestionNotification = {
      ...notification,
      generation: ++record.notificationGeneration,
    };
    pendingActionNotifications.set(record.view.id, queued);
    Latch.openUnsafe(actionWake);
  };
  const claimQuestionsLocked = (claimed: ReadonlyArray<RunRecord>, token: string): void => {
    for (const record of claimed) questionClaims.set(record.view.id, token);
  };
  const questionReceiptLocked = (
    record: RunRecord,
    token: string,
  ): QuestionNotificationReceipt | undefined => {
    const pending = pendingActionNotifications.get(record.view.id);
    return questionClaims.get(record.view.id) === token && pending && actionRelevant(pending)
      ? {
          id: pending.id,
          generation: pending.generation,
          requestId: pending.requestId,
          claimToken: token,
        }
      : undefined;
  };
  const acknowledgeQuestionsLocked = (
    receipts: ReadonlyArray<QuestionNotificationReceipt>,
  ): void => {
    for (const receipt of receipts) {
      const pending = pendingActionNotifications.get(receipt.id);
      if (
        questionClaims.get(receipt.id) === receipt.claimToken &&
        pending?.generation === receipt.generation &&
        pending.requestId === receipt.requestId
      )
        pendingActionNotifications.delete(receipt.id);
    }
  };
  const releaseQuestionClaimsLocked = (claimed: ReadonlyArray<RunRecord>, token: string): void => {
    for (const record of claimed) {
      if (questionClaims.get(record.view.id) !== token) continue;
      questionClaims.delete(record.view.id);
      if (pendingActionNotifications.has(record.view.id)) Latch.openUnsafe(actionWake);
    }
  };

  return {
    deliverPendingCompletions,
    queueActionNotificationLocked,
    claimQuestionsLocked,
    questionReceiptLocked,
    acknowledgeQuestionsLocked,
    releaseQuestionClaimsLocked,
    insertCompletionLocked: (record: RunRecord, completion: CompletionGenerationRecord): void => {
      record.completionGenerations.set(completion.generation, completion);
      Latch.openUnsafe(completionWake);
    },
    wakeCompletionLocked: (): void => {
      Latch.openUnsafe(completionWake);
    },
    discardQuestionLocked: (id: string): void => void pendingActionNotifications.delete(id),
  };
});

export type RunNotificationDelivery = Effect.Success<
  ReturnType<typeof makeRunNotificationDelivery>
>;
