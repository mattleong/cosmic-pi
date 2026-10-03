import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  MAX_BACKEND_REPORT_EVIDENCE_CHARS,
  MAX_BACKEND_REPORT_ID_CHARS,
  MAX_BACKEND_REPORT_TEXT_CHARS,
  type BackendAssistantTerminal,
  type BackendHandle,
  type BackendReport,
} from "../backend/model.ts";
import { canonicalResultJson, decodeResultText } from "../domain/result-contract.ts";
import { type SubagentError, SubagentProcessError } from "./errors.ts";
import {
  clearRunNativeActivity,
  commitRunPauseLocked,
  isInactiveRunRecord,
  type CompletionGenerationRecord,
  type RunContext,
  type RunRecord,
} from "./internal.ts";
import { isTerminalRunState, type SubagentRunView, type SubagentUsage } from "./model.ts";
import { MAX_UNRESOLVED_REPORT_GENERATIONS } from "./limits.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import type { RunRecordCleanup } from "./record-cleanup.ts";
import {
  addUsage,
  MAX_ERROR_CHARS,
  sanitizeDiagnosticText,
  sanitizeOutputText,
  snapshotView,
} from "./state.ts";
import { foldRunWarnings, recordRunWarning } from "./warnings.ts";

export interface RunSettlementDependencies extends RunContext {
  readonly delivery: RunNotificationDelivery;
  readonly closeRecordScope: RunRecordCleanup["closeRecordScope"];
}

export type AssignmentActivationReplay =
  | { readonly kind: "running"; readonly view: SubagentRunView }
  | { readonly kind: "retained-report"; readonly view: SubagentRunView }
  | { readonly kind: "close-report"; readonly report: BackendReport }
  | {
      readonly kind: "settlement";
      readonly assignmentEpoch: number;
      readonly terminal?: BackendAssistantTerminal | undefined;
    };

type SettlementState = "completed" | "failed" | "stopped";

const terminalFailureMessage = (terminal?: BackendAssistantTerminal): string => {
  switch (terminal?.stopReason) {
    case "error":
      return `Final provider error: ${terminal.errorMessage || "provider returned no diagnostic"}`;
    case "aborted":
      return "Assignment aborted without a parent stop or correlated pause.";
    case "length":
      return "Assignment reached its output limit without a successful final report.";
    case "toolUse":
      return "Assignment settled after tool use without a final report.";
    default:
      return "Assignment settled without a successful nonempty final report.";
  }
};

/** The contract value accepted for this assignment; it completes the assignment once settled. */
const acceptedResult = (record: RunRecord, assignmentEpoch: number): string | undefined =>
  record.structuredResult?.assignmentEpoch === assignmentEpoch
    ? record.structuredResult.json
    : undefined;

/**
 * How a settled assignment proceeds; caller holds the run lock. A pause committed for the
 * assignment ignores the settlement unless a result was already accepted, which outlives the pause.
 */
const settledAssignmentLocked = (
  record: RunRecord,
  assignmentEpoch: number,
  terminal: BackendAssistantTerminal | undefined,
): "ignored" | "buffered" | "running" => {
  if (
    record.assignment.epoch !== assignmentEpoch ||
    (record.pausedAssignmentEpoch === assignmentEpoch &&
      acceptedResult(record, assignmentEpoch) === undefined) ||
    record.assignment.phase === "preparing" ||
    record.assignment.phase === "reported" ||
    isInactiveRunRecord(record)
  )
    return "ignored";
  if (record.assignment.phase === "issuing") {
    record.assignment.pendingRunSettled = { terminal };
    return "buffered";
  }
  return "running";
};

/** Text a settled assignment wrote: its report, or a contract result written as JSON text. */
const settledText = (record: RunRecord, terminal?: BackendAssistantTerminal) =>
  Effect.gen(function* () {
    const text =
      terminal?.stopReason === "stop" && terminal.text
        ? sanitizeOutputText(terminal.text, MAX_BACKEND_REPORT_TEXT_CHARS).trim()
        : undefined;
    const contract = record.launch.resultContract;
    if (!contract || !text) return { text, problem: undefined };
    const decoded = yield* Effect.result(decodeResultText(contract, text));
    return Result.isSuccess(decoded)
      ? { text: canonicalResultJson(decoded.success), problem: undefined }
      : { text: undefined, problem: decoded.failure.message };
  });

const settledFailureMessage = (
  record: RunRecord,
  terminal: BackendAssistantTerminal | undefined,
  problem: string | undefined,
): string => {
  const reason =
    record.launch.resultContract && terminal?.stopReason === "stop"
      ? problem
        ? `Assignment finished without submitting its structured result, and its final text is not a valid result: ${problem}`
        : "Assignment finished without submitting its structured result."
      : terminalFailureMessage(terminal);
  return `${reason} Work and writes may already exist; inspect them before an explicit retry.`;
};

