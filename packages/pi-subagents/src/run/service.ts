import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { freezeSnapshot } from "pi-cosmic-core";
import { ChildProcess, type ChildLaunchRequest } from "../boundary/child-process.ts";
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
import { childSystemPrompt, peerNoticeText, taskPrompt } from "./coordination.ts";
import { makeRunEventHandler } from "./events.ts";
import type { RunRecord } from "./internal.ts";
import { makeRunProcessLifecycle } from "./process-lifecycle.ts";
import {
  COMPLETION_RETRY_INITIAL_MILLIS,
  COMPLETION_RETRY_MAX_MILLIS,
  MAX_CONCURRENT_RUNS,
  MAX_PARENT_MESSAGE_CHARS,
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
import { advanceRateLimitNotice, isRejectedRateLimit, rateLimitMessage } from "./rate-limit.ts";
import { appendNoticeSessionEvent } from "./session-output.ts";
import {
  MAX_ERROR_CHARS,
  MAX_TASK_CHARS,
  sanitizeDiagnosticText,
  sanitizeName,
  snapshotView,
} from "./state.ts";
import { appendTranscript } from "./transcript.ts";

const CLAUDE_RATE_LIMIT_RESULT_GRACE = "2 seconds";

const ownsProcessSlot = (record: RunRecord): boolean =>
  record.cleanupPending || record.process !== undefined || record.view.state === "starting";

const ownsWriterSlot = (record: RunRecord): boolean =>
  record.view.writeIntent === "writer" &&
  (record.cleanupPending || isActiveRunState(record.view.state));

const validateParentMessage = (
  message: string,
  emptyMessage: string,
): Effect.Effect<string, InvalidSubagentRequestError> => {
  const normalized = message.trim();
  if (!normalized) return Effect.fail(new InvalidSubagentRequestError({ message: emptyMessage }));
  if (normalized.length > MAX_PARENT_MESSAGE_CHARS)
    return Effect.fail(
      new InvalidSubagentRequestError({
        message: `Subagent message exceeds ${MAX_PARENT_MESSAGE_CHARS} characters.`,
      }),
    );
  return Effect.succeed(normalized);
};

export type SubagentNotificationCallback =
  | ((notification: SubagentNotification) => SubagentNotificationDelivery | undefined)
  | ((notification: SubagentNotification) => void);

export interface SubagentServiceOptions {
  readonly publish?: (projection: SubagentProjection) => void;
  readonly notify?: SubagentNotificationCallback;
}

export type SubagentAwaitUntil = "all_terminal" | "any_terminal";

export interface SubagentCompletionReceipt {
  readonly id: string;
  readonly generation: number;
}

export interface SubagentRunObservation {
  readonly run: SubagentRunView;
  readonly completionReceipt?: SubagentCompletionReceipt | undefined;
}

export interface SubagentServiceShape {
  readonly start: (request: StartSubagentRequest) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly waitForForeground: (id: string) => Effect.Effect<SubagentRunView, SubagentNotFoundError>;
  readonly awaitTerminal: (
    ids: ReadonlyArray<string>,
    until: SubagentAwaitUntil,
    onUpdate?: (runs: ReadonlyArray<SubagentRunView>) => void,
  ) => Effect.Effect<ReadonlyArray<SubagentRunView>, SubagentError>;
  readonly awaitTerminalObserved?: (
    ids: ReadonlyArray<string>,
    until: SubagentAwaitUntil,
    onUpdate?: (runs: ReadonlyArray<SubagentRunView>) => void,
  ) => Effect.Effect<ReadonlyArray<SubagentRunObservation>, SubagentError>;
  readonly withAwaitTerminalObservations?: <A, E, R>(
    ids: ReadonlyArray<string>,
    until: SubagentAwaitUntil,
    onUpdate: ((runs: ReadonlyArray<SubagentRunView>) => void) | undefined,
    use: (observations: ReadonlyArray<SubagentRunObservation>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, SubagentError | E, R>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentRunView>>;
  readonly status: (id: string) => Effect.Effect<SubagentRunView, SubagentNotFoundError>;
  readonly observeStatus?: (
    id: string,
  ) => Effect.Effect<SubagentRunObservation, SubagentNotFoundError>;
  readonly withStatusObservations?: <A, E, R>(
    ids: ReadonlyArray<string>,
    use: (observations: ReadonlyArray<SubagentRunObservation>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, SubagentNotFoundError | E, R>;
  readonly consumeCompletions?: (
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
          message: `${record.view.backend} subagents do not support ${capability}.`,
        }),
      );

const makeService = Effect.fn("SubagentService.make")(function* (options: SubagentServiceOptions) {
  const childProcesses = yield* ChildProcess;
  const ownerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const completionGate = yield* Semaphore.make(1);
  const records = new Map<string, RunRecord>();
  const revisionWaiters = new Set<Deferred.Deferred<void>>();
  const pendingCompletions = new Map<string, number>();
  let completionFlushScheduled = false;
  let completionRetryDelayMillis = COMPLETION_RETRY_INITIAL_MILLIS;
  let nextRunId = 1;
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
      // Host transcript delivery is best effort.
      return notification.type === "completed" ? { deliveredCompletionKeys: [] } : undefined;
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
  const closeExitedScope = (record: RunRecord, scope: Scope.Closeable) =>
    closeRecordScope(record, scope).pipe(Effect.asVoid);

  let rpc: <A extends RpcCommand>(
    record: RunRecord,
    command: A,
  ) => Effect.Effect<RpcResponse, SubagentError>;
  let sendPeerNotices: (changedId: string) => Effect.Effect<void>;
  let initializeProcess: (
    record: RunRecord,
    retriesRemaining: number,
    claudeBootstrapPrompt: string | undefined,
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
          record.view = {
            ...record.view,
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
        if (deliveredToForeground)
          yield* withLock(
            Effect.sync(() => {
              record.completionConsumedGeneration = Math.max(
                record.completionConsumedGeneration,
                result.completionGeneration,
              );
            }),
          );
        else yield* queueCompletion(record, result.completionGeneration);
      } else if (
        !deliveredToForeground &&
        state === "failed" &&
        !(record.rateLimitRejected && record.rateLimitRejectionNotified)
      )
        notify({
          type: "warning",
          id: view.id,
          name: view.name,
          message: error ?? "Run failed.",
          triggerTurn: true,
        });
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
      const update = yield* withLock(
        Effect.sync(() => {
          const generation = ++record.rateLimitGeneration;
          record.rateLimitRejected = rejected;
          if (
            record.stoppedByParent ||
            record.view.state === "stopping" ||
            isTerminalRunState(record.view.state)
          )
            return { generation, notifyParent: false };

          const limitKey = event.rateLimitType ?? "usage";
          const { notice, notifyParent } = advanceRateLimitNotice(
            record.rateLimitNotices.get(limitKey),
            event,
          );
          if (notifyParent && rejected) record.rateLimitRejectionNotified = true;
          record.rateLimitNotices.set(limitKey, notice);

          if (!message) {
            if (record.rateLimitWarning && record.view.warning === record.rateLimitWarning) {
              record.view = { ...record.view, warning: undefined };
              publish();
            }
            record.rateLimitWarning = undefined;
            return { generation, notifyParent: false };
          }
          const duplicate = record.view.warning === message;
          record.rateLimitWarning = message;
          record.view = {
            ...record.view,
            warning: message,
            lastActivityAt: now,
            transcript:
              notifyParent && !duplicate
                ? appendTranscript(record.view.transcript, `warning: ${message}`)
                : record.view.transcript,
            sessionEvents:
              notifyParent && !duplicate
                ? appendNoticeSessionEvent(record.view.sessionEvents, "warning", message, now)
                : record.view.sessionEvents,
          };
          publish();
          return { generation, notifyParent };
        }),
      );
      if (event.status === "allowed" || !message) return;
      if (!rejected) {
        if (update.notifyParent)
          notify({
            type: "warning",
            id: record.view.id,
            name: record.view.name,
            message,
            triggerTurn: false,
          });
        return;
      }
      if (update.notifyParent) {
        notify({
          type: "warning",
          id: record.view.id,
          name: record.view.name,
          message,
          triggerTurn: true,
        });
      }
      yield* Effect.sleep(CLAUDE_RATE_LIMIT_RESULT_GRACE).pipe(
        Effect.andThen(
          withLock(
            Effect.sync(
              () =>
                record.rateLimitGeneration === update.generation &&
                !record.stoppedByParent &&
                record.view.state !== "stopping" &&
                !isTerminalRunState(record.view.state),
            ),
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
    notify,
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
            message: "Claude CLI subagents require a trusted project.",
          });
        if (request.backend === "claude-cli" && request.context === "fork")
          return yield* new InvalidSubagentRequestError({
            message: "Claude CLI does not support forked Pi context yet.",
          });
        if (request.backend === "claude-cli" && !isClaudeModelSelector(request.model))
          return yield* new InvalidSubagentRequestError({
            message: "Claude model must be an alias or full model ID of at most 128 characters.",
          });
        if (
          request.backend === "claude-cli" &&
          request.effortWasExplicit &&
          (request.effort === "off" || request.effort === "minimal")
        )
          return yield* new InvalidSubagentRequestError({
            message: `Claude CLI does not support effort ${request.effort}.`,
          });
        if (request.task.length > MAX_TASK_CHARS)
          return yield* new InvalidSubagentRequestError({ message: "Subagent task is too large." });
        const name = sanitizeName(request.name ?? "") || `subagent-${nextRunId}`;
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
            if (retainedProcesses >= MAX_CONCURRENT_RUNS)
              return yield* new SubagentCapacityError({
                limit: MAX_CONCURRENT_RUNS,
                message: `Subagent capacity reached (${MAX_CONCURRENT_RUNS}). Stop an existing run first.`,
              });
            if (request.writeIntent === "writer") {
              const activeWriter = [...records.values()].find(ownsWriterSlot);
              if (activeWriter)
                return yield* new SubagentWriterConflictError({
                  activeId: activeWriter.view.id,
                  activeName: activeWriter.view.name,
                  message: `Writer ${activeWriter.view.name} (${activeWriter.view.id}) already owns the shared cwd.`,
                });
            }
            const id = `agent-${nextRunId++}`;
            const view: SubagentRunView = {
              id,
              name,
              task: request.task.trim(),
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
              transcript: [],
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
              warningTurnTriggered: false,
              completionGeneration: 0,
              completionConsumedGeneration: 0,
              completionNotifiedGeneration: 0,
              completionClaims: 0,
              rateLimitGeneration: 0,
              rateLimitRejected: false,
              rateLimitRejectionNotified: false,
              rateLimitNotices: new Map(),
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
          );
          if (
            request.backend === "pi" &&
            request.effortWasExplicit &&
            state.thinkingLevel !== request.effort
          )
            return yield* new InvalidSubagentRequestError({
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
              if (isTerminalRunState(reserved.view.state)) {
                reserved.view = {
                  ...reserved.view,
                  effort: state.thinkingLevel as StartSubagentRequest["effort"],
                  model: resolvedModel,
                  sessionId: state.sessionId,
                  ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
                };
                publish();
                return snapshotView(reserved.view);
              }
              reserved.view = {
                ...reserved.view,
                state: "running",
                effort: state.thinkingLevel as StartSubagentRequest["effort"],
                model: resolvedModel,
                lastActivityAt: startedAt,
                sessionId: state.sessionId,
                ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
              };
              publish();
              return snapshotView(reserved.view);
            }),
          );
          if (!activated)
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${reserved.view.id} was stopped during startup.`,
            });
          if (request.backend === "pi")
            yield* rpc(reserved, { type: "prompt", message: initialPrompt });
          yield* sendPeerNotices(reserved.view.id);
          return activated;
        });

        return yield* restore(initialize).pipe(
          Effect.onError((cause) =>
            Effect.gen(function* () {
              const interruptedOnly =
                cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason);
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

  const waitForForeground: SubagentServiceShape["waitForForeground"] = (id) =>
    Effect.flatMap(requireRecord(id), (record) =>
      Deferred.await(record.foregroundOutcome).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            record.foregroundWaitPending = false;
          }),
        ),
      ),
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

  const consumeCompletions: NonNullable<SubagentServiceShape["consumeCompletions"]> = (receipts) =>
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
  }
  const acquireCompletionClaims = (ids: ReadonlyArray<string>, claimAll: boolean) =>
    withCompletionGate(
      withLock(
        Effect.forEach(ids, (id) => requireRecord(id)).pipe(
          Effect.map((selected): CompletionClaim => {
            const claimed = claimAll
              ? selected
              : selected.filter((record) => record.view.state === "completed");
            for (const record of claimed) {
              record.completionClaims += 1;
              pendingCompletions.delete(record.view.id);
            }
            return { selected, claimed };
          }),
        ),
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
            const done =
              until === "any_terminal" ? terminalCount > 0 : terminalCount === runs.length;
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
  const withAwaitTerminalObservations: NonNullable<
    SubagentServiceShape["withAwaitTerminalObservations"]
  > = (ids, until, onUpdate, use) => {
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
  const awaitTerminalObserved: NonNullable<SubagentServiceShape["awaitTerminalObserved"]> = (
    ids,
    until,
    onUpdate,
  ) => withAwaitTerminalObservations(ids, until, onUpdate, Effect.succeed);
  const withStatusObservations: NonNullable<SubagentServiceShape["withStatusObservations"]> = (
    ids,
    use,
  ) =>
    Effect.acquireUseRelease(
      acquireCompletionClaims(ids, false),
      (claim) => use(claim.selected.map(observeRecord)),
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
  const observeStatus: NonNullable<SubagentServiceShape["observeStatus"]> = (id) =>
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

  const resume: SubagentServiceShape["resume"] = (id, message) =>
    waitForRunCleanup(id).pipe(
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
                  if (retainedProcesses >= MAX_CONCURRENT_RUNS)
                    return yield* new SubagentCapacityError({
                      limit: MAX_CONCURRENT_RUNS,
                      message: `Subagent capacity reached (${MAX_CONCURRENT_RUNS}). Stop an existing run first.`,
                    });
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
                selected.view = {
                  ...selected.view,
                  state: "starting",
                  question: undefined,
                  currentTool: undefined,
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
                const state = yield* initializeProcess(record, 1, claudeBootstrapPrompt);
                promptSubmittedDuringInitialization = claudeBootstrapPrompt !== undefined;
                const resolvedModel = rpcStateModelId(state.model) ?? record.view.model;
                yield* withLock(
                  Effect.sync(() => {
                    if (record.view.state !== "starting") return;
                    record.view = {
                      ...record.view,
                      model: resolvedModel,
                      effort: state.thinkingLevel as StartSubagentRequest["effort"],
                      sessionId: state.sessionId,
                      ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
                    };
                    publish();
                  }),
                );
              }
              if (!promptSubmittedDuringInitialization)
                yield* rpc(claimed.record, { type: "prompt", message: prompt });
              const view = yield* withLock(
                Effect.sync(() => {
                  const record = claimed.record;
                  if (record.view.state !== "starting") return snapshotView(record.view);
                  record.latestAssistantText = undefined;
                  record.view = {
                    ...record.view,
                    state: "running",
                    endedAt: undefined,
                    error: undefined,
                    finalText: undefined,
                    lastActivityAt: now,
                    transcript: appendTranscript(
                      record.view.transcript,
                      `parent resumed: ${prompt}`,
                    ),
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
              if (view.state !== "running")
                return yield* new SubagentProcessError({
                  operation: "resume",
                  message: view.error ?? `Subagent ${id} stopped before resume completed.`,
                });
              yield* sendPeerNotices(id);
              return view;
            }).pipe(
              Effect.onError((cause) =>
                failRun(claimed.record, Cause.pretty(cause)).pipe(
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
    waitForForeground,
    awaitTerminal,
    awaitTerminalObserved,
    withAwaitTerminalObservations,
    list,
    status,
    observeStatus,
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
