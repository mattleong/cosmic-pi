import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { BackendReport } from "../backend/model.ts";
import { isOutcomeUncertain, type SubagentError, SubagentProcessError } from "./errors.ts";
import { isInactiveRunRecord, type RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import type { RetainedReportTransition } from "./report-lifecycle.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText, snapshotView } from "./state.ts";
import { setRunWarning } from "./warnings.ts";

export interface RunAssignmentDependencies {
  /** The shared service lock guarding every RunRecord mutation. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly publish: Effect.Effect<void>;
  /** Late-bound process-lifecycle prompt issuer; resolved at call time. */
  readonly startPrompt: (
    record: RunRecord,
    message: string,
    assignmentEpoch: number,
  ) => Effect.Effect<void, SubagentError>;
  readonly settle: (
    record: RunRecord,
    state: "completed" | "failed" | "stopped",
    error?: string,
  ) => Effect.Effect<SubagentRunView>;
  readonly commitRetainedReportLocked: (
    record: RunRecord,
    report: BackendReport,
    now: number,
  ) => RetainedReportTransition;
  readonly finishRetainedReport: (
    record: RunRecord,
    result: RetainedReportTransition,
  ) => Effect.Effect<SubagentRunView>;
  readonly acceptBackendReport: (
    record: RunRecord,
    rawReport: BackendReport,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
}

/**
 * Owns assignment issue confirmation and rollback: attempt-token/epoch-checked
 * prompt submission, definite-vs-uncertain outcome mapping, and uncertain
 * assignment retention with buffered report/settlement replay.
 */
export function makeRunAssignment(dependencies: RunAssignmentDependencies) {
  const {
    withLock,
    publish,
    startPrompt,
    settle,
    commitRetainedReportLocked,
    finishRetainedReport,
    acceptBackendReport,
  } = dependencies;

  const confirmIssuedAssignment = (record: RunRecord, attemptToken: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* withLock(
        Effect.gen(function* () {
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
          if (pendingReport && record.view.closeOnReport === false) {
            const report = commitRetainedReportLocked(record, pendingReport, now);
            yield* publish;
            return { kind: "report" as const, report };
          }
          record.view = {
            ...record.view,
            state: "running",
            endedAt: undefined,
            error: undefined,
            finalText: undefined,
            lastActivityAt: now,
          };
          yield* publish;
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
      Effect.tapError((error) =>
        error._tag === "SubagentProcessError" && isOutcomeUncertain(error)
          ? withLock(
              Effect.sync(() => {
                if (record.assignment.attemptToken === attemptToken)
                  record.assignment.outcomeUncertain = true;
              }),
            )
          : Effect.void,
      ),
      Effect.mapError((error) => {
        const outcomeUncertain = error._tag === "SubagentProcessError" && isOutcomeUncertain(error);
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
        Effect.gen(function* () {
          if (
            record.assignment.attemptToken !== attemptToken ||
            record.assignment.phase !== "issuing"
          )
            return { kind: "unchanged" as const };
          record.assignment.outcomeUncertain = true;
          const diagnostic = sanitizeDiagnosticText(warning, MAX_ERROR_CHARS);
          record.warningSlots = setRunWarning(record.warningSlots, "system", diagnostic);
          record.view = {
            ...record.view,
            warning: diagnostic,
            sessionEvents: appendNoticeSessionEvent(
              record.view.sessionEvents,
              "warning",
              diagnostic,
              now,
            ),
          };
          if (!record.assignment.startedObserved) {
            yield* publish;
            return { kind: "unchanged" as const };
          }
          const pendingReport = record.assignment.pendingReport;
          const pendingRunSettled = record.assignment.pendingRunSettled;
          record.assignment.pendingReport = undefined;
          record.assignment.pendingRunSettled = false;
          record.assignment.phase = "running";
          if (pendingReport && record.view.closeOnReport === false) {
            const report = commitRetainedReportLocked(record, pendingReport, now);
            yield* publish;
            return { kind: "report" as const, report };
          }
          record.view = {
            ...record.view,
            state: "running",
            endedAt: undefined,
            finalText: undefined,
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

  return {
    /** Records uncertain delivery, maps writer/resume recovery detail, then confirms the issued attempt. */
    submitPrompt,
    /** Retains an outcome-uncertain assignment and replays buffered start evidence. */
    retainUncertainAssignment,
  };
}

export type RunAssignment = ReturnType<typeof makeRunAssignment>;
