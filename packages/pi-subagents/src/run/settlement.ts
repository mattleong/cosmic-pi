import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import {
  MAX_BACKEND_REPORT_EVIDENCE_CHARS,
  MAX_BACKEND_REPORT_ID_CHARS,
  MAX_BACKEND_REPORT_TEXT_CHARS,
  type BackendReport,
} from "../backend/model.ts";
import { type SubagentError, SubagentProcessError } from "./errors.ts";
import {
  clearRunNativeActivity,
  isInactiveRunRecord,
  type CompletionGenerationRecord,
  type RunRecord,
} from "./internal.ts";
import { isTerminalRunState, type SubagentRunView, type SubagentUsage } from "./model.ts";
import { MAX_UNRESOLVED_REPORT_GENERATIONS } from "./limits.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import {
  addUsage,
  MAX_ERROR_CHARS,
  sanitizeDiagnosticText,
  sanitizeOutputText,
  snapshotView,
} from "./state.ts";
import { foldRunWarnings, setRunWarning } from "./warnings.ts";

export interface RunSettlementDependencies {
  readonly ownerScope: Scope.Scope;
  /** The shared service lock guarding every RunRecord mutation. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly publish: Effect.Effect<void>;
  readonly delivery: RunNotificationDelivery;
  readonly closeRecordScope: (record: RunRecord, scope?: Scope.Closeable) => Effect.Effect<void>;
  readonly sendPeerNotices: (changedId: string) => Effect.Effect<void>;
}

export type AssignmentActivationReplay =
  | { readonly kind: "running"; readonly view: SubagentRunView }
  | { readonly kind: "retained-report"; readonly view: SubagentRunView }
  | { readonly kind: "close-report"; readonly report: BackendReport }
  | { readonly kind: "settlement" };

type SettlementState = "completed" | "failed" | "stopped";

const settlementBlocked = (record: RunRecord, state: SettlementState): boolean =>
  isTerminalRunState(record.view.state) ||
  (state !== "stopped" && (record.stoppedByParent || record.view.state === "stopping"));

const completionForSettlement = (
  record: RunRecord,
  state: "completed" | "failed",
  generation: number,
  warning: string | undefined,
  error: string | undefined,
): CompletionGenerationRecord => ({
  generation,
  outcome: state,
  ...(state === "completed" &&
    record.latestAssistantText && { finalText: record.latestAssistantText }),
  ...(state === "failed" && { error: error ?? "Run failed." }),
  ...(warning && { warning }),
  retained: false,
});

const viewForSettlement = (
  record: RunRecord,
  state: SettlementState,
  now: number,
  completionGeneration: number,
  error: string | undefined,
): SubagentRunView => {
  const base: SubagentRunView = {
    ...record.view,
    state,
    endedAt: now,
    lastActivityAt: now,
    currentTool: undefined,
    question: undefined,
    ...(state === "completed" && { reportGeneration: completionGeneration }),
  };
  const completed =
    state === "completed" && record.latestAssistantText
      ? { ...base, finalText: record.latestAssistantText }
      : base;
  const settledError = state === "failed" ? (error ?? "Run failed.") : error;
  return settledError === undefined ? completed : { ...completed, error: settledError };
};

/**
 * Owns event-driven view mutation, pause commits, terminal settlement, backend
 * report validation, and assignment activation replay.
 * `settle` performs one locked transaction covering completion insertion and
 * wakeup, question invalidation, warning folding, pause completion, projection,
 * deferred initialization, and idempotence. Peer notification stays outside.
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
        clearRunNativeActivity(record);
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

  const settle = (record: RunRecord, state: SettlementState, error?: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* withLock(
        Effect.gen(function* () {
          if (settlementBlocked(record, state))
            return { transitioned: false as const, view: snapshotView(record.view) };
          if (record.initializationPending && state !== "stopped") {
            record.pendingInitializationSettlement = {
              state,
              ...(error && { error }),
            };
            return {
              transitioned: false as const,
              deferredInitialization: true as const,
              view: snapshotView(record.view),
            };
          }
          const pauseOutcome = record.pauseOutcome;
          const completedScope =
            state === "completed" && record.process !== undefined ? record.scope : undefined;
          if (completedScope) record.cleanupPending = true;
          record.pauseOutcome = undefined;
          record.pauseRequested = false;
          record.activeTools.clear();
          clearRunNativeActivity(record);
          const hasDeliverableOutcome = state === "completed" || state === "failed";
          const recordDeliverableOutcome =
            hasDeliverableOutcome &&
            record.completionGenerations.size < MAX_UNRESOLVED_REPORT_GENERATIONS;
          const completionGeneration = recordDeliverableOutcome
            ? ++record.completionGeneration
            : record.completionGeneration;
          const completionWarning = foldRunWarnings(record.warningSlots);
          if (recordDeliverableOutcome)
            delivery.insertCompletionLocked(
              record,
              completionForSettlement(
                record,
                state,
                completionGeneration,
                completionWarning,
                error,
              ),
            );
          record.notificationGeneration += 1;
          delivery.discardQuestionLocked(record.view.id);
          record.replyPendingRequestId = undefined;
          if (state === "completed") record.assignment.phase = "reported";
          record.view = viewForSettlement(record, state, now, completionGeneration, error);
          yield* publish;
          const view = snapshotView(record.view);
          if (pauseOutcome) Deferred.doneUnsafe(pauseOutcome, Effect.succeed(view));
          return {
            transitioned: true as const,
            view,
            completedScope,
          };
        }),
      );
      const view = result.view;
      if (!result.transitioned) return view;
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

  const rejectReportLocked = (record: RunRecord, reason: string, now: number): SubagentRunView => {
    const warning = sanitizeDiagnosticText(
      `Rejected protocol-invalid backend report: ${reason}`,
      MAX_ERROR_CHARS,
    );
    record.warningSlots = setRunWarning(record.warningSlots, "system", warning);
    record.view = {
      ...record.view,
      warning,
      sessionEvents: appendNoticeSessionEvent(record.view.sessionEvents, "warning", warning, now),
    };
    return snapshotView(record.view);
  };

  const rejectReportAndPublishLocked = (record: RunRecord, reason: string, now: number) =>
    Effect.gen(function* () {
      const view = rejectReportLocked(record, reason, now);
      yield* publish;
      return { kind: "unchanged" as const, view };
    });

  const reportPairStatus = (record: RunRecord, report: BackendReport) => {
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
  ): SubagentRunView => {
    const pauseOutcome = record.pauseOutcome;
    record.pauseOutcome = undefined;
    record.pauseRequested = false;
    record.activeTools.clear();
    clearRunNativeActivity(record);
    const recordsCompletion = record.completionGenerations.size < MAX_UNRESOLVED_REPORT_GENERATIONS;
    const generation = recordsCompletion
      ? ++record.completionGeneration
      : record.completionGeneration;
    const text = report.text;
    const completionWarning = foldRunWarnings(record.warningSlots);
    if (recordsCompletion)
      delivery.insertCompletionLocked(record, {
        generation,
        outcome: "completed" as const,
        ...(text && { finalText: text }),
        ...(completionWarning && { warning: completionWarning }),
        retained: true,
      });
    record.notificationGeneration += 1;
    delivery.discardQuestionLocked(record.view.id);
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
    const view = snapshotView(record.view);
    if (pauseOutcome) Deferred.doneUnsafe(pauseOutcome, Effect.succeed(view));
    return view;
  };

  const finishRetainedReport = (record: RunRecord, view: SubagentRunView) =>
    sendPeerNotices(record.view.id).pipe(Effect.as(view));

  const acceptValidatedBackendReport = (record: RunRecord, report: BackendReport) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const decision = yield* withLock(
        Effect.gen(function* () {
          if (record.assignment.epoch !== report.assignmentEpoch)
            return { kind: "unchanged" as const, view: snapshotView(record.view) };
          const pair = reportPairStatus(record, report);
          if (pair === "exact-retry")
            return { kind: "unchanged" as const, view: snapshotView(record.view) };
          if (pair === "invalid")
            return yield* rejectReportAndPublishLocked(
              record,
              `sequence ${report.sequence} reused delivery identity ${report.deliveryId}.`,
              now,
            );
          if (record.assignment.phase === "issuing") {
            const pending = record.assignment.pendingReport;
            if (
              pending &&
              (pending.sequence !== report.sequence || pending.deliveryId !== report.deliveryId)
            )
              return yield* rejectReportAndPublishLocked(
                record,
                `assignment ${report.assignmentEpoch} produced more than one in-flight report.`,
                now,
              );
            if (!pending) record.assignment.pendingReport = report;
            return { kind: "buffered" as const, view: snapshotView(record.view) };
          }
          if (record.assignment.phase !== "running")
            return yield* rejectReportAndPublishLocked(
              record,
              `sequence ${report.sequence} arrived while assignment ${report.assignmentEpoch} was ${record.assignment.phase}.`,
              now,
            );
          if (record.view.closeOnReport !== false) return { kind: "close" as const, report };
          const result = commitRetainedReportLocked(record, report, now);
          yield* publish;
          return { kind: "retained" as const, result };
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

  const activateAssignmentLocked = (
    record: RunRecord,
    now: number,
    runningView: SubagentRunView,
  ): Effect.Effect<AssignmentActivationReplay> =>
    Effect.gen(function* () {
      const pendingReport = record.assignment.pendingReport;
      const pendingRunSettled = record.assignment.pendingRunSettled;
      record.assignment.phase = "running";
      record.assignment.pendingReport = undefined;
      record.assignment.pendingRunSettled = false;
      const replay: AssignmentActivationReplay =
        pendingReport && record.view.closeOnReport === false
          ? {
              kind: "retained-report",
              view: commitRetainedReportLocked(record, pendingReport, now),
            }
          : (() => {
              record.view = runningView;
              if (pendingReport) return { kind: "close-report" as const, report: pendingReport };
              if (pendingRunSettled) return { kind: "settlement" as const };
              return { kind: "running" as const, view: snapshotView(record.view) };
            })();
      yield* publish;
      return replay;
    });

  const replayAssignmentActivation = (
    record: RunRecord,
    replay: AssignmentActivationReplay,
  ): Effect.Effect<SubagentRunView> => {
    switch (replay.kind) {
      case "retained-report":
        return finishRetainedReport(record, replay.view);
      case "close-report":
        return acceptValidatedBackendReport(record, replay.report);
      case "settlement":
        return settle(record, "completed");
      case "running":
        return Effect.succeed(replay.view);
    }
  };

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
      return yield* acceptValidatedBackendReport(record, {
        ...rawReport,
        deliveryId: rawReport.deliveryId.trim(),
        ...(rawReport.text
          ? { text: sanitizeOutputText(rawReport.text, MAX_BACKEND_REPORT_TEXT_CHARS) }
          : { text: undefined }),
      });
    });

  const runStartedFromBackend = (record: RunRecord, assignmentEpoch: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const replay = yield* withLock(
        Effect.gen(function* () {
          if (
            record.assignment.epoch !== assignmentEpoch ||
            record.assignment.phase === "preparing" ||
            record.assignment.phase === "reported" ||
            isInactiveRunRecord(record)
          )
            return undefined;
          record.assignment.startedObserved = true;
          if (record.assignment.phase === "issuing" && !record.assignment.outcomeUncertain) {
            record.pausedAssignmentEpoch = undefined;
            record.view = {
              ...record.view,
              state: "running",
              endedAt: undefined,
              error: undefined,
              lastActivityAt: now,
            };
            yield* publish;
            return undefined;
          }
          record.pausedAssignmentEpoch = undefined;
          return yield* activateAssignmentLocked(record, now, {
            ...record.view,
            state: "running",
            endedAt: undefined,
            error: undefined,
            lastActivityAt: now,
          });
        }),
      );
      if (replay) yield* replayAssignmentActivation(record, replay);
    });

  const runSettledFromBackend = (record: RunRecord, assignmentEpoch: number) =>
    Effect.gen(function* () {
      if (record.view.closeOnReport === false) return;
      const phase = yield* withLock(
        Effect.sync(() => {
          if (
            record.assignment.epoch !== assignmentEpoch ||
            record.pausedAssignmentEpoch === assignmentEpoch ||
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

  return {
    /** Locked epoch/phase-guarded view mutation for assignment-scoped events. */
    mutateEventView,
    /** Locked exact-epoch usage merge for results arriving after report settlement. */
    mergeLateUsage,
    failPendingResponses,
    /** One locked idempotent terminal transaction plus post-commit peer notification. */
    settle,
    /** Marks cleanup, cancels pending responses, force-terminates, then settles failed. */
    failRun,
    activateAssignmentLocked,
    replayAssignmentActivation,
    acceptBackendReport,
    runStartedFromBackend,
    runSettledFromBackend,
  };
}
