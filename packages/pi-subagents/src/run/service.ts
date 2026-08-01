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
import {
  MAX_BACKEND_REPORT_EVIDENCE_CHARS,
  MAX_BACKEND_REPORT_ID_CHARS,
  MAX_BACKEND_REPORT_TEXT_CHARS,
  type BackendLaunchRequest,
  type BackendReport,
  type BackendStartupState,
} from "../backend/model.ts";
import { SubagentBackendRegistry } from "../backend/service.ts";
import type {
  SubagentNotification,
  SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import {
  type CanonicalWriterCwd,
  type WriterLeaseConflictError,
  WriterLeaseService,
} from "../boundary/writer-lease.ts";
import {
  InvalidSubagentRequestError,
  SubagentCapacityError,
  type SubagentError,
  SubagentHistoryCapacityError,
  SubagentNotFoundError,
  SubagentProcessError,
  SubagentRuntimeClosedError,
  SubagentWriterConflictError,
  UnsupportedSafeWriterOwnershipError,
  UnsupportedSubagentCapabilityError,
} from "./errors.ts";
import {
  acknowledgePendingCompletions,
  claimCompletion,
  collectPendingCompletionNotifications,
  completionClaimOwner,
  deliveredCompletionKeys,
  queuePendingCompletion,
  releaseCompletionClaim,
  removePendingCompletion,
} from "./completion.ts";
import { makeRunControls } from "./control.ts";
import {
  childSystemPrompt,
  peerNoticeText,
  taskPrompt,
  validateParentMessage,
} from "./coordination.ts";
import { makeRunEventHandler } from "./events.ts";
import { isInactiveRunRecord, type RunRecord } from "./internal.ts";
import { makeRunProcessLifecycle } from "./process-lifecycle.ts";
import {
  COMPLETION_RETRY_INITIAL_MILLIS,
  COMPLETION_RETRY_MAX_MILLIS,
  MAX_CONCURRENT_RUNS,
  MAX_RETAINED_RUNS,
} from "./limits.ts";
import {
  emptyUsage,
  hasSubagentCapability,
  isActiveRunState,
  isAssignmentFinishedRunState,
  isTerminalRunState,
  type StartSubagentRequest,
  type SubagentCapability,
  type SubagentProjection,
  type SubagentRunView,
} from "./model.ts";
import { sortRuns } from "./projection.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import {
  MAX_ERROR_CHARS,
  MAX_TASK_CHARS,
  sanitizeDiagnosticText,
  sanitizeName,
  sanitizeOutputText,
  snapshotView,
} from "./state.ts";

let nextRuntimeNamespace = 1;
const allocateRuntimeNamespace = (): string => `r${(nextRuntimeNamespace++).toString(36)}`;

const ownsProcessSlot = (record: RunRecord): boolean =>
  record.cleanupPending || record.process !== undefined || record.view.state === "starting";

const ownsWriterSlot = (record: RunRecord): boolean =>
  record.view.writeIntent === "writer" &&
  (record.cleanupPending || isActiveRunState(record.view.state));

const processCapacityError = (
  records: ReadonlyMap<string, RunRecord>,
  excluded?: RunRecord,
): SubagentCapacityError | undefined => {
  const candidates = [...records.values()].filter((record) => record !== excluded);
  if (candidates.filter(ownsProcessSlot).length < MAX_CONCURRENT_RUNS) return undefined;
  const cleanupCount = candidates.filter((record) => record.cleanupPending).length;
  return new SubagentCapacityError({
    limit: MAX_CONCURRENT_RUNS,
    message:
      cleanupCount > 0
        ? `Subagent capacity is temporarily occupied while ${cleanupCount} run${cleanupCount === 1 ? "" : "s"} finish cleanup; retry shortly.`
        : `Subagent capacity reached (${MAX_CONCURRENT_RUNS}). Stop an active run first.`,
  });
};

const writerConflictError = (
  records: ReadonlyMap<string, RunRecord>,
  canonicalCwd: CanonicalWriterCwd,
  excluded?: RunRecord,
): SubagentWriterConflictError | undefined => {
  const activeWriter = [...records.values()].find(
    (record) =>
      record !== excluded &&
      ownsWriterSlot(record) &&
      record.canonicalWriterCwd?.digest === canonicalCwd.digest,
  );
  return activeWriter
    ? new SubagentWriterConflictError({
        activeId: activeWriter.view.id,
        activeName: activeWriter.view.name,
        message: activeWriter.cleanupPending
          ? `Writer ${activeWriter.view.name} (${activeWriter.view.id}) remains quarantined because cleanup could not be confirmed.`
          : `Writer ${activeWriter.view.name} (${activeWriter.view.id}) already owns the shared cwd.`,
      })
    : undefined;
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
  /** Capability proving ownership of this exact unresolved generation. */
  readonly claimToken: string;
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
const unsupportedCapabilityMessage = (
  backend: string,
  capability: SubagentCapability,
  id: string,
): string => {
  switch (capability) {
    case "steer":
      return `${backend} subagents do not support mid-turn guidance. Await with subagent_await({ runIds: ["${id}"], until: "all_finished" }), inspect with subagent_status({ runIds: ["${id}"] }), or stop with subagent_lifecycle({ action: "stop", runIds: ["${id}"] }).`;
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
          backend: `${record.view.host ?? "local"}/${record.view.runtime ?? record.view.backend}`,
          capability,
          message: unsupportedCapabilityMessage(
            `${record.view.host ?? "local"}/${record.view.runtime ?? record.view.backend}`,
            capability,
            record.view.id,
          ),
        }),
      );