/** A backend report as the run's final text; a contract run's report must be its JSON result. */
const reportFinalText = (record: RunRecord, text: string) => {
  const contract = record.launch.resultContract;
  if (!contract)
    return Effect.succeed(sanitizeOutputText(text, MAX_BACKEND_REPORT_TEXT_CHARS).trim());
  return decodeResultText(contract, text).pipe(
    Effect.mapBoth({
      onFailure: (error) =>
        new SubagentProcessError({
          operation: "accept report from",
          code: "backend_report_schema_invalid",
          message: sanitizeDiagnosticText(
            `Subagent ${record.view.id} reported a result that does not match its schema: ${error.message}`,
            MAX_ERROR_CHARS,
          ),
        }),
      onSuccess: canonicalResultJson,
    }),
  );
};

const settlementBlocked = (record: RunRecord, state: SettlementState): boolean =>
  isTerminalRunState(record.view.state) ||
  (state !== "stopped" && (record.stoppedByParent || record.view.state === "stopping"));

/** A completion outcome before assignment close allocates its generation and folds warnings. */
type CompletionOutcome = Omit<CompletionGenerationRecord, "generation" | "warning">;

const completionForSettlement = (
  record: RunRecord,
  state: "completed" | "failed",
  error: string | undefined,
): CompletionOutcome => ({
  outcome: state,
  ...(state === "completed" &&
    record.latestAssistantText && { finalText: record.latestAssistantText }),
  ...(state === "failed" && { error: error ?? "Run failed." }),
  retained: false,
});

