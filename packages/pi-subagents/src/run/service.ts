import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { freezeSnapshot } from "pi-cosmic-core";
import { ChildProcess, type ChildLaunchRequest } from "../boundary/child-process.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type {
  SubagentNotification,
  SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import type { ChildRateLimitEvent } from "./child-agent.ts";
import {
  InvalidSubagentRequestError,
  SubagentCapacityError,
  type SubagentError,
  SubagentNotFoundError,
  SubagentProcessError,
  SubagentRuntimeClosedError,
  SubagentWriterConflictError,
  UnsupportedSubagentCapabilityError,
} from "./errors.ts";
import {
  acknowledgePendingCompletions,
  collectPendingCompletionNotifications,
  deliveredCompletionKeys,
  queuePendingCompletion,
} from "./completion.ts";
import { makeRunControls } from "./control.ts";
import {
  childSystemPrompt,
  peerNoticeText,
  taskPrompt,
  validateParentMessage,
} from "./coordination.ts";
import { makeRunEventHandler } from "./events.ts";
import type { RunRecord } from "./internal.ts";
import { makeRunProcessLifecycle } from "./process-lifecycle.ts";
import {
  COMPLETION_RETRY_INITIAL_MILLIS,
  COMPLETION_RETRY_MAX_MILLIS,
  MAX_CONCURRENT_RUNS,
  MAX_RETAINED_RUNS,
} from "./limits.ts";
import {
  CLAUDE_CLI_SUBAGENT_CAPABILITIES,
  emptyUsage,
  hasSubagentCapability,
  isActiveRunState,
  isClaudeModelSelector,
  isTerminalRunState,
  PI_SUBAGENT_CAPABILITIES,
  type StartSubagentRequest,
  type SubagentBackend,
  type SubagentCapability,
  type SubagentProjection,
  type SubagentRunView,
} from "./model.ts";
import {
  rpcStateModelId,
  type RpcCommand,
  type RpcResponse,
  type RpcStateData,
} from "./protocol.ts";
import { sortRuns } from "./projection.ts";
import {
  advanceRateLimitNotice,
  isRejectedRateLimit,
  rateLimitMessage,
  rateLimitWindowKey,
} from "./rate-limit.ts";
import { appendNoticeSessionEvent } from "./session-output.ts";
import {
  MAX_ERROR_CHARS,
  MAX_TASK_CHARS,
  sanitizeDiagnosticText,
  sanitizeName,
  snapshotView,
} from "./state.ts";

const CLAUDE_RATE_LIMIT_RESULT_GRACE = "2 seconds";

let nextRuntimeNamespace = 1;
const allocateRuntimeNamespace = (): string => `r${(nextRuntimeNamespace++).toString(36)}`;

const ownsProcessSlot = (record: RunRecord): boolean =>
  record.cleanupPending || record.process !== undefined || record.view.state === "starting";

const ownsWriterSlot = (record: RunRecord): boolean =>
  record.view.writeIntent === "writer" &&
  (record.cleanupPending || isActiveRunState(record.view.state));

const recordDeliveredRateLimitRejection = (
  record: RunRecord | undefined,
  windowKey: string,
): void => {
  if (!record) return;
  if (!record.deliveredRateLimitRejections.has(windowKey)) {
    if (record.deliveredRateLimitRejections.size >= 32) {
      const oldest = record.deliveredRateLimitRejections.values().next().value;
      if (oldest !== undefined) record.deliveredRateLimitRejections.delete(oldest);
    }
    record.deliveredRateLimitRejections.add(windowKey);
  }
};

export type SubagentNotificationCallback =
  | ((notification: SubagentNotification) => SubagentNotificationDelivery | undefined)
  | ((notification: SubagentNotification) => void);

export interface SubagentServiceOptions {
  readonly publish?: (projection: SubagentProjection) => void;
  readonly notify?: SubagentNotificationCallback;
}

export type SubagentAwaitUntil = "all_finished" | "any_finished";

export interface SubagentCompletionReceipt {
  readonly id: string;
  readonly generation: number;
}

export interface SubagentRunObservation {
  readonly run: SubagentRunView;
  readonly completionReceipt?: SubagentCompletionReceipt | undefined;
}

export interface SubagentStatusObservations {
  readonly observations: ReadonlyArray<SubagentRunObservation>;
  readonly missingIds: ReadonlyArray<string>;
}

