import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import {
  MAX_BACKEND_REPORT_EVIDENCE_CHARS,
  MAX_BACKEND_REPORT_ID_CHARS,
  MAX_BACKEND_REPORT_TEXT_CHARS,
  type BackendReport,
} from "../backend/model.ts";
import { SubagentProcessError } from "./errors.ts";
import { clearRunNativeActivity, isInactiveRunRecord, type RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import { MAX_UNRESOLVED_REPORT_GENERATIONS } from "./limits.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import {
  MAX_ERROR_CHARS,
  sanitizeDiagnosticText,
  sanitizeOutputText,
  snapshotView,
} from "./state.ts";
import { foldRunWarnings, setRunWarning } from "./warnings.ts";

export type AssignmentActivationReplay =
  | { readonly kind: "running"; readonly view: SubagentRunView }
  | { readonly kind: "retained-report"; readonly view: SubagentRunView }
  | { readonly kind: "close-report"; readonly report: BackendReport }
  | { readonly kind: "settlement" };

export interface RunReportLifecycleDependencies {
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly publish: Effect.Effect<void>;
  readonly delivery: RunNotificationDelivery;
  readonly settle: (
    record: RunRecord,
    state: "completed" | "failed" | "stopped",
    error?: string,
  ) => Effect.Effect<SubagentRunView>;
  readonly pauseFromEvent: (
    record: RunRecord,
    now: number,
    assignmentEpoch: number,
  ) => Effect.Effect<SubagentRunView | undefined>;
  readonly sendPeerNotices: (changedId: string) => Effect.Effect<void>;
}

/** Owns report validation, buffering, activation replay, and backend report transitions. */
export function makeRunReportLifecycle(dependencies: RunReportLifecycleDependencies) {
  const { withLock, publish, delivery, settle, pauseFromEvent, sendPeerNotices } = dependencies;

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
    activateAssignmentLocked,
    replayAssignmentActivation,
    acceptBackendReport,
    runStartedFromBackend,
    runSettledFromBackend,
  };
}