const makeService = Effect.fn("SubagentService.make")(function* (options: SubagentServiceOptions) {
  const backendRegistry = yield* SubagentBackendRegistry;
  const writerLeases = yield* WriterLeaseService;
  const ownerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const completionGate = yield* Semaphore.make(1);
  const records = new Map<string, RunRecord>();
  const revisionWaiters = new Set<Deferred.Deferred<void>>();
  const pendingCompletions = new Map<
    string,
    { readonly id: string; readonly generation: number }
  >();
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
  let nextClaimOrdinal = 1;
  let nextAssignmentAttemptOrdinal = 1;
  let revision = 0;
  let closed = false;

  const withLock = lock.withPermits(1);
  const withCompletionGate = completionGate.withPermits(1);
  const allocateClaimToken = (): string => `completion-${runtimeNamespace}-${nextClaimOrdinal++}`;
  const allocateAssignmentAttemptToken = (): string =>
    `assignment-${runtimeNamespace}-${nextAssignmentAttemptOrdinal++}`;
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
    assignmentEpoch: number | undefined,
    update: (view: SubagentRunView) => SubagentRunView | undefined,
  ) =>
    withLock(
      Effect.sync(() => {
        if (isInactiveRunRecord(record)) return undefined;
        if (
          assignmentEpoch !== undefined &&
          (record.assignment.epoch !== assignmentEpoch || record.assignment.phase === "reported")
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
    if (view.state === "completed" || view.state === "reported") {
      const generation = record.completionGeneration;
      const existing = record.foregroundCompletionClaim;
      const claim =
        existing?.generation === generation
          ? existing
          : { generation, claimToken: allocateClaimToken() };
      if (claimCompletion(record, generation, claim.claimToken)) {
        record.foregroundCompletionClaim = claim;
        removePendingCompletion(pendingCompletions, record.view.id, generation);
      }
    }
    Deferred.doneUnsafe(record.foregroundOutcome, Effect.succeed(view));
    return true;
  };
  const pauseFromEvent = (record: RunRecord, now: number, assignmentEpoch: number) =>
    withLock(
      Effect.sync(() => {
        if (
          !record.pauseRequested ||
          isInactiveRunRecord(record) ||
          record.assignment.epoch !== assignmentEpoch ||
          record.assignment.phase !== "running"
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
  const failPendingResponses = (record: RunRecord, error: SubagentError) =>
    record.process?.cancelPending(error);
  const mapWriterLeaseConflict = (error: WriterLeaseConflictError): SubagentWriterConflictError =>
    new SubagentWriterConflictError({
      activeId: error.ownerRunId ?? "unknown-cross-process-writer",
      activeName: "cross-process writer",
      message: error.message,
    });
  const prepareWriterLeaseForSpawn = (record: RunRecord): Effect.Effect<void, SubagentError> => {
    const canonicalCwd = record.canonicalWriterCwd;
    const leaseScope = record.writerLeaseScope;
    const releaseState = record.writerLeaseReleaseState;
    if (!canonicalCwd) return Effect.void;
    if (!leaseScope || !releaseState)
      return Effect.fail(
        new SubagentProcessError({
          operation: "prepare writer lease",
          code: "writer_lease_state_missing",
          message: `Subagent ${record.view.id} has no writer-lease preparation state.`,
        }),
      );
    const cancelled = () =>
      new InvalidSubagentRequestError({
        code: "start_cancelled",
        message: `Subagent ${record.view.id} lost writer-lease reservation ownership during startup.`,
      });
    return Effect.gen(function* () {
      const began = yield* withLock(
        Effect.sync(() => {
          if (
            record.writerLeaseScope !== leaseScope ||
            record.writerLeaseReleaseState !== releaseState ||
            record.writerLeasePreparationState !== "pending" ||
            record.stoppedByParent ||
            record.view.state === "stopping" ||
            record.view.state === "stopped"
          )
            return false;
          record.writerLeasePreparationState = "running";
          return true;
        }),
      );
      if (!began) return yield* cancelled();
      const lease = yield* Effect.acquireRelease(
        writerLeases
          .acquire({
            cwd: canonicalCwd,
            sessionId: record.launch.parentSessionId,
            runId: record.view.id,
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "WriterLeaseConflictError"
                ? mapWriterLeaseConflict(error)
                : new SubagentProcessError({
                    operation: "acquire writer lease",
                    code: "writer_lease_acquire_failed",
                    message: error.message,
                  }),
            ),
          ),
        (ownedLease) =>
          releaseState.authorized
            ? writerLeases.release(ownedLease).pipe(Effect.orDie)
            : Effect.void,
      ).pipe(Effect.provideService(Scope.Scope, leaseScope));
      const attached = yield* withLock(
        Effect.sync(() => {
          if (
            record.writerLeaseScope !== leaseScope ||
            record.writerLeaseReleaseState !== releaseState
          )
            return "stale" as const;
          record.writerLease = lease;
          return record.stoppedByParent || record.view.state === "stopping"
            ? ("cancelled" as const)
            : ("attached" as const);
        }),
      );
      if (attached === "stale") {
        releaseState.authorized = true;
        yield* Scope.close(leaseScope, Exit.void);
        return yield* cancelled();
      }
      if (attached === "cancelled") return yield* cancelled();

      const marked = yield* writerLeases.markSpawnStarted(lease).pipe(
        Effect.mapError(
          (error) =>
            new SubagentProcessError({
              operation: "mark writer spawn started",
              code: "writer_lease_mark_failed",
              message: error.message,
            }),
        ),
      );
      const confirmed = yield* withLock(
        Effect.sync(() => {
          if (
            record.writerLeaseScope !== leaseScope ||
            record.writerLeaseReleaseState !== releaseState ||
            record.writerLease?.ownershipToken !== lease.ownershipToken ||
            record.stoppedByParent ||
            record.view.state === "stopping" ||
            record.view.state === "stopped"
          )
            return false;
          record.writerLease = marked;
          return true;
        }),
      );
      if (!confirmed) return yield* cancelled();
    }).pipe(
      Effect.ensuring(
        withLock(
          Effect.sync(() => {
            if (
              record.writerLeaseScope === leaseScope &&
              record.writerLeaseReleaseState === releaseState
            )
              record.writerLeasePreparationState = "settled";
          }),
        ),
      ),
      Effect.uninterruptible,
    );
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
        record.writerLease = undefined;
        record.writerLeaseScope = undefined;
        record.writerLeasePreparationState = undefined;
        record.writerLeaseReleaseState = undefined;
        if (record.view.pid !== undefined) {
          const { pid: _pid, ...view } = record.view;
          record.view = view;
          publish();
        }
      }),
    );
  const retainCleanupQuarantine = (record: RunRecord, scope: Scope.Closeable) =>
    withLock(
      Effect.sync(() => {
        if (record.scope !== scope) return;
        record.cleanupPending = true;
        record.view = {
          ...record.view,
          warning:
            "Subagent cleanup could not be confirmed; process capacity and writer ownership remain quarantined for this session.",
        };
        publish();
      }),
    );
  const waitForWriterLeasePreparation = (
    record: RunRecord,
    scope: Scope.Closeable,
  ): Effect.Effect<void> =>
    Effect.suspend(() =>
      withLock(
        Effect.sync(
          () => record.scope === scope && record.writerLeasePreparationState === "running",
        ),
      ).pipe(
        Effect.flatMap((running) =>
          running
            ? Effect.sleep("25 millis").pipe(
                Effect.andThen(waitForWriterLeasePreparation(record, scope)),
              )
            : Effect.void,
        ),
      ),
    );
  const releaseWriterLeaseAfterCleanup = (record: RunRecord, scope: Scope.Closeable) =>
    waitForWriterLeasePreparation(record, scope).pipe(
      Effect.andThen(
        withLock(
          Effect.sync(() => {
            if (
              record.scope !== scope ||
              !record.writerLeaseScope ||
              !record.writerLeaseReleaseState
            )
              return undefined;
            if (record.writerLease) record.writerLeaseReleaseState.authorized = true;
            return record.writerLeaseScope;
          }),
        ),
      ),
      Effect.flatMap((leaseScope) =>
        leaseScope ? Scope.close(leaseScope, Exit.void) : Effect.void,
      ),
    );
  const closeRecordScope = (record: RunRecord, scope: Scope.Closeable = record.scope) =>
    withLock(
      Effect.sync(() => {
        if (record.closingScope === scope) return false;
        record.closingScope = scope;
        if (record.writerLeasePreparationState === "pending")
          record.writerLeasePreparationState = "settled";
        return true;
      }),
    ).pipe(
      Effect.flatMap((shouldClose) =>
        shouldClose
          ? Scope.close(scope, Exit.void).pipe(
              Effect.andThen(releaseWriterLeaseAfterCleanup(record, scope)),
              Effect.exit,
              Effect.flatMap((exit) =>
                Exit.isSuccess(exit)
                  ? clearCleanupPending(record, scope)
                  : retainCleanupQuarantine(record, scope).pipe(
                      Effect.andThen(
                        Effect.logWarning(
                          "Subagent backend or writer-lease cleanup failed; ownership remains quarantined.",
                        ).pipe(Effect.annotateLogs("runId", record.view.id)),
                      ),
                    ),
              ),
            )
          : Effect.void,
      ),
    );
  const closeExitedScope = (record: RunRecord, scope: Scope.Closeable): Effect.Effect<void> =>
    Effect.suspend(() =>
      withLock(
        Effect.sync(() =>
          record.scope !== scope || record.closingScope === scope
            ? "stale"
            : record.initializationPending
              ? "waiting"
              : "close",
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

  let sendPeerNotices: (changedId: string) => Effect.Effect<void>;
  let initializeProcess: (record: RunRecord) => Effect.Effect<BackendStartupState, SubagentError>;
  let startPrompt: (
    record: RunRecord,
    message: string,
    assignmentEpoch: number,
  ) => Effect.Effect<void, SubagentError>;
  let steerBackend: (record: RunRecord, message: string) => Effect.Effect<void, SubagentError>;
  let interruptBackend: (record: RunRecord) => Effect.Effect<void, SubagentError>;
  let renameBackend: (record: RunRecord, name: string) => Effect.Effect<void, SubagentError>;

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
          if (state === "completed")
            record.completionGenerations.set(completionGeneration, {
              generation: completionGeneration,
              ...(record.latestAssistantText ? { finalText: record.latestAssistantText } : {}),
              retained: false,
            });
          for (const [slot, notification] of pendingActionNotifications) {
            if (notification.id !== record.view.id || notification.type !== "warning") continue;
            pendingActionNotifications.delete(slot);
            record.warningNotificationGenerations.delete(slot);
          }
          record.notificationGeneration += 1;
          record.questionNotificationGeneration = record.notificationGeneration;
          pendingActionNotifications.delete(`${record.view.id}:question:default`);
          record.replyPendingRequestId = undefined;
          if (state === "completed") record.assignment.phase = "reported";
          record.view = {
            ...record.view,
            state,
            endedAt: now,
            lastActivityAt: now,
            currentTool: undefined,
            question: undefined,
            ...(state === "completed"
              ? {
                  reportGeneration: completionGeneration,
                  ...(record.latestAssistantText ? { finalText: record.latestAssistantText } : {}),
                }
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
          };
        }),
      );
      const view = result.view;
      if (!result.transitioned) return view;
      Deferred.doneUnsafe(result.settlement, Effect.succeed(view));
      if (result.pauseOutcome) Deferred.doneUnsafe(result.pauseOutcome, Effect.succeed(view));
      const deliveredToForeground = deliverForeground(record, view);
      if (state === "completed") {
        if (!deliveredToForeground) yield* queueCompletion(record, result.completionGeneration);
      } else if (!deliveredToForeground && state === "failed") {
        yield* queueActionNotification(record, {
          type: "warning",
          id: view.id,
          name: view.name,
          message: error ?? "Run failed.",
          triggerTurn: true,
        });
      }
      yield* sendPeerNotices(record.view.id);
      if (result.completedScope)
        yield* closeRecordScope(record, result.completedScope).pipe(
          Effect.forkIn(ownerScope, { startImmediately: true }),
          Effect.asVoid,
        );
      return view;
    });

  type RetainedReportTransition = {
    readonly transitioned: true;
    readonly view: SubagentRunView;
    readonly settlement: Deferred.Deferred<SubagentRunView>;
    readonly pauseOutcome?: Deferred.Deferred<SubagentRunView, SubagentError> | undefined;
    readonly generation: number;
  };

  const rejectReportLocked = (record: RunRecord, reason: string): SubagentRunView => {
    const warning = sanitizeDiagnosticText(
      `Rejected protocol-invalid backend report: ${reason}`,
      MAX_ERROR_CHARS,
    );
    if (record.view.warning !== warning) {
      record.view = { ...record.view, warning };
      publish();
    }
    return snapshotView(record.view);
  };

  const reportPairStatus = (
    record: RunRecord,
    report: BackendReport,
  ): "new" | "exact-retry" | "invalid" => {
    const watermark = record.lastBackendReport;
    if (!watermark) return "new";
    if (
      report.assignmentEpoch === watermark.assignmentEpoch &&
      report.sequence === watermark.sequence &&
      report.deliveryId === watermark.deliveryId
    )
      return "exact-retry";
    return report.sequence <= watermark.sequence ? "invalid" : "new";
  };

  const commitRetainedReportLocked = (
    record: RunRecord,
    report: BackendReport,
    now: number,
  ): RetainedReportTransition => {
    const settlement = record.settlement;
    const pauseOutcome = record.pauseOutcome;
    record.pauseOutcome = undefined;
    record.pauseRequested = false;
    record.activeTools.clear();
    const generation = ++record.completionGeneration;
    const text = report.text;
    record.completionGenerations.set(generation, {
      generation,
      ...(text ? { finalText: text } : {}),
      retained: true,
    });
    record.notificationGeneration += 1;
    record.questionNotificationGeneration = record.notificationGeneration;
    pendingActionNotifications.delete(`${record.view.id}:question:default`);
    record.replyPendingRequestId = undefined;
    record.latestAssistantText = text;
    record.lastBackendReport = {
      assignmentEpoch: report.assignmentEpoch,
      sequence: report.sequence,
      deliveryId: report.deliveryId,
    };
    record.assignment.phase = "reported";
    record.assignment.pendingReport = undefined;
    record.assignment.pendingRunSettled = false;
    record.view = {
      ...record.view,
      state: "reported",
      reportGeneration: generation,
      endedAt: now,
      lastActivityAt: now,
      currentTool: undefined,
      question: undefined,
      finalText: text,
      error: undefined,
    };
    publish();
    return {
      transitioned: true,
      view: snapshotView(record.view),
      settlement,
      pauseOutcome,
      generation,
    };
  };

  const finishRetainedReport = (record: RunRecord, result: RetainedReportTransition) =>
    Effect.gen(function* () {
      Deferred.doneUnsafe(result.settlement, Effect.succeed(result.view));
      if (result.pauseOutcome)
        Deferred.doneUnsafe(result.pauseOutcome, Effect.succeed(result.view));
      const deliveredToForeground = deliverForeground(record, result.view);
      if (!deliveredToForeground) yield* queueCompletion(record, result.generation);
      yield* sendPeerNotices(record.view.id);
      return result.view;
    });

  const acceptBackendReport = (record: RunRecord, rawReport: BackendReport) =>
    Effect.gen(function* () {
      if (
        rawReport.runId !== record.view.id ||
        !Number.isSafeInteger(rawReport.assignmentEpoch) ||
        rawReport.assignmentEpoch <= 0 ||
        !Number.isSafeInteger(rawReport.sequence) ||
        rawReport.sequence <= 0 ||
        !rawReport.deliveryId.trim() ||
        rawReport.deliveryId.length > MAX_BACKEND_REPORT_ID_CHARS ||
        (rawReport.evidence !== undefined &&
          rawReport.evidence.length > MAX_BACKEND_REPORT_EVIDENCE_CHARS) ||
        (rawReport.text !== undefined && rawReport.text.length > MAX_BACKEND_REPORT_TEXT_CHARS)
      )
        return yield* new SubagentProcessError({
          operation: "accept report from",
          code: "backend_report_invalid",
          message: `Subagent ${record.view.id} emitted an invalid bounded report event.`,
        });
      const report: BackendReport = {
        ...rawReport,
        deliveryId: rawReport.deliveryId.trim(),
        ...(rawReport.text
          ? { text: sanitizeOutputText(rawReport.text, MAX_BACKEND_REPORT_TEXT_CHARS) }
          : { text: undefined }),
      };
      const now = yield* Clock.currentTimeMillis;
      const decision = yield* withLock(
        Effect.sync(() => {
          if (record.assignment.epoch !== report.assignmentEpoch)
            return { kind: "unchanged" as const, view: snapshotView(record.view) };
          const pair = reportPairStatus(record, report);
          if (pair === "exact-retry")
            return { kind: "unchanged" as const, view: snapshotView(record.view) };
          if (pair === "invalid")
            return {
              kind: "unchanged" as const,
              view: rejectReportLocked(
                record,
                `sequence ${report.sequence} reused delivery identity ${report.deliveryId}.`,
              ),
            };
          if (record.assignment.phase === "issuing") {
            const pending = record.assignment.pendingReport;
            if (
              pending &&
              (pending.sequence !== report.sequence || pending.deliveryId !== report.deliveryId)
            )
              return {
                kind: "unchanged" as const,
                view: rejectReportLocked(
                  record,
                  `assignment ${report.assignmentEpoch} produced more than one in-flight report.`,
                ),
              };
            if (!pending) record.assignment.pendingReport = report;
            return { kind: "buffered" as const, view: snapshotView(record.view) };
          }
          if (record.assignment.phase !== "running")
            return {
              kind: "unchanged" as const,
              view: rejectReportLocked(
                record,
                `sequence ${report.sequence} arrived while assignment ${report.assignmentEpoch} was ${record.assignment.phase}.`,
              ),
            };
          if (record.view.closeOnReport !== false) return { kind: "close" as const, report };
          return {
            kind: "retained" as const,
            result: commitRetainedReportLocked(record, report, now),
          };
        }),
      );
      if (decision.kind === "unchanged" || decision.kind === "buffered") return decision.view;
      if (decision.kind === "retained") return yield* finishRetainedReport(record, decision.result);

      const prepared = yield* withLock(
        Effect.sync(() => {
          if (
            record.assignment.epoch !== decision.report.assignmentEpoch ||
            record.assignment.phase !== "running"
          )
            return false;
          record.latestAssistantText = decision.report.text;
          return true;
        }),
      );
      if (!prepared) return snapshotView(record.view);
      const completed = yield* settle(record, "completed");
      if (completed.state === "completed")
        yield* withLock(
          Effect.sync(() => {
            if (record.assignment.epoch === decision.report.assignmentEpoch)
              record.lastBackendReport = {
                assignmentEpoch: decision.report.assignmentEpoch,
                sequence: decision.report.sequence,
                deliveryId: decision.report.deliveryId,
              };
          }),
        );
      return completed;
    });

  const runStartedFromBackend = (record: RunRecord, assignmentEpoch: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* withLock(
        Effect.sync(() => {
          if (
            record.assignment.epoch !== assignmentEpoch ||
            record.assignment.phase === "preparing" ||
            record.assignment.phase === "reported" ||
            isInactiveRunRecord(record)
          )
            return { kind: "unchanged" as const };
          record.assignment.startedObserved = true;
          if (record.assignment.phase === "issuing" && !record.assignment.outcomeUncertain) {
            record.view = {
              ...record.view,
              state: "running",
              endedAt: undefined,
              error: undefined,
              lastActivityAt: now,
            };
            publish();
            return { kind: "unchanged" as const };
          }
          const pendingReport = record.assignment.pendingReport;
          const pendingRunSettled = record.assignment.pendingRunSettled;
          record.assignment.phase = "running";
          record.assignment.pendingReport = undefined;
          record.assignment.pendingRunSettled = false;
          if (pendingReport && record.view.closeOnReport === false)
            return {
              kind: "report" as const,
              report: commitRetainedReportLocked(record, pendingReport, now),
            };
          record.view = {
            ...record.view,
            state: "running",
            endedAt: undefined,
            error: undefined,
            lastActivityAt: now,
          };
          publish();
          return { kind: "running" as const, pendingRunSettled };
        }),
      );
      if (result.kind === "report") {
        yield* finishRetainedReport(record, result.report);
        return;
      }
      if (result.kind === "running" && result.pendingRunSettled) yield* settle(record, "completed");
    });

  const runSettledFromBackend = (record: RunRecord, assignmentEpoch: number) =>
    Effect.gen(function* () {
      if (record.view.closeOnReport === false) return;
      const phase = yield* withLock(
        Effect.sync(() => {
          if (
            record.assignment.epoch !== assignmentEpoch ||
            record.assignment.phase === "preparing" ||
            record.assignment.phase === "reported" ||
            isInactiveRunRecord(record)
          )
            return "ignored" as const;
          if (record.assignment.phase === "issuing") {
            record.assignment.pendingRunSettled = true;
            return "buffered" as const;
          }
          return "running" as const;
        }),
      );
      if (phase !== "running") return;
      if (record.pauseRequested) {
        const now = yield* Clock.currentTimeMillis;
        const paused = yield* pauseFromEvent(record, now, assignmentEpoch);
        if (paused || record.stoppedByParent) return;
      }
      if (!record.stoppedByParent) yield* settle(record, "completed");
    });

  const failRun = (record: RunRecord, message: string, pendingError?: SubagentError) => {
    const diagnostic = sanitizeDiagnosticText(message, MAX_ERROR_CHARS);
    return withLock(
      Effect.sync(() => {
        if (isInactiveRunRecord(record)) return false;
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

  const handleWireEvent = makeRunEventHandler({
    mutateView: mutateEventView,
    runStarted: runStartedFromBackend,
    runSettled: runSettledFromBackend,
    settle,
    acceptReport: acceptBackendReport,
    notify: queueActionNotification,
    failRun,
    deliverForeground,
  });

  ({
    sendPeerNotices,
    initializeProcess,
    startPrompt,
    steer: steerBackend,
    interrupt: interruptBackend,
    renameDisplay: renameBackend,
  } = makeRunProcessLifecycle({
    ownerScope,
    records,
    withLock,
    publish,
    handleBackendEvent: handleWireEvent,
    prepareBackendSpawn: prepareWriterLeaseForSpawn,
    markCleanupPending,
    closeExitedScope,
    failRun,
  }));

  const confirmIssuedAssignment = (record: RunRecord, attemptToken: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* withLock(
        Effect.sync(() => {
          if (
            record.assignment.attemptToken !== attemptToken ||
            record.assignment.phase !== "issuing" ||
            isInactiveRunRecord(record)
          )
            return { kind: "unchanged" as const, view: snapshotView(record.view) };
          const pendingReport = record.assignment.pendingReport;
          const pendingRunSettled = record.assignment.pendingRunSettled;
          record.assignment.pendingReport = undefined;
          record.assignment.pendingRunSettled = false;
          record.assignment.outcomeUncertain = false;
          record.assignment.phase = "running";
          if (pendingReport && record.view.closeOnReport === false)
            return {
              kind: "report" as const,
              report: commitRetainedReportLocked(record, pendingReport, now),
            };
          record.view = {
            ...record.view,
            state: "running",
            endedAt: undefined,
            error: undefined,
            finalText: undefined,
            lastActivityAt: now,
          };
          publish();
          return {
            kind: "running" as const,
            view: snapshotView(record.view),
            pendingReport,
            pendingRunSettled,
          };
        }),
      );
      if (result.kind === "report") return yield* finishRetainedReport(record, result.report);
      if (result.kind === "running" && result.pendingReport)
        return yield* acceptBackendReport(record, result.pendingReport);
      if (result.kind === "running" && result.pendingRunSettled)
        return yield* settle(record, "completed");
      return result.view;
    });

  const submitPrompt = (
    record: RunRecord,
    message: string,
    operation: "start" | "resume",
    attemptToken: string,
  ) =>
    startPrompt(record, message, record.assignment.epoch).pipe(
      Effect.mapError((error) => {
        const outcomeUncertain =
          error._tag === "SubagentProcessError" && error.code?.endsWith("_outcome_uncertain");
        if (!outcomeUncertain || (operation === "start" && record.view.writeIntent !== "writer"))
          return error;
        return operation === "start"
          ? new SubagentProcessError({
              operation,
              code: "start_outcome_uncertain",
              message: `The writer task may have been accepted, but startup could not confirm the outcome. Inspect the workspace and subagent status before starting another writer. (${error.message})`,
            })
          : new SubagentProcessError({
              operation,
              code: "resume_outcome_uncertain",
              message: `The resume prompt may already have applied. Inspect subagent status before retrying. (${error.message})`,
            });
      }),
      Effect.andThen(confirmIssuedAssignment(record, attemptToken)),
    );

  const retainUncertainAssignment = (record: RunRecord, attemptToken: string, warning: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* withLock(
        Effect.sync(() => {
          if (
            record.assignment.attemptToken !== attemptToken ||
            record.assignment.phase !== "issuing"
          )
            return { kind: "unchanged" as const };
          record.assignment.outcomeUncertain = true;
          record.view = { ...record.view, warning };
          if (!record.assignment.startedObserved) {
            publish();
            return { kind: "unchanged" as const };
          }
          const pendingReport = record.assignment.pendingReport;
          const pendingRunSettled = record.assignment.pendingRunSettled;
          record.assignment.pendingReport = undefined;
          record.assignment.pendingRunSettled = false;
          record.assignment.phase = "running";
          if (pendingReport && record.view.closeOnReport === false)
            return {
              kind: "report" as const,
              report: commitRetainedReportLocked(record, pendingReport, now),
            };
          record.view = {
            ...record.view,
            state: "running",
            endedAt: undefined,
            finalText: undefined,
            lastActivityAt: now,
          };
          publish();
          return { kind: "running" as const, pendingRunSettled };
        }),
      );
      if (result.kind === "report") {
        yield* finishRetainedReport(record, result.report);
        return;
      }
      if (result.kind === "running" && result.pendingRunSettled) yield* settle(record, "completed");
    });

  const start: SubagentServiceShape["start"] = (request) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!request.task.trim())
          return yield* new InvalidSubagentRequestError({
            code: "task_required",
            message: "Subagent task is required.",
          });
        if (
          request.closeOnReport === false &&
          (request.host !== "herdr" || request.writeIntent !== "read-only")
        )
          return yield* new InvalidSubagentRequestError({
            code: "retained_report_capability_invalid",
            message: "closeOnReport=false requires a Herdr-hosted read-only backend.",
          });
        if (request.writeIntent === "writer" && writerLeases.platform === "win32")
          return yield* new UnsupportedSafeWriterOwnershipError({
            code: "unsupported_safe_writer_ownership",
            platform: writerLeases.platform,
            message:
              "Writer subagents are disabled on Windows because descendant termination cannot yet be proven without Job Object ownership. Read-only subagents remain available.",
          });
        const driver = yield* backendRegistry.resolve({
          host: request.host,
          runtime: request.runtime,
          context: request.context,
        });
        const canonicalWriterCwd =
          request.writeIntent === "writer"
            ? yield* writerLeases.canonicalize(request.cwd).pipe(
                Effect.mapError(
                  (error) =>
                    new InvalidSubagentRequestError({
                      code: "writer_cwd_canonicalization_failed",
                      message: error.message,
                    }),
                ),
              )
            : undefined;
        // Public profile routing already preflights for ordered fallback. Recheck at the service
        // admission boundary with the canonical writer cwd to close readiness races and protect
        // direct internal callers; failure belongs to the selected candidate and never falls through.
        if (driver.preflight)
          yield* driver.preflight({
            context: request.context,
            writeIntent: request.writeIntent,
            closeOnReport: request.closeOnReport,
            model: request.model,
            effort: request.effort,
            cwd: canonicalWriterCwd?.path ?? request.cwd,
          });
        if (request.task.length > MAX_TASK_CHARS)
          return yield* new InvalidSubagentRequestError({
            code: "task_too_large",
            message: "Subagent task is too large.",
          });
        const requestedName = sanitizeName(request.name ?? "");
        const now = yield* Clock.currentTimeMillis;
        // Run scopes are service-owned rather than automatically parent-closed so shutdown can
        // observe backend cleanup before authorizing the separately scoped writer lease release.
        const scope = yield* Scope.make();
        // Lease scope is detached from the owner scope so the service finalizer can first close
        // every backend scope, then authorize and close the corresponding lease scope.
        const writerLeaseScope = canonicalWriterCwd ? yield* Scope.make() : undefined;
        const writerLeaseReleaseState = writerLeaseScope ? { authorized: false } : undefined;
        const settlement = yield* Deferred.make<SubagentRunView>();
        const foregroundOutcome = yield* Deferred.make<SubagentRunView>();
        const reserved = yield* withLock(
          Effect.gen(function* () {
            if (closed)
              return yield* new SubagentRuntimeClosedError({
                message: "The subagent session runtime is closed.",
              });
            if (records.size >= MAX_RETAINED_RUNS) {
              const candidate = [...records.values()]
                .filter(
                  (record) =>
                    !record.cleanupPending &&
                    record.process === undefined &&
                    record.completionClaims.size === 0 &&
                    record.completionGenerations.size === 0 &&
                    isTerminalRunState(record.view.state),
                )
                .sort(
                  (left, right) =>
                    (left.view.endedAt ?? left.view.startedAt) -
                    (right.view.endedAt ?? right.view.startedAt),
                )[0];
              if (!candidate)
                return yield* new SubagentHistoryCapacityError({
                  limit: MAX_RETAINED_RUNS,
                  code: "history_outbox_capacity",
                  message: `Subagent history/outbox capacity reached (${MAX_RETAINED_RUNS}); unresolved or claimed reports or cleanup ownership must be resolved before another run can start.`,
                });
              records.delete(candidate.view.id);
              for (const [slot, notification] of pendingActionNotifications)
                if (notification.id === candidate.view.id) pendingActionNotifications.delete(slot);
              publish();
            }
            const capacityFailure = processCapacityError(records);
            if (capacityFailure) return yield* capacityFailure;
            if (canonicalWriterCwd) {
              const writerFailure = writerConflictError(records, canonicalWriterCwd);
              if (writerFailure) return yield* writerFailure;
            }
            const ordinal = nextRunOrdinal++;
            const id = `agent-${runtimeNamespace}-${ordinal}`;
            const name = requestedName || `subagent-${ordinal}`;
            const assignmentAttemptToken = allocateAssignmentAttemptToken();
            const foregroundClaim =
              request.execution === "foreground"
                ? { generation: 1, claimToken: allocateClaimToken() }
                : undefined;
            const view: SubagentRunView = {
              id,
              name,
              task: request.task.trim(),
              ...(request.profile ? { profile: request.profile } : {}),
              selection: request.selection ?? {
                source: "profile-candidate",
                host: request.host,
                runtime: request.runtime,
                closeOnReport: request.closeOnReport,
                reason: "Profile route selection.",
                skippedCandidates: [],
              },
              cwd: canonicalWriterCwd?.path ?? request.cwd,
              state: "starting",
              execution: request.execution,
              context: request.context,
              writeIntent: request.writeIntent,
              fastMode: request.fastMode,
              host: request.host,
              runtime: request.runtime,
              closeOnReport: request.closeOnReport,
              reportGeneration: 0,
              backend: request.backend,
              capabilities: driver.capabilities,
              model: request.model,
              effort: request.effort,
              startedAt: now,
              lastActivityAt: now,
              sessionEvents: [],
              usage: emptyUsage(),
            };
            const launch: BackendLaunchRequest = {
              runId: id,
              name,
              closeOnReport: request.closeOnReport,
              cwd: canonicalWriterCwd?.path ?? request.cwd,
              context: request.context,
              writeIntent: request.writeIntent,
              fastMode: request.fastMode,
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
              driver,
              launch,
              activeTools: new Map(),
              settlement,
              foregroundOutcome,
              foregroundWaitPending: request.execution === "foreground",
              ...(foregroundClaim ? { foregroundCompletionClaim: foregroundClaim } : {}),
              pauseRequested: false,
              stoppedByParent: false,
              cleanupPending: false,
              ...(canonicalWriterCwd ? { canonicalWriterCwd } : {}),
              ...(writerLeaseScope
                ? {
                    writerLeaseScope,
                    writerLeasePreparationState: "pending" as const,
                    writerLeaseReleaseState,
                  }
                : {}),
              initializationPending: true,
              warningTurnTriggered: false,
              notificationGeneration: 0,
              questionNotificationGeneration: 0,
              warningNotificationGenerations: new Map(),
              completionGeneration: 0,
              completionGenerations: new Map(),
              completionClaims: new Map(
                foregroundClaim ? [[foregroundClaim.generation, foregroundClaim.claimToken]] : [],
              ),
              assignment: {
                epoch: 1,
                phase: "preparing",
                attemptToken: assignmentAttemptToken,
                startedObserved: false,
                outcomeUncertain: false,
                pendingRunSettled: false,
              },
              nextAssignmentEpoch: 2,
            };
            records.set(id, record);
            publish();
            return record;
          }),
        ).pipe(
          Effect.onError(() =>
            Scope.close(scope, Exit.void).pipe(
              Effect.andThen(
                writerLeaseScope ? Scope.close(writerLeaseScope, Exit.void) : Effect.void,
              ),
            ),
          ),
        );

        const peerNotice = peerNoticeText(records.values(), reserved.view.id);
        const initialPrompt = taskPrompt(request, peerNotice);
        const initialize = Effect.gen(function* () {
          const state = yield* initializeProcess(reserved);
          // Let a terminal frame already queued behind the initialization state
          // commit its deferred settlement before this start result is returned.
          yield* Effect.yieldNow;
          if (request.effortWasExplicit && state.effort !== request.effort)
            return yield* new InvalidSubagentRequestError({
              code: "pi_effort_unsupported",
              message: `Model ${request.model} does not support requested effort ${request.effort}; effective level was ${state.effort}.`,
            });
          const resolvedModel = state.model ?? reserved.view.model;
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
              reserved.resumeToken = state.resumeToken;
              const pendingSettlement = reserved.pendingInitializationSettlement;
              reserved.pendingInitializationSettlement = undefined;
              reserved.view = {
                ...reserved.view,
                effort: state.effort,
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
              code: "start_cancelled",
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
          const attemptToken = yield* withLock(
            Effect.gen(function* () {
              if (reserved.assignment.phase !== "preparing" || reserved.view.state !== "starting")
                return yield* new InvalidSubagentRequestError({
                  code: "start_cancelled",
                  message: `Subagent ${reserved.view.id} changed state before its task could be issued.`,
                });
              reserved.assignment.phase = "issuing";
              return reserved.assignment.attemptToken;
            }),
          );
          const issued = yield* submitPrompt(reserved, initialPrompt, "start", attemptToken);
          yield* sendPeerNotices(reserved.view.id);
          return issued;
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

  const redactCompletionReport = (view: SubagentRunView): SubagentRunView => {
    const { finalText: _finalText, ...withoutReport } = view;
    return snapshotView({
      ...withoutReport,
      sessionEvents: withoutReport.sessionEvents.map((event) =>
        event.type === "assistant"
          ? { ...event, text: "[report redacted: owned or already delivered]" }
          : event,
      ),
    });
  };

  const startSessionOwned: SubagentServiceShape["startSessionOwned"] = (request) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const outcome = yield* Deferred.make<SubagentRunView, SubagentError>();
        yield* start(request).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(outcome, exit)),
          Effect.forkIn(ownerScope, { startImmediately: true }),
        );
        // Public start is admission-only. A report racing prompt confirmation remains unresolved
        // for exact-once await/notifier delivery and is never exposed or claimed here.
        return redactCompletionReport(yield* restore(Deferred.await(outcome)));
      }),
    );

  const observeRecord = (record: RunRecord, claimToken?: string): SubagentRunObservation => {
    const generation = record.completionGeneration;
    if (record.view.state !== "completed" && record.view.state !== "reported")
      return { run: snapshotView(record.view) };
    const unresolved = record.completionGenerations.has(generation);
    const owns =
      unresolved &&
      claimToken !== undefined &&
      completionClaimOwner(record, generation) === claimToken;
    return {
      run: owns ? snapshotView(record.view) : redactCompletionReport(record.view),
      ...(owns
        ? {
            completionReceipt: {
              id: record.view.id,
              generation,
              claimToken,
            },
          }
        : {}),
    };
  };
  const awaitForegroundObservation = (record: RunRecord) =>
    Deferred.await(record.foregroundOutcome).pipe(
      Effect.andThen(
        withLock(
          Effect.sync(() => observeRecord(record, record.foregroundCompletionClaim?.claimToken)),
        ),
      ),
    );
  const releaseForegroundObservation = (record: RunRecord, rendered: boolean) =>
    withLock(
      Effect.sync(() => {
        record.foregroundWaitPending = false;
        const claim = record.foregroundCompletionClaim;
        if (claim) {
          record.foregroundCompletionClaim = undefined;
          if (releaseCompletionClaim(record, claim.generation, claim.claimToken))
            queuePendingCompletion(pendingCompletions, record, claim.generation);
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
          code: "foreground_execution_required",
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
            !record.completionGenerations.has(receipt.generation) ||
            completionClaimOwner(record, receipt.generation) !== receipt.claimToken
          )
            continue;
          record.completionGenerations.delete(receipt.generation);
          record.completionClaims.delete(receipt.generation);
          removePendingCompletion(pendingCompletions, record.view.id, receipt.generation);
        }
      }),
    );

  interface CompletionClaim {
    readonly claimToken: string;
    readonly selected: ReadonlyArray<RunRecord>;
    readonly claimed: ReadonlyArray<{
      readonly record: RunRecord;
      readonly generation: number;
    }>;
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
          const claimToken = allocateClaimToken();
          const desired = claimAll
            ? selected.flatMap((record) => {
                const generation = isAssignmentFinishedRunState(record.view.state)
                  ? record.completionGeneration
                  : record.completionGeneration + 1;
                if (generation <= 0) return [];
                if (
                  isAssignmentFinishedRunState(record.view.state) &&
                  !record.completionGenerations.has(generation)
                )
                  return [];
                return [{ record, generation }];
              })
            : selected.flatMap((record) =>
                isAssignmentFinishedRunState(record.view.state) &&
                record.completionGenerations.has(record.completionGeneration)
                  ? [{ record, generation: record.completionGeneration }]
                  : [],
              );
          if (claimAll) {
            const conflict = desired.find(
              ({ record, generation }) => completionClaimOwner(record, generation) !== undefined,
            );
            if (conflict)
              return yield* new InvalidSubagentRequestError({
                code: "completion_claim_conflict",
                message: `Completion report ${conflict.record.view.id} generation ${conflict.generation} is already owned by another operation; wait for that operation to finish or cancel before retrying.`,
              });
          }
          const claimed = desired.filter(({ record, generation }) =>
            claimCompletion(record, generation, claimToken),
          );
          for (const claim of claimed)
            removePendingCompletion(pendingCompletions, claim.record.view.id, claim.generation);
          return { claimToken, selected, claimed, missingIds } satisfies CompletionClaim;
        }),
      ),
    );
  const releaseCompletionClaims = (claim: CompletionClaim) =>
    withLock(
      Effect.sync(() => {
        for (const claimed of claim.claimed)
          if (releaseCompletionClaim(claimed.record, claimed.generation, claim.claimToken))
            queuePendingCompletion(pendingCompletions, claimed.record, claimed.generation);
      }),
    ).pipe(Effect.andThen(scheduleCompletionFlush));
  const waitForTerminalObservations = (
    claim: CompletionClaim,
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
            const observations = claim.selected.map((record) =>
              observeRecord(record, claim.claimToken),
            );
            const runs = observations.map((observation) => observation.run);
            const terminalCount = runs.filter((run) =>
              isAssignmentFinishedRunState(run.state),
            ).length;
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
          code: "run_ids_required",
          message: "Await requires at least one subagent run ID.",
        }),
      );
    return Effect.acquireUseRelease(
      acquireCompletionClaims(ids, true),
      (claim) => waitForTerminalObservations(claim, until, onUpdate).pipe(Effect.flatMap(use)),
      releaseCompletionClaims,
    );
  };
  const withStatusObservations: SubagentServiceShape["withStatusObservations"] = (ids, use) =>
    Effect.acquireUseRelease(
      acquireCompletionClaims(ids, false, true),
      (claim) =>
        use({
          observations: claim.selected.map((record) => observeRecord(record, claim.claimToken)),
          missingIds: claim.missingIds,
        }),
      releaseCompletionClaims,
    );

  const awaitTerminal: SubagentServiceShape["awaitTerminal"] = (ids, until, onUpdate) =>
    withAwaitTerminalObservations(ids, until, onUpdate, (observations) =>
      consumeCompletions(
        observations.flatMap((observation) =>
          observation.completionReceipt ? [observation.completionReceipt] : [],
        ),
      ).pipe(Effect.as(observations.map((observation) => observation.run))),
    );

  const list = withLock(
    Effect.sync(() => sortRuns([...records.values()].map((record) => snapshotView(record.view)))),
  );
  const status: SubagentServiceShape["status"] = (id) =>
    withStatusObservations([id], ({ observations }) => {
      const observation = observations[0];
      if (!observation) return Effect.fail(notFound(id));
      return (
        observation.completionReceipt
          ? consumeCompletions([observation.completionReceipt])
          : Effect.void
      ).pipe(Effect.as(observation.run));
    }).pipe(Effect.catchTag("InvalidSubagentRequestError", () => Effect.fail(notFound(id))));

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
                    code: "resume_state_invalid",
                    message:
                      selected.view.state === "reported"
                        ? `Subagent ${id} is retained after report generation ${selected.view.reportGeneration}; use subagent_send to begin its next assignment on the same backend resource.`
                        : `Subagent ${id} cannot resume while ${selected.view.state}.`,
                  });
                if (selected.view.writeIntent === "writer") {
                  if (writerLeases.platform === "win32")
                    return yield* new UnsupportedSafeWriterOwnershipError({
                      code: "unsupported_safe_writer_ownership",
                      platform: writerLeases.platform,
                      message:
                        "Writer subagents cannot respawn on Windows because descendant termination cannot yet be proven without Job Object ownership.",
                    });
                  const canonicalCwd = selected.canonicalWriterCwd;
                  if (!canonicalCwd)
                    return yield* new InvalidSubagentRequestError({
                      code: "writer_cwd_canonicalization_missing",
                      message: `Subagent ${id} has no canonical writer cwd ownership evidence.`,
                    });
                  const writerFailure = writerConflictError(records, canonicalCwd, selected);
                  if (writerFailure) return yield* writerFailure;
                }
                const needsRespawn = selected.process === undefined;
                if (needsRespawn) {
                  const capacityFailure = processCapacityError(records, selected);
                  if (capacityFailure) return yield* capacityFailure;
                  if (!selected.resumeToken)
                    return yield* new InvalidSubagentRequestError({
                      code: "backend_resume_unavailable",
                      message: `Subagent ${id} cannot resume because ${selected.view.host ?? "its backend"}/${selected.view.runtime ?? selected.view.backend} did not provide continuation state.`,
                    });
                }
                const attemptToken = allocateAssignmentAttemptToken();
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
                selected.latestAssistantText = undefined;
                selected.assignment = {
                  epoch: selected.nextAssignmentEpoch++,
                  phase: "issuing",
                  attemptToken,
                  startedObserved: false,
                  outcomeUncertain: false,
                  pendingRunSettled: false,
                };
                selected.view = {
                  ...selected.view,
                  state: "starting",
                  question: undefined,
                  currentTool: undefined,
                  warning: undefined,
                  endedAt: undefined,
                  error: undefined,
                  lastActivityAt: now,
                };
                publish();
                return { record: selected, needsRespawn, attemptToken };
              }),
            );
            const commit = Effect.gen(function* () {
              const record = claimed.record;
              if (claimed.needsRespawn) {
                const nextScope = yield* Scope.make();
                const nextWriterLeaseScope = claimed.record.canonicalWriterCwd
                  ? yield* Scope.make()
                  : undefined;
                const nextWriterLeaseReleaseState = nextWriterLeaseScope
                  ? { authorized: false }
                  : undefined;
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
                    record.closingScope = undefined;
                    record.writerLease = undefined;
                    record.writerLeaseScope = nextWriterLeaseScope;
                    record.writerLeasePreparationState = nextWriterLeaseScope
                      ? "pending"
                      : undefined;
                    record.writerLeaseReleaseState = nextWriterLeaseReleaseState;
                    record.launch = {
                      ...record.launch,
                      resumeToken: record.resumeToken,
                    };
                    return true;
                  }),
                );
                if (!installed) {
                  yield* Scope.close(nextScope, Exit.void);
                  if (nextWriterLeaseScope) yield* Scope.close(nextWriterLeaseScope, Exit.void);
                  return yield* new InvalidSubagentRequestError({
                    code: "resume_cancelled",
                    message: `Subagent ${id} stopped before its session could be restored.`,
                  });
                }
                const state = yield* initializeProcess(record);
                const resolvedModel = state.model ?? record.view.model;
                const committed = yield* withLock(
                  Effect.sync(() => {
                    if (record.view.state !== "starting") return undefined;
                    record.initializationPending = false;
                    record.resumeToken = state.resumeToken;
                    const pendingSettlement = record.pendingInitializationSettlement;
                    record.pendingInitializationSettlement = undefined;
                    record.view = {
                      ...record.view,
                      model: resolvedModel,
                      effort: state.effort,
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
              const issued = yield* submitPrompt(
                claimed.record,
                prompt,
                "resume",
                claimed.attemptToken,
              );
              const view = yield* withLock(
                Effect.sync(() => {
                  const record = claimed.record;
                  if (issued.state !== "running") return snapshotView(record.view);
                  record.view = {
                    ...record.view,
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
                        claimed.record.initializationPending = false;
                        const pending = claimed.record.pendingInitializationSettlement;
                        claimed.record.pendingInitializationSettlement = undefined;
                        return pending;
                      }),
                    ).pipe(
                      Effect.flatMap((pending) =>
                        pending
                          ? pending.state === "failed"
                            ? failRun(
                                claimed.record,
                                pending.error ?? "Subagent failed while resuming.",
                              ).pipe(Effect.asVoid)
                            : settle(claimed.record, pending.state, pending.error).pipe(
                                Effect.asVoid,
                              )
                          : retainUncertainAssignment(
                              claimed.record,
                              claimed.attemptToken,
                              error.message,
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
    steerBackend,
    beginAssignmentBackend: (record, message, attemptToken) =>
      submitPrompt(record, message, "resume", attemptToken),
    allocateAssignmentAttemptToken,
    retainUncertainAssignment,
    interruptBackend,
    renameBackend,
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
            record.cleanupPending = true;
            return closeRecordScope(record);
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