export interface SubagentServiceShape {
  readonly start: (request: StartSubagentRequest) => Effect.Effect<SubagentRunView, SubagentError>;
  /** Submit one launch to the session owner; cancelling the waiter never abandons ownership. */
  readonly startSessionOwned: (
    request: StartSubagentRequest,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly withForegroundStartObservation: <A, E, R>(
    request: StartSubagentRequest,
    use: (
      started: SubagentRunView,
      awaitObservation: Effect.Effect<SubagentRunObservation>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, SubagentError | E, R>;
  readonly waitForForeground: (id: string) => Effect.Effect<SubagentRunView, SubagentNotFoundError>;
  readonly withForegroundObservation: <A, E, R>(
    id: string,
    use: (observation: SubagentRunObservation) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, SubagentNotFoundError | E, R>;
  readonly awaitTerminal: (
    ids: ReadonlyArray<string>,
    until: SubagentAwaitUntil,
    onUpdate?: (runs: ReadonlyArray<SubagentRunView>) => void,
  ) => Effect.Effect<ReadonlyArray<SubagentRunView>, SubagentError>;
  readonly withAwaitTerminalObservations: <A, E, R>(
    ids: ReadonlyArray<string>,
    until: SubagentAwaitUntil,
    onUpdate: ((runs: ReadonlyArray<SubagentRunView>) => void) | undefined,
    use: (observations: ReadonlyArray<SubagentRunObservation>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, SubagentError | E, R>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentRunView>>;
  readonly status: (id: string) => Effect.Effect<SubagentRunView, SubagentNotFoundError>;
  readonly withStatusObservations: <A, E, R>(
    ids: ReadonlyArray<string>,
    use: (selection: SubagentStatusObservations) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, InvalidSubagentRequestError | E, R>;
  readonly consumeCompletions: (
    receipts: ReadonlyArray<SubagentCompletionReceipt>,
  ) => Effect.Effect<void>;
  readonly send: (id: string, message: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly reply: (id: string, message: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly interrupt: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly resume: (id: string, message?: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly rename: (id: string, name: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly stop: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly projection: Effect.Effect<SubagentProjection>;
}

const notFound = (id: string) =>
  new SubagentNotFoundError({ id, message: `Subagent run not found: ${id}` });
const capabilitiesFor = (request: StartSubagentRequest) =>
  request.backend === "claude-cli" ? CLAUDE_CLI_SUBAGENT_CAPABILITIES : PI_SUBAGENT_CAPABILITIES;
const unsupportedCapabilityMessage = (
  backend: SubagentBackend,
  capability: SubagentCapability,
  id: string,
): string => {
  switch (capability) {
    case "steer":
      return `${backend} subagents do not support mid-turn guidance. Await with subagent_await({ runIds: ["${id}"], until: "all_finished", timeoutSeconds: 0 }), inspect with subagent_status({ runIds: ["${id}"] }), or stop with subagent_lifecycle({ action: "stop", runIds: ["${id}"] }).`;
    case "interrupt":
      return `${backend} subagents do not support interruption. Stop with subagent_lifecycle({ action: "stop", runIds: ["${id}"] }) or wait with subagent_await.`;
    case "parent-contact":
      return `${backend} subagents do not support parent questions or subagent_reply; use subagent_await or subagent_status instead.`;
    default:
      return `${backend} subagents do not support ${capability}. Inspect supported operations with subagent_status({ runIds: ["${id}"] }).`;
  }
};

const requireCapability = (
  record: RunRecord,
  capability: SubagentCapability,
): Effect.Effect<void, UnsupportedSubagentCapabilityError> =>
  hasSubagentCapability(record.view, capability)
    ? Effect.void
    : Effect.fail(
        new UnsupportedSubagentCapabilityError({
          backend: record.view.backend,
          capability,
          message: unsupportedCapabilityMessage(record.view.backend, capability, record.view.id),
        }),
      );

const makeService = Effect.fn("SubagentService.make")(function* (options: SubagentServiceOptions) {
  const childProcesses = yield* ChildProcess;
  const profileService = yield* SubagentProfileService;
  const ownerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const completionGate = yield* Semaphore.make(1);
  const records = new Map<string, RunRecord>();
  const revisionWaiters = new Set<Deferred.Deferred<void>>();
  const pendingCompletions = new Map<string, number>();
  const pendingActionNotifications = new Map<
    string,
    Extract<SubagentNotification, { readonly type: "question" | "warning" }>
  >();
  let completionFlushScheduled = false;
  let actionFlushScheduled = false;
  let completionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
  let actionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
  const runtimeNamespace = allocateRuntimeNamespace();
  let nextRunOrdinal = 1;
  let revision = 0;
  let closed = false;

  const withLock = lock.withPermits(1);
  const withCompletionGate = completionGate.withPermits(1);
  const currentProjection = (): SubagentProjection => ({
    revision,
    runs: sortRuns([...records.values()].map((record) => snapshotView(record.view))),
  });
  const publish = () => {
    revision += 1;
    for (const waiter of revisionWaiters) Deferred.doneUnsafe(waiter, Effect.void);
    revisionWaiters.clear();
    try {
      options.publish?.(freezeSnapshot(currentProjection()));
    } catch {
      // Host projection delivery cannot own the fleet lifecycle.
    }
  };
  const notify = (notification: SubagentNotification): SubagentNotificationDelivery | undefined => {
    try {
      const delivery = options.notify?.(notification);
      return typeof delivery === "object" && delivery !== null ? delivery : undefined;
    } catch {
      // Host transcript delivery is acknowledged only when the boundary returned normally.
      return notification.type === "completed"
        ? { deliveredCompletionKeys: [] }
        : { deliveredActionKeys: [] };
    }
  };
  const requireRecord = (id: string): Effect.Effect<RunRecord, SubagentNotFoundError> =>
    Effect.suspend(() => {
      const record = records.get(id);
      return record ? Effect.succeed(record) : Effect.fail(notFound(id));
    });

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

  const actionSlot = (
    notification: Extract<SubagentNotification, { type: "question" | "warning" }>,
  ) =>
    `${notification.id}:${notification.type}:${notification.type === "warning" ? (notification.slotKey ?? "default") : "default"}`;
  const actionDeliveryKey = (
    notification: Extract<SubagentNotification, { type: "question" | "warning" }>,
  ) => `${actionSlot(notification)}:${notification.generation}`;
  const actionRelevant = (
    notification: Extract<SubagentNotification, { type: "question" | "warning" }>,
  ): boolean => {
    const record = records.get(notification.id);
    if (!record || record.notificationGeneration < notification.generation) return false;
    if (notification.type === "question")
      return (
        record.questionNotificationGeneration === notification.generation &&
        record.view.state === "waiting_for_parent" &&
        record.view.question?.requestId === notification.requestId
      );
    return (
      record.warningNotificationGenerations.get(actionSlot(notification)) ===
      notification.generation
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
                        if (notification.type === "warning" && notification.rateLimitRejectionKey) {
                          recordDeliveredRateLimitRejection(
                            records.get(notification.id),
                            notification.rateLimitRejectionKey,
                          );
                        }
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
    notification:
      | Omit<Extract<SubagentNotification, { type: "question" }>, "generation">
      | Omit<Extract<SubagentNotification, { type: "warning" }>, "generation">,
  ) =>
    withLock(
      Effect.sync(() => {
        const generation = ++record.notificationGeneration;
        const queued = { ...notification, generation } as Extract<
          SubagentNotification,
          { type: "question" | "warning" }
        >;
        if (queued.type === "question") record.questionNotificationGeneration = generation;
        else record.warningNotificationGenerations.set(actionSlot(queued), generation);
        pendingActionNotifications.set(actionSlot(queued), queued);
        if (actionRetryWake) Deferred.doneUnsafe(actionRetryWake, Effect.void);
      }),
    ).pipe(Effect.andThen(scheduleActionFlush));

  const mutateEventView = (
    record: RunRecord,
    update: (view: SubagentRunView) => SubagentRunView | undefined,
  ) =>
    withLock(
      Effect.sync(() => {
        if (
          record.stoppedByParent ||
          record.view.state === "stopping" ||
          isTerminalRunState(record.view.state)
        )
          return undefined;
        const next = update(record.view);
        if (!next) return undefined;
        record.view = next;
        publish();
        return snapshotView(record.view);
      }),
    );
  const deliverForeground = (record: RunRecord, view: SubagentRunView): boolean => {
    if (!record.foregroundWaitPending) return false;
    record.foregroundWaitPending = false;
    if (view.state === "completed") {
      record.completionClaims += 1;
      record.foregroundCompletionClaimGeneration = record.completionGeneration;
      pendingCompletions.delete(record.view.id);
    }
    Deferred.doneUnsafe(record.foregroundOutcome, Effect.succeed(view));
    return true;
  };
  const pauseFromEvent = (record: RunRecord, now: number) =>
    withLock(
      Effect.sync(() => {
        if (
          !record.pauseRequested ||
          record.stoppedByParent ||
          record.view.state === "stopping" ||
          isTerminalRunState(record.view.state)
        )
          return undefined;
        record.activeTools.clear();
        record.view = {
          ...record.view,
          state: "paused",
          lastActivityAt: now,
          question: undefined,
          currentTool: undefined,
        };
        const view = snapshotView(record.view);
        record.pauseRequested = false;
        const outcome = record.pauseOutcome;
        record.pauseOutcome = undefined;
        publish();
        if (outcome) Deferred.doneUnsafe(outcome, Effect.succeed(view));
        deliverForeground(record, view);
        return view;
      }),
    );
  const failPendingResponses = (record: RunRecord, error: SubagentError) => {
    for (const response of record.responses.values())
      Deferred.doneUnsafe(response, Effect.fail(error));
    record.responses.clear();
  };
  const markCleanupPending = (record: RunRecord) =>
    withLock(
      Effect.sync(() => {
        record.cleanupPending = true;
      }),
    );
  const clearCleanupPending = (record: RunRecord, scope: Scope.Closeable = record.scope) =>
    withLock(
      Effect.sync(() => {
        if (record.scope !== scope) return;
        record.cleanupPending = false;
        record.process = undefined;
        if (record.view.pid !== undefined) {
          const { pid: _pid, ...view } = record.view;
          record.view = view;
          publish();
        }
      }),
    );
  const closeRecordScope = (record: RunRecord, scope: Scope.Closeable = record.scope) =>
    Scope.close(scope, Exit.void).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        clearCleanupPending(record, scope).pipe(
          Effect.tap(() =>
            Exit.isFailure(exit)
              ? Effect.logWarning("Subagent scope cleanup failed; ownership was released.").pipe(
                  Effect.annotateLogs("runId", record.view.id),
                )
              : Effect.void,
          ),
        ),
      ),
    );
  const closeExitedScope = (record: RunRecord, scope: Scope.Closeable): Effect.Effect<void> =>
    Effect.suspend(() =>
      withLock(
        Effect.sync(() =>
          record.scope !== scope ? "stale" : record.initializationPending ? "waiting" : "close",
        ),
      ).pipe(
        Effect.flatMap((ownership) =>
          ownership === "close"
            ? closeRecordScope(record, scope)
            : ownership === "waiting"
              ? Effect.sleep("25 millis").pipe(Effect.andThen(closeExitedScope(record, scope)))
              : Effect.void,
        ),
        Effect.asVoid,
      ),
    );

  let rpc: <A extends RpcCommand>(
    record: RunRecord,
    command: A,
  ) => Effect.Effect<RpcResponse, SubagentError>;
  let sendPeerNotices: (changedId: string) => Effect.Effect<void>;
  let initializeProcess: (
    record: RunRecord,
    retriesRemaining: number,
    claudeBootstrapPrompt: string | undefined,
    operation: "start" | "resume",
  ) => Effect.Effect<RpcStateData, SubagentError>;

  const settle = (record: RunRecord, state: "completed" | "failed" | "stopped", error?: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* withLock(
        Effect.sync(() => {
          if (
            isTerminalRunState(record.view.state) ||
            (state !== "stopped" && (record.stoppedByParent || record.view.state === "stopping"))
          )
            return { transitioned: false as const, view: snapshotView(record.view) };
          if (record.initializationPending && state !== "stopped") {
            record.pendingInitializationSettlement = {
              state,
              ...(error ? { error } : {}),
            };
            return {
              transitioned: false as const,
              deferredInitialization: true as const,
              view: snapshotView(record.view),
            };
          }
          const settlement = record.settlement;
          const pauseOutcome = record.pauseOutcome;
          const completedScope =
            state === "completed" && record.process !== undefined ? record.scope : undefined;
          if (completedScope) record.cleanupPending = true;
          record.pauseOutcome = undefined;
          record.pauseRequested = false;
          record.activeTools.clear();
          const completionGeneration =
            state === "completed" ? ++record.completionGeneration : record.completionGeneration;
          const turnWarning = record.rateLimitWarning;
          const rejectedWindows = [
            ...new Map(
              [...record.rateLimitSettlements.values()]
                .filter(
                  (settlement) => settlement.turn === record.rateLimitTurn && settlement.rejected,
                )
                .map((settlement) => [settlement.windowKey, settlement] as const),
            ).values(),
          ];
          const pendingRejectionKeys = new Set<string>();
          for (const [slot, notification] of pendingActionNotifications) {
            if (notification.id !== record.view.id || notification.type !== "warning") continue;
            const rejectionKey = notification.rateLimitRejectionKey;
            const preserve =
              rejectionKey !== undefined &&
              rejectedWindows.some((window) => window.windowKey === rejectionKey) &&
              !record.deliveredRateLimitRejections.has(rejectionKey);
            if (preserve) {
              pendingRejectionKeys.add(rejectionKey);
              continue;
            }
            pendingActionNotifications.delete(slot);
            record.warningNotificationGenerations.delete(slot);
          }
          const missingRateLimitNotifications = rejectedWindows.filter(
            (window) =>
              !record.deliveredRateLimitRejections.has(window.windowKey) &&
              !pendingRejectionKeys.has(window.windowKey),
          );
          record.rateLimitRejected = false;
          record.rateLimitWarning = undefined;
          record.rateLimitWarnings.clear();
          record.rateLimitSettlements.clear();
          record.notificationGeneration += 1;
          record.questionNotificationGeneration = record.notificationGeneration;
          pendingActionNotifications.delete(`${record.view.id}:question:default`);
          record.replyPendingRequestId = undefined;
          record.view = {
            ...record.view,
            ...(turnWarning && record.view.warning === turnWarning ? { warning: undefined } : {}),
            state,
            endedAt: now,
            lastActivityAt: now,
            currentTool: undefined,
            question: undefined,
            ...(state === "completed" && record.latestAssistantText
              ? { finalText: record.latestAssistantText }
              : {}),
            ...(error ? { error } : {}),
          };
          publish();
          return {
            transitioned: true as const,
            view: snapshotView(record.view),
            settlement,
            pauseOutcome,
            completedScope,
            completionGeneration,
            rejectedRateLimitWindows: rejectedWindows,
            missingRateLimitNotifications,
          };
        }),
      );
      const view = result.view;
      if (!result.transitioned) return view;
      Deferred.doneUnsafe(result.settlement, Effect.succeed(view));
      if (result.pauseOutcome) Deferred.doneUnsafe(result.pauseOutcome, Effect.succeed(view));
      const deliveredToForeground = deliverForeground(record, view);
      const evicted = yield* withLock(
        Effect.sync(() => {
          if (records.size <= MAX_RETAINED_RUNS) return [] as RunRecord[];
          const candidates = [...records.values()]
            .filter(
              (candidate) =>
                candidate !== record &&
                !candidate.cleanupPending &&
                candidate.completionClaims === 0 &&
                !(
                  candidate.view.state === "completed" &&
                  candidate.completionConsumedGeneration < candidate.completionGeneration &&
                  candidate.completionNotifiedGeneration < candidate.completionGeneration
                ) &&
                (candidate.view.state === "completed" ||
                  candidate.view.state === "stopped" ||
                  candidate.view.state === "failed"),
            )
            .sort(
              (left, right) =>
                (left.view.endedAt ?? left.view.startedAt) -
                (right.view.endedAt ?? right.view.startedAt),
            );
          const removed: RunRecord[] = [];
          while (records.size > MAX_RETAINED_RUNS && candidates.length > 0) {
            const candidate = candidates.shift();
            if (!candidate) break;
            records.delete(candidate.view.id);
            removed.push(candidate);
          }
          if (removed.length > 0) publish();
          return removed;
        }),
      );
      yield* Effect.forEach(evicted, (candidate) => Scope.close(candidate.scope, Exit.void), {
        concurrency: 8,
        discard: true,
      });
      if (state === "completed") {
        if (!deliveredToForeground) yield* queueCompletion(record, result.completionGeneration);
      } else if (!deliveredToForeground && state === "failed") {
        if (result.rejectedRateLimitWindows.length === 0)
          yield* queueActionNotification(record, {
            type: "warning",
            id: view.id,
            name: view.name,
            message: error ?? "Run failed.",
            triggerTurn: true,
          });
        else
          yield* Effect.forEach(
            result.missingRateLimitNotifications,
            (window) =>
              queueActionNotification(record, {
                type: "warning",
                id: view.id,
                name: view.name,
                message: window.message ?? error ?? "Claude request was rate limited.",
                triggerTurn: true,
                slotKey: `rate-limit:${window.windowKey}`,
                rateLimitRejectionKey: window.windowKey,
              }),
            { discard: true },
          );
      }
      yield* sendPeerNotices(record.view.id);
      if (result.completedScope)
        yield* closeRecordScope(record, result.completedScope).pipe(
          Effect.forkIn(ownerScope, { startImmediately: true }),
          Effect.asVoid,
        );
      return view;
    });

  const failRun = (record: RunRecord, message: string, pendingError?: SubagentError) => {
    const diagnostic = sanitizeDiagnosticText(message, MAX_ERROR_CHARS);
    return withLock(
      Effect.sync(() => {
        if (
          record.stoppedByParent ||
          record.view.state === "stopping" ||
          isTerminalRunState(record.view.state)
        )
          return false;
        record.cleanupPending = true;
        failPendingResponses(
          record,
          pendingError ?? new SubagentProcessError({ operation: "run", message: diagnostic }),
        );
        return true;
      }),
    ).pipe(
      Effect.flatMap((shouldFail) => {
        if (!shouldFail) return Effect.succeed(snapshotView(record.view));
        if (record.initializationPending) return settle(record, "failed", diagnostic);
        return (
          record.process
            ? record.process.terminate("force").pipe(Effect.catch(() => Effect.void))
            : Effect.void
        ).pipe(Effect.andThen(settle(record, "failed", diagnostic)));
      }),
    );
  };

  const handleRateLimit = (record: RunRecord, event: ChildRateLimitEvent) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const message = event.status === "allowed" ? undefined : rateLimitMessage(event, now);
      const rejected = isRejectedRateLimit(event);
      const windowKey = rateLimitWindowKey(event);
      const update = yield* withLock(
        Effect.sync(() => {
          const limitKey = event.rateLimitType ?? "usage";
          const priorSettlement = record.rateLimitSettlements.get(limitKey);
          const generation =
            priorSettlement?.turn === record.rateLimitTurn ? priorSettlement.generation + 1 : 1;
          record.rateLimitSettlements.set(limitKey, {
            turn: record.rateLimitTurn,
            generation,
            rejected,
            windowKey,
            ...(message ? { message } : {}),
          });
          record.rateLimitRejected = [...record.rateLimitSettlements.values()].some(
            (settlement) => settlement.turn === record.rateLimitTurn && settlement.rejected,
          );
          if (
            record.stoppedByParent ||
            record.view.state === "stopping" ||
            isTerminalRunState(record.view.state)
          )
            return { limitKey, turn: record.rateLimitTurn, generation, notifyParent: false };

          const { notice, notifyParent } = advanceRateLimitNotice(
            record.rateLimitNotices.get(limitKey),
            event,
          );
          record.rateLimitNotices.set(limitKey, notice);

          if (!message) {
            record.rateLimitWarnings.delete(limitKey);
            const replacement = [...record.rateLimitWarnings.values()].at(-1);
            const priorWarning = record.rateLimitWarning;
            record.rateLimitWarning = replacement;
            if (priorWarning && record.view.warning === priorWarning) {
              record.view = { ...record.view, warning: replacement };
              publish();
            }
            return { limitKey, turn: record.rateLimitTurn, generation, notifyParent: false };
          }
          const duplicate = record.view.warning === message;
          record.rateLimitWarnings.delete(limitKey);
          record.rateLimitWarnings.set(limitKey, message);
          record.rateLimitWarning = message;
          record.view = {
            ...record.view,
            warning: message,
            lastActivityAt: now,
            sessionEvents:
              notifyParent && !duplicate
                ? appendNoticeSessionEvent(record.view.sessionEvents, "warning", message, now)
                : record.view.sessionEvents,
          };
          publish();
          return { limitKey, turn: record.rateLimitTurn, generation, notifyParent };
        }),
      );
      if (event.status === "allowed" || !message) return;
      if (!rejected) {
        if (update.notifyParent)
          yield* queueActionNotification(record, {
            type: "warning",
            id: record.view.id,
            name: record.view.name,
            message,
            triggerTurn: false,
            slotKey: `rate-limit:${windowKey}`,
          });
        return;
      }
      if (update.notifyParent) {
        yield* queueActionNotification(record, {
          type: "warning",
          id: record.view.id,
          name: record.view.name,
          message,
          triggerTurn: true,
          slotKey: `rate-limit:${windowKey}`,
          rateLimitRejectionKey: windowKey,
        });
      }
      yield* Effect.sleep(CLAUDE_RATE_LIMIT_RESULT_GRACE).pipe(
        Effect.andThen(
          withLock(
            Effect.sync(() => {
              const settlement = record.rateLimitSettlements.get(update.limitKey);
              return (
                settlement?.turn === update.turn &&
                settlement.generation === update.generation &&
                settlement.rejected &&
                !record.stoppedByParent &&
                record.view.state !== "stopping" &&
                !isTerminalRunState(record.view.state)
              );
            }),
          ),
        ),
        Effect.flatMap((stillRejected) =>
          stillRejected ? failRun(record, message).pipe(Effect.asVoid) : Effect.void,
        ),
        Effect.forkIn(record.scope, { startImmediately: true }),
        Effect.asVoid,
      );
    });

  const handleWireEvent = makeRunEventHandler({
    mutateView: mutateEventView,
    settle,
    notify: queueActionNotification,
    failPendingResponses,
    failRun,
    deliverForeground,
    pauseFromEvent,
    handleRateLimit,
  });

  ({ rpc, sendPeerNotices, initializeProcess } = makeRunProcessLifecycle({
    childProcesses,
    ownerScope,
    records,
    withLock,
    publish,
    handleWireEvent,
    markCleanupPending,
    closeRecordScope,
    closeExitedScope,
    failRun,
  }));

  const start: SubagentServiceShape["start"] = (request) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!request.task.trim())
          return yield* new InvalidSubagentRequestError({ message: "Subagent task is required." });
        if (request.backend === "claude-cli" && !request.projectTrusted)
          return yield* new InvalidSubagentRequestError({
            code: "claude_untrusted",
            message: "Claude CLI subagents require a trusted project.",
          });
        if (request.backend === "claude-cli" && request.context === "fork")
          return yield* new InvalidSubagentRequestError({
            code: "claude_context_unsupported",
            message: "Claude CLI does not support forked Pi context yet.",
          });
        if (request.backend === "claude-cli" && !isClaudeModelSelector(request.model))
          return yield* new InvalidSubagentRequestError({
            code: "claude_model_invalid",
            message:
              'Claude model must be fable, sonnet, opus, haiku, or a full model ID beginning with "claude" (at most 128 characters).',
          });
        if (
          request.backend === "claude-cli" &&
          request.effortWasExplicit &&
          (request.effort === "off" || request.effort === "minimal")
        )
          return yield* new InvalidSubagentRequestError({
            code: "claude_effort_unsupported",
            message: `Claude CLI does not support effort ${request.effort}.`,
          });
        if (request.task.length > MAX_TASK_CHARS)
          return yield* new InvalidSubagentRequestError({ message: "Subagent task is too large." });
        if (profileService.policyFor(request.backend, request.model) === "denied")
          return yield* new InvalidSubagentRequestError({
            code: "model_denied",
            message: `Model ${request.backend}/${request.model} is denied by Subagents policy and cannot be started.`,
          });
        const requestedName = sanitizeName(request.name ?? "");
        const now = yield* Clock.currentTimeMillis;
        const scope = yield* Scope.fork(ownerScope);
        const settlement = yield* Deferred.make<SubagentRunView>();
        const foregroundOutcome = yield* Deferred.make<SubagentRunView>();
        const reserved = yield* withLock(
          Effect.gen(function* () {
            if (closed)
              return yield* new SubagentRuntimeClosedError({
                message: "The subagent session runtime is closed.",
              });
            const retainedProcesses = [...records.values()].filter(ownsProcessSlot).length;
            if (retainedProcesses >= MAX_CONCURRENT_RUNS) {
              const cleanupCount = [...records.values()].filter(
                (record) => record.cleanupPending,
              ).length;
              return yield* new SubagentCapacityError({
                limit: MAX_CONCURRENT_RUNS,
                message:
                  cleanupCount > 0
                    ? `Subagent capacity is temporarily occupied while ${cleanupCount} run${cleanupCount === 1 ? "" : "s"} finish cleanup; retry shortly.`
                    : `Subagent capacity reached (${MAX_CONCURRENT_RUNS}). Stop an active run first.`,
              });
            }
            if (request.writeIntent === "writer") {
              const activeWriter = [...records.values()].find(ownsWriterSlot);
              if (activeWriter)
                return yield* new SubagentWriterConflictError({
                  activeId: activeWriter.view.id,
                  activeName: activeWriter.view.name,
                  message: `Writer ${activeWriter.view.name} (${activeWriter.view.id}) already owns the shared cwd.`,
                });
            }
            const ordinal = nextRunOrdinal++;
            const id = `agent-${runtimeNamespace}-${ordinal}`;
            const name = requestedName || `subagent-${ordinal}`;
            const view: SubagentRunView = {
              id,
              name,
              task: request.task.trim(),
              ...(request.profile ? { profile: request.profile } : {}),
              selection: request.selection ?? {
                source: "explicit",
                reason: "Explicit backend/model selection.",
                skippedCandidates: [],
              },
              cwd: request.cwd,
              state: "starting",
              execution: request.execution,
              context: request.context,
              writeIntent: request.writeIntent,
              backend: request.backend,
              capabilities: capabilitiesFor(request),
              model: request.model,
              effort: request.effort,
              startedAt: now,
              lastActivityAt: now,
              sessionEvents: [],
              usage: emptyUsage(),
            };
            const launch: ChildLaunchRequest = {
              runId: id,
              name,
              backend: request.backend,
              cwd: request.cwd,
              context: request.context,
              writeIntent: request.writeIntent,
              model: request.model,
              effort: request.effort,
              ...(request.runtimeApiKey ? { runtimeApiKey: request.runtimeApiKey } : {}),
              activeTools: request.activeTools,
              projectTrusted: request.projectTrusted,
              parentSessionId: request.parentSessionId,
              ...(request.parentSessionFile
                ? { parentSessionFile: request.parentSessionFile }
                : {}),
              ...(request.parentLeafId ? { parentLeafId: request.parentLeafId } : {}),
              systemPrompt: childSystemPrompt(request),
            };
            const record: RunRecord = {
              view,
              scope,
              launch,
              responses: new Map(),
              activeTools: new Map(),
              nextRpcId: 1,
              settlement,
              foregroundOutcome,
              foregroundWaitPending: request.execution === "foreground",
              pauseRequested: false,
              stoppedByParent: false,
              cleanupPending: false,
              initializationPending: true,
              taskSubmission: "not-sent",
              warningTurnTriggered: false,
              notificationGeneration: 0,
              questionNotificationGeneration: 0,
              warningNotificationGenerations: new Map(),
              completionGeneration: 0,
              completionConsumedGeneration: 0,
              completionNotifiedGeneration: 0,
              completionClaims: 0,
              rateLimitTurn: 1,
              rateLimitRejected: false,
              rateLimitWarnings: new Map(),
              rateLimitSettlements: new Map(),
              rateLimitNotices: new Map(),
              deliveredRateLimitRejections: new Set(),
            };
            records.set(id, record);
            publish();
            return record;
          }),
        ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));

        const peerNotice = peerNoticeText(records.values(), reserved.view.id);
        const initialPrompt = taskPrompt(request, peerNotice);
        const initialize = Effect.gen(function* () {
          const state = yield* initializeProcess(
            reserved,
            1,
            request.backend === "claude-cli" ? initialPrompt : undefined,
            "start",
          );
          // Let a terminal frame already queued behind the initialization state
          // commit its deferred settlement before this start result is returned.
          yield* Effect.yieldNow;
          if (
            request.backend === "pi" &&
            request.effortWasExplicit &&
            state.thinkingLevel !== request.effort
          )
            return yield* new InvalidSubagentRequestError({
              code: "pi_effort_unsupported",
              message: `Model ${request.model} does not support requested effort ${request.effort}; effective level was ${state.thinkingLevel}.`,
            });
          const resolvedModel = rpcStateModelId(state.model) ?? reserved.view.model;
          const startedAt = yield* Clock.currentTimeMillis;
          const activated = yield* withLock(
            Effect.sync(() => {
              if (
                reserved.stoppedByParent ||
                reserved.view.state === "stopping" ||
                reserved.view.state === "stopped"
              )
                return undefined;
              reserved.initializationPending = false;
              const pendingSettlement = reserved.pendingInitializationSettlement;
              reserved.pendingInitializationSettlement = undefined;
              reserved.view = {
                ...reserved.view,
                ...(pendingSettlement ? {} : { state: "running" as const }),
                effort: state.thinkingLevel as StartSubagentRequest["effort"],
                model: resolvedModel,
                lastActivityAt: startedAt,
                sessionId: state.sessionId,
                ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
              };
              publish();
              return {
                view: snapshotView(reserved.view),
                pendingSettlement,
              };
            }),
          );
          if (!activated)
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${reserved.view.id} was stopped during startup.`,
            });
          if (activated.pendingSettlement) {
            const pending = activated.pendingSettlement;
            if (pending.state === "failed")
              return yield* failRun(
                reserved,
                pending.error ?? "Subagent failed during startup.",
              ).pipe(Effect.tap(() => closeRecordScope(reserved)));
            return yield* settle(reserved, pending.state, pending.error);
          }
          if (request.backend === "pi") {
            const submit = rpc(reserved, { type: "prompt", message: initialPrompt }).pipe(
              Effect.tap(() =>
                withLock(
                  Effect.sync(() => {
                    reserved.taskSubmission = "potentially-applied";
                  }),
                ),
              ),
              Effect.tapError((error) =>
                error._tag === "SubagentProcessError" && error.code === "transport_not_sent"
                  ? Effect.void
                  : withLock(
                      Effect.sync(() => {
                        reserved.taskSubmission = "potentially-applied";
                      }),
                    ),
              ),
              Effect.mapError((error) =>
                reserved.view.writeIntent === "writer" &&
                reserved.taskSubmission === "potentially-applied" &&
                error._tag === "SubagentProcessError" &&
                error.code?.endsWith("_outcome_uncertain")
                  ? new SubagentProcessError({
                      operation: "start",
                      code: "start_outcome_uncertain",
                      message: `The writer task may have been accepted, but startup could not confirm the outcome. Inspect the workspace and subagent status before starting another writer. (${error.message})`,
                    })
                  : error,
              ),
            );
            yield* submit;
          }
          yield* sendPeerNotices(reserved.view.id);
          return activated.view;
        });

        return yield* restore(initialize).pipe(
          Effect.onError((cause) =>
            Effect.gen(function* () {
              const interruptedOnly =
                cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason);
              yield* withLock(
                Effect.sync(() => {
                  reserved.initializationPending = false;
                  reserved.pendingInitializationSettlement = undefined;
                }),
              );
              yield* markCleanupPending(reserved);
              if (!reserved.stoppedByParent) {
                if (interruptedOnly) yield* settle(reserved, "stopped");
                else
                  yield* settle(
                    reserved,
                    "failed",
                    sanitizeDiagnosticText(Cause.pretty(cause), MAX_ERROR_CHARS),
                  );
              }
              yield* closeRecordScope(reserved);
            }),
          ),
        );
      }),
    );

  const startSessionOwned: SubagentServiceShape["startSessionOwned"] = (request) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const outcome = yield* Deferred.make<SubagentRunView, SubagentError>();
        yield* start(request).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(outcome, exit)),
          Effect.forkIn(ownerScope, { startImmediately: true }),
        );
        return yield* restore(Deferred.await(outcome));
      }),
    );

  const observeRecord = (record: RunRecord): SubagentRunObservation => ({
    run: snapshotView(record.view),
    ...(record.view.state === "completed"
      ? {
          completionReceipt: {
            id: record.view.id,
            generation: record.completionGeneration,
          },
        }
      : {}),
  });
  const awaitForegroundObservation = (record: RunRecord) =>
    Deferred.await(record.foregroundOutcome).pipe(
      Effect.andThen(withLock(Effect.sync(() => observeRecord(record)))),
    );
  const releaseForegroundObservation = (record: RunRecord, rendered: boolean) =>
    withLock(
      Effect.sync(() => {
        record.foregroundWaitPending = false;
        const generation = record.foregroundCompletionClaimGeneration;
        if (generation !== undefined) {
          record.foregroundCompletionClaimGeneration = undefined;
          record.completionClaims = Math.max(0, record.completionClaims - 1);
          queuePendingCompletion(pendingCompletions, record, generation);
        }
        if (rendered) return undefined;
        const view = record.view;
        if (view.state === "waiting_for_parent" && view.question)
          return {
            type: "question" as const,
            id: view.id,
            name: view.name,
            requestId: view.question.requestId,
            message: view.question.message,
          };
        if (view.state === "failed")
          return {
            type: "warning" as const,
            id: view.id,
            name: view.name,
            message: view.error ?? "Run failed.",
            triggerTurn: true,
          };
        return undefined;
      }),
    ).pipe(
      Effect.flatMap((notification) =>
        scheduleCompletionFlush.pipe(
          Effect.andThen(
            notification ? queueActionNotification(record, notification) : Effect.void,
          ),
        ),
      ),
    );
  const acquireForegroundRecord = (id: string) =>
    withLock(Effect.map(requireRecord(id), (record) => ({ record })));
  const withForegroundObservation: SubagentServiceShape["withForegroundObservation"] = (id, use) =>
    Effect.acquireUseRelease(
      acquireForegroundRecord(id),
      ({ record }) => awaitForegroundObservation(record).pipe(Effect.flatMap(use)),
      ({ record }, exit) => releaseForegroundObservation(record, Exit.isSuccess(exit)),
    );
  const withForegroundStartObservation: SubagentServiceShape["withForegroundStartObservation"] = (
    request,
    use,
  ) => {
    if (request.execution !== "foreground")
      return Effect.fail(
        new InvalidSubagentRequestError({
          message: "Atomic foreground start observation requires execution=foreground.",
        }),
      );
    return Effect.acquireUseRelease(
      start(request).pipe(
        Effect.flatMap((started) =>
          acquireForegroundRecord(started.id).pipe(
            Effect.map(({ record }) => ({ record, started })),
          ),
        ),
      ),
      ({ record, started }) => use(started, awaitForegroundObservation(record)),
      ({ record }, exit) => releaseForegroundObservation(record, Exit.isSuccess(exit)),
    );
  };
  const waitForForeground: SubagentServiceShape["waitForForeground"] = (id) =>
    withForegroundObservation(id, (observation) => Effect.succeed(observation.run));

  const consumeCompletions: SubagentServiceShape["consumeCompletions"] = (receipts) =>
    withLock(
      Effect.sync(() => {
        for (const receipt of receipts) {
          const record = records.get(receipt.id);
          if (
            !record ||
            record.view.state !== "completed" ||
            record.completionGeneration !== receipt.generation
          )
            continue;
          record.completionConsumedGeneration = Math.max(
            record.completionConsumedGeneration,
            receipt.generation,
          );
          if (pendingCompletions.get(record.view.id) === receipt.generation)
            pendingCompletions.delete(record.view.id);
        }
      }),
    );

  interface CompletionClaim {
    readonly selected: ReadonlyArray<RunRecord>;
    readonly claimed: ReadonlyArray<RunRecord>;
    readonly missingIds: ReadonlyArray<string>;
  }
  const acquireCompletionClaims = (
    ids: ReadonlyArray<string>,
    claimAll: boolean,
    allowMissing = false,
  ) =>
    withCompletionGate(
      withLock(
        Effect.gen(function* () {
          const selected = ids.flatMap((id) => {
            const record = records.get(id);
            return record ? [record] : [];
          });
          const missingIds = ids.filter((id) => !records.has(id));
          if (!allowMissing && missingIds.length > 0)
            return yield* new InvalidSubagentRequestError({
              code: "subagent_runs_not_found",
              message: `Subagent runs not found: ${missingIds.join(", ")}. Use subagent_list to refresh active run IDs.`,
            });
          const claimed = claimAll
            ? selected
            : selected.filter((record) => record.view.state === "completed");
          for (const record of claimed) {
            record.completionClaims += 1;
            pendingCompletions.delete(record.view.id);
          }
          return { selected, claimed, missingIds } satisfies CompletionClaim;
        }),
      ),
    );
  const releaseCompletionClaims = (claim: CompletionClaim) =>
    withLock(
      Effect.sync(() => {
        for (const record of claim.claimed) {
          record.completionClaims = Math.max(0, record.completionClaims - 1);
          queuePendingCompletion(pendingCompletions, record, record.completionGeneration);
        }
      }),
    ).pipe(Effect.andThen(scheduleCompletionFlush));
  const waitForTerminalObservations = (
    selected: ReadonlyArray<RunRecord>,
    until: SubagentAwaitUntil,
    onUpdate?: (runs: ReadonlyArray<SubagentRunView>) => void,
  ): Effect.Effect<ReadonlyArray<SubagentRunObservation>> => {
    const emitUpdate = (runs: ReadonlyArray<SubagentRunView>) =>
      Effect.sync(() => {
        try {
          onUpdate?.(runs);
        } catch {
          // Pi partial-result delivery is best effort and cannot own the waiter.
        }
      });
    const waitLoop = (): Effect.Effect<ReadonlyArray<SubagentRunObservation>> =>
      Effect.suspend(() =>
        withLock(
          Effect.gen(function* () {
            const observations = selected.map(observeRecord);
            const runs = observations.map((observation) => observation.run);
            const terminalCount = runs.filter((run) => isTerminalRunState(run.state)).length;
            const parentAttentionRequired = runs.some(
              (run) => run.state === "waiting_for_parent" && run.question !== undefined,
            );
            const done =
              parentAttentionRequired ||
              (until === "any_finished" ? terminalCount > 0 : terminalCount === runs.length);
            if (done) return { done: true as const, runs, observations };
            const wake = yield* Deferred.make<void>();
            revisionWaiters.add(wake);
            return { done: false as const, runs, wake };
          }),
        ).pipe(
          Effect.tap(({ runs }) => emitUpdate(runs)),
          Effect.flatMap((step) =>
            step.done
              ? Effect.succeed(step.observations)
              : Deferred.await(step.wake).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      revisionWaiters.delete(step.wake);
                    }),
                  ),
                  Effect.andThen(waitLoop()),
                ),
          ),
        ),
      );
    return waitLoop();
  };
  const withAwaitTerminalObservations: SubagentServiceShape["withAwaitTerminalObservations"] = (
    ids,
    until,
    onUpdate,
    use,
  ) => {
    if (ids.length === 0)
      return Effect.fail(
        new InvalidSubagentRequestError({
          message: "Await requires at least one subagent run ID.",
        }),
      );
    return Effect.acquireUseRelease(
      acquireCompletionClaims(ids, true),
      (claim) =>
        waitForTerminalObservations(claim.selected, until, onUpdate).pipe(Effect.flatMap(use)),
      releaseCompletionClaims,
    );
  };
  const awaitTerminalObserved = (
    ids: ReadonlyArray<string>,
    until: SubagentAwaitUntil,
    onUpdate?: (runs: ReadonlyArray<SubagentRunView>) => void,
  ): Effect.Effect<ReadonlyArray<SubagentRunObservation>, SubagentError> =>
    withAwaitTerminalObservations(ids, until, onUpdate, Effect.succeed);
  const withStatusObservations: SubagentServiceShape["withStatusObservations"] = (ids, use) =>
    Effect.acquireUseRelease(
      acquireCompletionClaims(ids, false, true),
      (claim) =>
        use({
          observations: claim.selected.map(observeRecord),
          missingIds: claim.missingIds,
        }),
      releaseCompletionClaims,
    );

  const awaitTerminal: SubagentServiceShape["awaitTerminal"] = (ids, until, onUpdate) =>
    awaitTerminalObserved(ids, until, onUpdate).pipe(
      Effect.tap((observations) =>
        consumeCompletions(
          observations.flatMap((observation) =>
            observation.completionReceipt ? [observation.completionReceipt] : [],
          ),
        ),
      ),
      Effect.map((observations) => observations.map((observation) => observation.run)),
    );

  const list = withLock(
    Effect.sync(() => sortRuns([...records.values()].map((record) => snapshotView(record.view)))),
  );
  const observeStatus = (
    id: string,
  ): Effect.Effect<SubagentRunObservation, SubagentNotFoundError> =>
    withLock(Effect.map(requireRecord(id), observeRecord));
  const status: SubagentServiceShape["status"] = (id) =>
    observeStatus(id).pipe(
      Effect.tap((observation) =>
        observation.completionReceipt
          ? consumeCompletions([observation.completionReceipt])
          : Effect.void,
      ),
      Effect.map((observation) => observation.run),
    );

  const waitForRunCleanup: (id: string) => Effect.Effect<void, SubagentNotFoundError> = (id) =>
    withLock(
      Effect.gen(function* () {
        const record = yield* requireRecord(id);
        return record.cleanupPending;
      }),
    ).pipe(
      Effect.flatMap((cleanupPending) =>
        cleanupPending
          ? Effect.sleep("25 millis").pipe(Effect.andThen(waitForRunCleanup(id)))
          : Effect.void,
      ),
    );

  const waitForRunCleanupBounded = (
    id: string,
  ): Effect.Effect<void, SubagentNotFoundError | SubagentProcessError> =>
    waitForRunCleanup(id).pipe(
      Effect.timeoutOption("10 seconds"),
      Effect.flatMap((outcome) =>
        Option.isSome(outcome)
          ? Effect.void
          : Effect.fail(
              new SubagentProcessError({
                operation: "resume",
                code: "cleanup_timeout",
                message: `Subagent ${id} cleanup did not finish within 10 seconds; inspect with subagent_status before retrying resume.`,
              }),
            ),
      ),
    );

  const resume: SubagentServiceShape["resume"] = (id, message) =>
    waitForRunCleanupBounded(id).pipe(
      Effect.andThen(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const prompt = message?.trim()
              ? yield* validateParentMessage(message, "Resume message is required.")
              : "Continue the assigned task from the current session state.";
            const nextSettlement = yield* Deferred.make<SubagentRunView>();
            const now = yield* Clock.currentTimeMillis;
            const claimed = yield* withLock(
              Effect.gen(function* () {
                const selected = yield* requireRecord(id);
                yield* requireCapability(selected, "resume");
                if (selected.view.state !== "paused" && selected.view.state !== "completed")
                  return yield* new InvalidSubagentRequestError({
                    message: `Subagent ${id} cannot resume while ${selected.view.state}.`,
                  });
                if (selected.view.writeIntent === "writer") {
                  const activeWriter = [...records.values()].find(
                    (candidate) => candidate !== selected && ownsWriterSlot(candidate),
                  );
                  if (activeWriter)
                    return yield* new SubagentWriterConflictError({
                      activeId: activeWriter.view.id,
                      activeName: activeWriter.view.name,
                      message: `Writer ${activeWriter.view.name} (${activeWriter.view.id}) already owns the shared cwd.`,
                    });
                }
                const needsRespawn = selected.process === undefined;
                if (needsRespawn) {
                  const retainedProcesses = [...records.values()].filter(
                    (candidate) => candidate !== selected && ownsProcessSlot(candidate),
                  ).length;
                  if (retainedProcesses >= MAX_CONCURRENT_RUNS) {
                    const cleanupCount = [...records.values()].filter(
                      (record) => record.cleanupPending,
                    ).length;
                    return yield* new SubagentCapacityError({
                      limit: MAX_CONCURRENT_RUNS,
                      message:
                        cleanupCount > 0
                          ? `Subagent capacity is temporarily occupied while ${cleanupCount} run${cleanupCount === 1 ? "" : "s"} finish cleanup; retry shortly.`
                          : `Subagent capacity reached (${MAX_CONCURRENT_RUNS}). Stop an active run first.`,
                    });
                  }
                  if (selected.view.backend === "pi" && !selected.view.sessionFile)
                    return yield* new InvalidSubagentRequestError({
                      message: `Subagent ${id} cannot resume because its Pi session file is unavailable.`,
                    });
                  if (selected.view.backend === "claude-cli" && !selected.view.sessionId)
                    return yield* new InvalidSubagentRequestError({
                      message: `Subagent ${id} cannot resume because its Claude session ID is unavailable.`,
                    });
                }
                selected.settlement = nextSettlement;
                selected.pauseRequested = false;
                selected.pauseOutcome = undefined;
                selected.activeTools.clear();
                selected.warningTurnTriggered = false;
                selected.notificationGeneration += 1;
                selected.questionNotificationGeneration = selected.notificationGeneration;
                selected.warningNotificationGenerations.clear();
                for (const [slot, notification] of pendingActionNotifications)
                  if (notification.id === selected.view.id) pendingActionNotifications.delete(slot);
                selected.replyPendingRequestId = undefined;
                selected.initializationPending = needsRespawn;
                selected.pendingInitializationSettlement = undefined;
                selected.taskSubmission = "not-sent";
                selected.rateLimitTurn += 1;
                selected.rateLimitRejected = false;
                selected.rateLimitSettlements.clear();
                selected.rateLimitWarnings.clear();
                const warning =
                  selected.rateLimitWarning && selected.view.warning === selected.rateLimitWarning
                    ? undefined
                    : selected.view.warning;
                selected.rateLimitWarning = undefined;
                selected.view = {
                  ...selected.view,
                  state: "starting",
                  question: undefined,
                  currentTool: undefined,
                  warning,
                  lastActivityAt: now,
                };
                publish();
                return { record: selected, needsRespawn };
              }),
            );
            const commit = Effect.gen(function* () {
              const record = claimed.record;
              let promptSubmittedDuringInitialization = false;
              if (claimed.needsRespawn) {
                const nextScope = yield* Scope.fork(ownerScope);
                const installed = yield* withLock(
                  Effect.sync(() => {
                    if (
                      record.stoppedByParent ||
                      record.view.state !== "starting" ||
                      record.process !== undefined
                    )
                      return false;
                    record.scope = nextScope;
                    record.cleanupPending = false;
                    record.launch = {
                      ...record.launch,
                      ...(record.view.backend === "pi"
                        ? {
                            resumeSessionFile: record.view.sessionFile,
                            resumeSessionId: undefined,
                          }
                        : {
                            resumeSessionFile: undefined,
                            resumeSessionId: record.view.sessionId,
                          }),
                    };
                    return true;
                  }),
                );
                if (!installed) {
                  yield* Scope.close(nextScope, Exit.void);
                  return yield* new InvalidSubagentRequestError({
                    message: `Subagent ${id} stopped before its session could be restored.`,
                  });
                }
                const claudeBootstrapPrompt =
                  record.view.backend === "claude-cli" ? prompt : undefined;
                const state = yield* initializeProcess(record, 1, claudeBootstrapPrompt, "resume");
                promptSubmittedDuringInitialization = claudeBootstrapPrompt !== undefined;
                const resolvedModel = rpcStateModelId(state.model) ?? record.view.model;
                const committed = yield* withLock(
                  Effect.sync(() => {
                    if (record.view.state !== "starting") return undefined;
                    record.initializationPending = false;
                    const pendingSettlement = record.pendingInitializationSettlement;
                    record.pendingInitializationSettlement = undefined;
                    record.view = {
                      ...record.view,
                      model: resolvedModel,
                      effort: state.thinkingLevel as StartSubagentRequest["effort"],
                      sessionId: state.sessionId,
                      ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
                    };
                    publish();
                    return pendingSettlement;
                  }),
                );
                if (committed) {
                  if (committed.state === "failed")
                    return yield* failRun(
                      record,
                      committed.error ?? "Subagent failed while resuming.",
                    ).pipe(Effect.tap(() => closeRecordScope(record)));
                  return yield* settle(record, committed.state, committed.error);
                }
              }
              if (!promptSubmittedDuringInitialization) {
                yield* rpc(claimed.record, { type: "prompt", message: prompt }).pipe(
                  Effect.tap(() =>
                    withLock(
                      Effect.sync(() => {
                        claimed.record.taskSubmission = "potentially-applied";
                      }),
                    ),
                  ),
                  Effect.tapError((error) =>
                    error._tag === "SubagentProcessError" && error.code === "transport_not_sent"
                      ? Effect.void
                      : withLock(
                          Effect.sync(() => {
                            claimed.record.taskSubmission = "potentially-applied";
                          }),
                        ),
                  ),
                  Effect.mapError((error) =>
                    error._tag === "SubagentProcessError" &&
                    error.code?.endsWith("_outcome_uncertain")
                      ? new SubagentProcessError({
                          operation: "resume",
                          code: "resume_outcome_uncertain",
                          message: `The resume prompt may already have applied. Inspect subagent status before retrying. (${error.message})`,
                        })
                      : error,
                  ),
                );
              }
              const view = yield* withLock(
                Effect.sync(() => {
                  const record = claimed.record;
                  if (isTerminalRunState(record.view.state)) return snapshotView(record.view);
                  if (record.view.state !== "starting") return snapshotView(record.view);
                  record.latestAssistantText = undefined;
                  record.view = {
                    ...record.view,
                    state: "running",
                    endedAt: undefined,
                    error: undefined,
                    finalText: undefined,
                    lastActivityAt: now,
                    sessionEvents: appendNoticeSessionEvent(
                      record.view.sessionEvents,
                      "parent",
                      `Resume: ${prompt}`,
                      now,
                    ),
                  };
                  publish();
                  return snapshotView(record.view);
                }),
              );
              if (view.state !== "running" && !isTerminalRunState(view.state))
                return yield* new SubagentProcessError({
                  operation: "resume",
                  message: view.error ?? `Subagent ${id} stopped before resume completed.`,
                });
              yield* sendPeerNotices(id);
              return view;
            }).pipe(
              Effect.tapError((error) =>
                error._tag === "SubagentProcessError" && error.code === "resume_outcome_uncertain"
                  ? withLock(
                      Effect.sync(() => {
                        const record = claimed.record;
                        record.initializationPending = false;
                        const pending = record.pendingInitializationSettlement;
                        record.pendingInitializationSettlement = undefined;
                        if (!pending && !isTerminalRunState(record.view.state)) {
                          record.view = { ...record.view, warning: error.message };
                          publish();
                        }
                        return pending;
                      }),
                    ).pipe(
                      Effect.flatMap((pending) =>
                        !pending
                          ? Effect.void
                          : pending.state === "failed"
                            ? failRun(
                                claimed.record,
                                pending.error ?? "Subagent failed while resuming.",
                              ).pipe(Effect.asVoid)
                            : settle(claimed.record, pending.state, pending.error).pipe(
                                Effect.asVoid,
                              ),
                      ),
                    )
                  : withLock(
                      Effect.sync(() => {
                        claimed.record.initializationPending = false;
                        claimed.record.pendingInitializationSettlement = undefined;
                      }),
                    ).pipe(
                      Effect.andThen(failRun(claimed.record, error.message)),
                      Effect.andThen(closeRecordScope(claimed.record)),
                      Effect.asVoid,
                    ),
              ),
            );
            const commitFiber = yield* commit.pipe(
              Effect.forkIn(ownerScope, { startImmediately: true }),
            );
            return yield* restore(Fiber.join(commitFiber));
          }),
        ),
      ),
    );

  const { send, reply, interrupt, rename, stop } = makeRunControls({
    ownerScope,
    withLock,
    requireRecord,
    requireCapability,
    rpc,
    publish,
    sendPeerNotices,
    deliverForeground,
    failPendingResponses,
    closeRecordScope,
    settle,
  });

  const projection = withLock(Effect.sync(() => freezeSnapshot(currentProjection())));

  const service: SubagentServiceShape = {
    start,
    startSessionOwned,
    withForegroundStartObservation,
    waitForForeground,
    withForegroundObservation,
    awaitTerminal,
    withAwaitTerminalObservations,
    list,
    status,
    withStatusObservations,
    consumeCompletions,
    send,
    reply,
    interrupt,
    resume,
    rename,
    stop,
    projection,
  };

  yield* Effect.addFinalizer(() =>
    withLock(
      Effect.sync(() => {
        closed = true;
      }),
    ).pipe(
      Effect.andThen(
        Effect.forEach(
          [...records.values()],
          (record) => {
            record.stoppedByParent = true;
            failPendingResponses(
              record,
              new SubagentRuntimeClosedError({ message: "Parent session shut down." }),
            );
            return Scope.close(record.scope, Exit.void);
          },
          { concurrency: 8, discard: true },
        ),
      ),
      Effect.asVoid,
    ),
  );

  return service;
});

export class SubagentService extends Context.Service<SubagentService, SubagentServiceShape>()(
  "pi-subagents/run/service/SubagentService",
) {
  static readonly layer = (options: SubagentServiceOptions = {}) =>
    Layer.effect(this, makeService(options));

  static override readonly use = <A, E>(
    f: (service: SubagentServiceShape) => Effect.Effect<A, E>,
  ) => Effect.flatMap(this, f);
}
