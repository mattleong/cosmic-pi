import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import {
  MAX_BACKEND_REPORT_EVIDENCE_CHARS,
  MAX_BACKEND_REPORT_ID_CHARS,
  MAX_BACKEND_REPORT_TEXT_CHARS,
  type BackendReport,
} from "../backend/model.ts";
import { type SubagentError, SubagentProcessError } from "./errors.ts";
import { isInactiveRunRecord, type RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import {
  MAX_ERROR_CHARS,
  sanitizeDiagnosticText,
  sanitizeOutputText,
  snapshotView,
} from "./state.ts";
import { foldRunWarnings, setRunWarning } from "./warnings.ts";

export type RetainedReportTransition = {
  readonly transitioned: true;
  readonly view: SubagentRunView;
  readonly settlement: Deferred.Deferred<SubagentRunView>;
  readonly pauseOutcome?: Deferred.Deferred<SubagentRunView, SubagentError> | undefined;
  readonly generation: number;
};

export interface RunReportLifecycleDependencies {
  /** The shared service lock guarding every RunRecord mutation. */
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
  /** Late-bound process-lifecycle peer notifier; resolved at call time. */
  readonly sendPeerNotices: (changedId: string) => Effect.Effect<void>;
}

/**
 * Owns the backend report lifecycle: sequence/deliveryId watermark validation,
 * pending report buffering during `issuing`, retained-report commits, and the
 * `run_started`/`run_settled` backend transitions. `commitRetainedReportLocked`
 * requires the caller to hold the service lock.
 */
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
    const completionWarning = foldRunWarnings(record.warningSlots);
    record.completionGenerations.set(
      generation,
      (() => {
        const objectPart3858_0 = { generation, outcome: "completed" as const };
        const objectPart3858_1 = text ? { ...objectPart3858_0, finalText: text } : objectPart3858_0;
        const objectPart3858_2 = completionWarning
          ? { ...objectPart3858_1, warning: completionWarning }
          : objectPart3858_1;
        const objectPart3858_3 = { ...objectPart3858_2, retained: true };
        return objectPart3858_3;
      })(),
    );
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
      yield* delivery.queueCompletion(record, result.generation);
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
        Effect.gen(function* () {
          if (record.assignment.epoch !== report.assignmentEpoch)
            return { kind: "unchanged" as const, view: snapshotView(record.view) };
          const pair = reportPairStatus(record, report);
          if (pair === "exact-retry")
            return { kind: "unchanged" as const, view: snapshotView(record.view) };
          if (pair === "invalid") {
            const view = rejectReportLocked(
              record,
              `sequence ${report.sequence} reused delivery identity ${report.deliveryId}.`,
              now,
            );
            yield* publish;
            return { kind: "unchanged" as const, view };
          }
          if (record.assignment.phase === "issuing") {
            const pending = record.assignment.pendingReport;
            if (
              pending &&
              (pending.sequence !== report.sequence || pending.deliveryId !== report.deliveryId)
            ) {
              const view = rejectReportLocked(
                record,
                `assignment ${report.assignmentEpoch} produced more than one in-flight report.`,
                now,
              );
              yield* publish;
              return { kind: "unchanged" as const, view };
            }
            if (!pending) record.assignment.pendingReport = report;
            return { kind: "buffered" as const, view: snapshotView(record.view) };
          }
          if (record.assignment.phase !== "running") {
            const view = rejectReportLocked(
              record,
              `sequence ${report.sequence} arrived while assignment ${report.assignmentEpoch} was ${record.assignment.phase}.`,
              now,
            );
            yield* publish;
            return { kind: "unchanged" as const, view };
          }
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

  const runStartedFromBackend = (record: RunRecord, assignmentEpoch: number) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* withLock(
        Effect.gen(function* () {
          if (
            record.assignment.epoch !== assignmentEpoch ||
            record.assignment.phase === "preparing" ||
            record.assignment.phase === "reported" ||
            isInactiveRunRecord(record)
          )
            return { kind: "unchanged" as const };
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
            return { kind: "unchanged" as const };
          }
          const pendingReport = record.assignment.pendingReport;
          const pendingRunSettled = record.assignment.pendingRunSettled;
          record.assignment.phase = "running";
          record.assignment.pendingReport = undefined;
          record.assignment.pendingRunSettled = false;
          if (pendingReport && record.view.closeOnReport === false) {
            const report = commitRetainedReportLocked(record, pendingReport, now);
            yield* publish;
            return { kind: "report" as const, report };
          }
          record.pausedAssignmentEpoch = undefined;
          record.view = {
            ...record.view,
            state: "running",
            endedAt: undefined,
            error: undefined,
            lastActivityAt: now,
          };
          yield* publish;
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
    /** Caller must hold the service lock; commits one retained report generation. */
    commitRetainedReportLocked,
    /** Post-commit settlement/pause resolution, outbox queueing, and peer notices. */
    finishRetainedReport,
    /** Serialized watermark-checked report acceptance, buffering, and completion. */
    acceptBackendReport,
    runStartedFromBackend,
    runSettledFromBackend,
  };
}

export type RunReportLifecycle = ReturnType<typeof makeRunReportLifecycle>;
