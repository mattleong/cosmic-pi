import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { type SubagentError, SubagentProcessError } from "./errors.ts";
import { isInactiveRunRecord, type RunRecord } from "./internal.ts";
import { isTerminalRunState, type SubagentRunView, type SubagentUsage } from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import { addUsage, MAX_ERROR_CHARS, sanitizeDiagnosticText, snapshotView } from "./state.ts";
import { foldRunWarnings } from "./warnings.ts";

export interface RunSettlementDependencies {
  readonly ownerScope: Scope.Scope;
  /** The shared service lock guarding every RunRecord mutation. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly publish: Effect.Effect<void>;
  readonly delivery: RunNotificationDelivery;
  readonly closeRecordScope: (record: RunRecord, scope?: Scope.Closeable) => Effect.Effect<void>;
  /** Late-bound process-lifecycle peer notifier; resolved at call time. */
  readonly sendPeerNotices: (changedId: string) => Effect.Effect<void>;
}

/**
 * Owns event-driven view mutation, pause commits, and terminal settlement.
 * `settle` performs one locked transaction covering completion generation
 * allocation, outbox insertion, question invalidation, warning folding,
 * deferred-initialization settlement, and idempotence; post-commit scheduling
 * and peer notification stay outside the lock.
 */
export function makeRunSettlement(dependencies: RunSettlementDependencies) {
  const { ownerScope, withLock, publish, delivery, closeRecordScope, sendPeerNotices } =
    dependencies;

  const mutateEventView = (
    record: RunRecord,
    assignmentEpoch: number | undefined,
    update: (view: SubagentRunView) => SubagentRunView | undefined,
  ) =>
    withLock(
      Effect.gen(function* () {
        if (isInactiveRunRecord(record)) return undefined;
        if (
          assignmentEpoch !== undefined &&
          (record.assignment.epoch !== assignmentEpoch || record.assignment.phase === "reported")
        )
          return undefined;
        const next = update(record.view);
        if (!next) return undefined;
        record.view = next;
        yield* publish;
        return snapshotView(record.view);
      }),
    );
  /**
   * Merges exact-epoch usage that a backend reported only at its final native
   * result, after an accepted report already settled the run. Only the completed
   * outcome of the same assignment may absorb it; idle retained `reported`,
   * stopped, failed, and parent-stopped records ignore late usage entirely.
   */
  const mergeLateUsage = (record: RunRecord, assignmentEpoch: number, usage: SubagentUsage) =>
    withLock(
      Effect.gen(function* () {
        if (
          record.stoppedByParent ||
          record.assignment.epoch !== assignmentEpoch ||
          record.view.state !== "completed"
        )
          return;
        const merged = addUsage(record.view.usage, usage);
        if (merged === record.view.usage) return;
        record.view = { ...record.view, usage: merged };
        yield* publish;
      }),
    );
  const pauseFromEvent = (record: RunRecord, now: number, assignmentEpoch: number) =>
    withLock(
      Effect.gen(function* () {
        if (
          !record.pauseRequested ||
          isInactiveRunRecord(record) ||
          record.assignment.epoch !== assignmentEpoch ||
          record.assignment.phase !== "running"
        )
          return undefined;
        record.activeTools.clear();
        record.pausedAssignmentEpoch = assignmentEpoch;
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
        yield* publish;
        if (outcome) Deferred.doneUnsafe(outcome, Effect.succeed(view));
        return view;
      }),
    );
  const failPendingResponses = (record: RunRecord, error: SubagentError) =>
    record.process?.cancelPending(error);

  const settle = (record: RunRecord, state: "completed" | "failed" | "stopped", error?: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* withLock(
        Effect.gen(function* () {
          if (
            isTerminalRunState(record.view.state) ||
            (state !== "stopped" && (record.stoppedByParent || record.view.state === "stopping"))
          )
            return { transitioned: false as const, view: snapshotView(record.view) };
          if (record.initializationPending && state !== "stopped") {
            record.pendingInitializationSettlement = (() => {
              const baseResult = { state };
              const withError = error ? { ...baseResult, error } : baseResult;
              return withError;
            })();
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
          const hasDeliverableOutcome = state === "completed" || state === "failed";
          const completionGeneration = hasDeliverableOutcome
            ? ++record.completionGeneration
            : record.completionGeneration;
          const completionWarning = foldRunWarnings(record.warningSlots);
          if (hasDeliverableOutcome)
            record.completionGenerations.set(
              completionGeneration,
              (() => {
                const baseResult = { generation: completionGeneration, outcome: state };
                const withFinalText =
                  state === "completed" && record.latestAssistantText
                    ? { ...baseResult, finalText: record.latestAssistantText }
                    : baseResult;
                const withError =
                  state === "failed"
                    ? { ...withFinalText, error: error ?? "Run failed." }
                    : withFinalText;
                const withWarning = completionWarning
                  ? { ...withError, warning: completionWarning }
                  : withError;
                const withRetained = { ...withWarning, retained: false };
                return withRetained;
              })(),
            );
          record.notificationGeneration += 1;
          delivery.discardQuestionLocked(record.view.id);
          record.replyPendingRequestId = undefined;
          if (state === "completed") record.assignment.phase = "reported";
          const viewBase = {
            ...record.view,
            state,
            endedAt: now,
            lastActivityAt: now,
            currentTool: undefined,
            question: undefined,
          };
          const reportBase = { reportGeneration: completionGeneration };
          const reportDetails = record.latestAssistantText
            ? { ...reportBase, finalText: record.latestAssistantText }
            : reportBase;
          const completedView =
            state === "completed" ? { ...viewBase, ...reportDetails } : viewBase;
          record.view =
            state === "failed"
              ? { ...completedView, error: error ?? "Run failed." }
              : error
                ? { ...completedView, error }
                : completedView;
          yield* publish;
          const view = snapshotView(record.view);
          const completionQueued = hasDeliverableOutcome;
          if (completionQueued) delivery.queueCompletionLocked(record, completionGeneration);
          return {
            transitioned: true as const,
            view,
            settlement,
            pauseOutcome,
            completedScope,
            completionQueued,
          };
        }),
      ).pipe(
        Effect.tap((transition) =>
          transition.transitioned && transition.completionQueued
            ? delivery.scheduleCompletionFlush
            : Effect.void,
        ),
        Effect.uninterruptible,
      );
      const view = result.view;
      if (!result.transitioned) return view;
      Deferred.doneUnsafe(result.settlement, Effect.succeed(view));
      if (result.pauseOutcome) Deferred.doneUnsafe(result.pauseOutcome, Effect.succeed(view));
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

  return {
    /** Locked epoch/phase-guarded view mutation for assignment-scoped events. */
    mutateEventView,
    /** Locked exact-epoch usage merge for results arriving after report settlement. */
    mergeLateUsage,
    /** Commits a requested pause exactly once for the active running assignment. */
    pauseFromEvent,
    failPendingResponses,
    /** One locked idempotent terminal transaction plus post-commit delivery/peer scheduling. */
    settle,
    /** Marks cleanup, cancels pending responses, force-terminates, then settles failed. */
    failRun,
  };
}

export type RunSettlement = ReturnType<typeof makeRunSettlement>;