const viewForSettlement = (
  record: RunRecord,
  state: SettlementState,
  now: number,
  error: string | undefined,
): SubagentRunView => {
  const base: SubagentRunView = {
    ...record.view,
    state,
    endedAt: now,
    lastActivityAt: now,
    currentTool: undefined,
    question: undefined,
    ...(record.view.steeringDelivery === "pending" && {
      steeringDelivery:
        state === "completed" ? ("report-unconfirmed" as const) : ("unresolved" as const),
    }),
    ...(state === "completed" && { reportGeneration: record.completionGeneration }),
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
   * outcome of the same assignment may absorb it; idle retained, stopped,
   * failed, and parent-stopped records ignore late assistant usage.
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
  // Native session stats describe process/run work, including idle cache warming.
  // Assignment changes do not reset run totals. Check process ownership under the mutation lock.
  const mergeProcessUsage = (
    record: RunRecord,
    source: BackendHandle | undefined,
    usage: SubagentUsage,
  ) =>
    withLock(
      Effect.gen(function* () {
        if (
          !source ||
          record.process !== source ||
          record.stoppedByParent ||
          record.view.state === "stopping" ||
          record.view.state === "stopped" ||
          record.view.state === "failed"
        )
          return;
        const merged = addUsage(record.view.usage, usage);
        if (merged === record.view.usage) return;
        record.view = { ...record.view, usage: merged };
        yield* publish;
      }),
    );

  /** Commits a requested pause at settlement, unless the assignment already returned its result. */
  const pauseFromEvent = (record: RunRecord, now: number, assignmentEpoch: number) =>
    withLock(
      Effect.gen(function* () {
        if (
          !record.pauseRequested ||
          isInactiveRunRecord(record) ||
          record.assignment.epoch !== assignmentEpoch ||
          record.assignment.phase !== "running" ||
          acceptedResult(record, assignmentEpoch) !== undefined
        )
          return undefined;
        const view = commitRunPauseLocked(record, now);
        const outcome = record.pauseOutcome;
        record.pauseOutcome = undefined;
        yield* publish;
        if (outcome) Deferred.doneUnsafe(outcome, Effect.succeed(view));
        return view;
      }),
    );
  /** Locked assignment close shared by settle and retained reports; returns the pause waiter. */
  const closeAssignmentLocked = (record: RunRecord, outcome: CompletionOutcome | undefined) => {
    const pauseOutcome = record.pauseOutcome;
    record.pauseOutcome = undefined;
    record.pauseRequested = false;
    record.activeTools.clear();
    clearRunNativeActivity(record);
    if (outcome && record.completionGenerations.size < MAX_UNRESOLVED_REPORT_GENERATIONS) {
      const warning = foldRunWarnings(record.warningSlots);
      delivery.insertCompletionLocked(record, {
        ...outcome,
        generation: ++record.completionGeneration,
        ...(warning && { warning }),
      });
    }
    record.notificationGeneration += 1;
    delivery.discardQuestionLocked(record.view.id);
    record.replyPendingRequestId = undefined;
    return pauseOutcome;
  };

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
          const completedScope =
            state === "completed" && record.process !== undefined ? record.scope : undefined;
          if (completedScope) record.cleanupPending = true;
          const pauseOutcome = closeAssignmentLocked(
            record,
            state === "stopped" ? undefined : completionForSettlement(record, state, error),
          );
          if (state === "completed") record.assignment.phase = "reported";
          record.view = viewForSettlement(record, state, now, error);
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
        record.backendFailure ??=
          pendingError ?? new SubagentProcessError({ operation: "run", message: diagnostic });
        if (
          pendingError?._tag === "SubagentProcessError" &&
          pendingError.code === "steer_outcome_uncertain" &&
          !pendingError.pendingDelivery
        )
          record.view = { ...record.view, steeringDelivery: "unresolved" };
        record.process?.cancelPending(
          pendingError ?? new SubagentProcessError({ operation: "run", message: diagnostic }),
        );
        return true;
      }),
    ).pipe(
      Effect.flatMap((shouldFail) => {
        if (!shouldFail) return Effect.succeed(snapshotView(record.view));
        const primaryDiagnostic = sanitizeDiagnosticText(
          record.backendFailure?.message ?? diagnostic,
          MAX_ERROR_CHARS,
        );
        if (record.initializationPending) return settle(record, "failed", primaryDiagnostic);
        return (
          record.process ? record.process.terminate("force").pipe(Effect.ignore) : Effect.void
        ).pipe(Effect.andThen(settle(record, "failed", primaryDiagnostic)));
      }),
    );
  };

  const rejectReportAndPublishLocked = (record: RunRecord, reason: string, now: number) =>
    Effect.gen(function* () {
      const warning = sanitizeDiagnosticText(
        `Rejected protocol-invalid backend report: ${reason}`,
        MAX_ERROR_CHARS,
      );
      record.view = {
        ...record.view,
        ...recordRunWarning(record, record.view.sessionEvents, "system", warning, now),
      };
      const view = snapshotView(record.view);
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
    const text = report.text;
    const pauseOutcome = closeAssignmentLocked(record, {
      outcome: "completed",
      ...(text && { finalText: text }),
      retained: true,
    });
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
      reportGeneration: record.completionGeneration,
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
          if (isInactiveRunRecord(record) || record.assignment.epoch !== report.assignmentEpoch)
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
            isInactiveRunRecord(record) ||
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
              if (pendingRunSettled)
                return {
                  kind: "settlement" as const,
                  assignmentEpoch: record.assignment.epoch,
                  terminal: pendingRunSettled.terminal,
                };
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
        return runSettledFromBackend(record, replay.assignmentEpoch, replay.terminal).pipe(
          Effect.map(() => snapshotView(record.view)),
        );
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
        !rawReport.text?.trim() ||
        rawReport.text.length > MAX_BACKEND_REPORT_TEXT_CHARS
      )
        return yield* new SubagentProcessError({
          operation: "accept report from",
          code: "backend_report_invalid",
          message: `Subagent ${record.view.id} emitted an invalid bounded report event.`,
        });
      const text = yield* reportFinalText(record, rawReport.text);
      if (!text)
        return yield* new SubagentProcessError({
          operation: "accept report from",
          code: "backend_report_empty",
          message: `Subagent ${record.view.id} submitted an empty report.`,
        });
      return yield* acceptValidatedBackendReport(record, {
        ...rawReport,
        deliveryId: rawReport.deliveryId.trim(),
        text,
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
          record.pausedAssignmentEpoch = undefined;
          const running: SubagentRunView = {
            ...record.view,
            state: "running",
            endedAt: undefined,
            error: undefined,
            lastActivityAt: now,
          };
          if (record.assignment.phase === "issuing" && !record.assignment.outcomeUncertain) {
            record.view = running;
            yield* publish;
            return undefined;
          }
          return yield* activateAssignmentLocked(record, now, running);
        }),
      );
      if (replay) yield* replayAssignmentActivation(record, replay);
    });

  const runSettledFromBackend = (
    record: RunRecord,
    assignmentEpoch: number,
    terminal?: BackendAssistantTerminal,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (record.view.closeOnReport === false) return;
      const phase = yield* withLock(
        Effect.sync(() => settledAssignmentLocked(record, assignmentEpoch, terminal)),
      );
      if (phase !== "running") return;
      if (record.pauseRequested) {
        const now = yield* Clock.currentTimeMillis;
        const paused = yield* pauseFromEvent(record, now, assignmentEpoch);
        if (paused || record.stoppedByParent) return;
      }
      if (record.stoppedByParent) return;
      // Settled text is decoded only when no value was accepted; it could not replace one.
      const written =
        acceptedResult(record, assignmentEpoch) === undefined
          ? yield* settledText(record, terminal)
          : { text: undefined, problem: undefined };
      const outcome = yield* withLock(
        Effect.sync(() => {
          // An accepted contract result completes the run even after tool use, a later turn, or
          // a pause that raced its settlement.
          const finalText = acceptedResult(record, assignmentEpoch) ?? written.text;
          if (!finalText) return "failed";
          if (
            isInactiveRunRecord(record) ||
            record.assignment.epoch !== assignmentEpoch ||
            record.assignment.phase !== "running"
          )
            return "ignored";
          record.latestAssistantText = finalText;
          record.pausedAssignmentEpoch = undefined;
          return "completed";
        }),
      );
      if (outcome === "completed") yield* settle(record, "completed");
      if (outcome === "failed")
        yield* failRun(record, settledFailureMessage(record, terminal, written.problem));
    });

  return {
    /** Locked epoch/phase-guarded view mutation for assignment-scoped events. */
    mutateEventView,
    /** Locked exact-epoch usage merge for results arriving after report settlement. */
    mergeLateUsage,
    mergeProcessUsage,
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

export type RunSettlement = ReturnType<typeof makeRunSettlement>;
