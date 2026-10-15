import { absurd } from "effect/Function";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import {
  MAX_BACKEND_REPORT_EVIDENCE_CHARS,
  MAX_BACKEND_REPORT_ID_CHARS,
  MAX_BACKEND_REPORT_TEXT_CHARS,
  type BackendAssistantTerminal,
  type BackendHandle,
  type BackendReport,
} from "../backend/model.ts";
import { processError, type SubagentError, SubagentProcessError } from "./errors.ts";
import {
  clearRunActivity,
  commitRunPauseLocked,
  isInactiveRunRecord,
  type RunContext,
  type RunRecord,
} from "./internal.ts";
import type { SubagentRunView, SubagentUsage } from "./model.ts";
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
import {
  settledAssignmentLocked,
  settledFailureMessage,
  settlementBlocked,
  viewForSettlement,
  type SettlementState,
} from "./settlement-outcome.ts";
import { foldRunWarnings, recordRunWarning } from "./warnings.ts";

export interface RunSettlementDependencies extends Pick<
  RunContext,
  "ownerScope" | "withLock" | "publish" | "sendPeerNotices"
> {
  readonly delivery: RunNotificationDelivery;
  readonly closeRecordScope: RunRecordCleanup["closeRecordScope"];
  readonly claimTurnInputDrain: (record: RunRecord, drained: Deferred.Deferred<void>) => void;
}

export type AssignmentActivationReplay =
  | { readonly kind: "running"; readonly view: SubagentRunView }
  | { readonly kind: "close-report"; readonly report: BackendReport }
  | {
      readonly kind: "settlement";
      readonly assignmentEpoch: number;
      readonly terminal?: BackendAssistantTerminal | undefined;
    };

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

export function settlementOperations(dependencies: RunSettlementDependencies) {
  const {
    ownerScope,
    withLock,
    publish,
    delivery,
    closeRecordScope,
    sendPeerNotices,
    claimTurnInputDrain,
  } = dependencies;

  const mergeUsageLocked = (record: RunRecord, usage: SubagentUsage) => {
    const merged = addUsage(record.view.usage, usage);
    if (merged === record.view.usage) return Effect.void;
    record.view = { ...record.view, usage: merged };
    return publish;
  };

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
  const mergeLateUsage = (record: RunRecord, assignmentEpoch: number, usage: SubagentUsage) =>
    withLock(
      Effect.gen(function* () {
        if (
          record.stoppedByParent ||
          record.assignment.epoch !== assignmentEpoch ||
          record.view.state !== "completed"
        )
          return;
        yield* mergeUsageLocked(record, usage);
      }),
    );
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
        yield* mergeUsageLocked(record, usage);
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
        const view = commitRunPauseLocked(record, now);
        const outcome = record.pauseOutcome;
        record.pauseOutcome = undefined;
        yield* publish;
        if (outcome) Deferred.doneUnsafe(outcome, Effect.succeed(view));
        return view;
      }),
    );
  const queueCompletionLocked = (
    record: RunRecord,
    state: SettlementState,
    finalText: string | undefined,
    settledError: string | undefined,
  ) => {
    if (
      state === "stopped" ||
      record.completionGenerations.size >= MAX_UNRESOLVED_REPORT_GENERATIONS
    )
      return;
    const warning = foldRunWarnings(record.warningSlots);
    delivery.insertCompletionLocked(record, {
      outcome: state,
      ...(finalText && { finalText }),
      ...(state === "failed" && { error: settledError }),
      generation: ++record.completionGeneration,
      ...(warning && { warning }),
    });
  };

  const settle = (
    record: RunRecord,
    state: SettlementState,
    error?: string,
    assignmentEpoch?: number,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* withLock(
        Effect.gen(function* () {
          if (
            settlementBlocked(record, state) ||
            (assignmentEpoch !== undefined && record.assignment.epoch !== assignmentEpoch)
          )
            return { transitioned: false as const, view: snapshotView(record.view) };
          if (record.initializationPending && state !== "stopped") {
            record.pendingInitializationSettlement = { state, ...(error && { error }) };
            return { transitioned: false as const, view: snapshotView(record.view) };
          }
          const completedScope =
            state === "completed" && record.process !== undefined ? record.scope : undefined;
          if (completedScope) record.cleanupPending = true;
          const pauseOutcome = record.pauseOutcome;
          record.pauseOutcome = undefined;
          record.pauseRequested = false;
          clearRunActivity(record);
          const finalText = state === "completed" ? record.latestAssistantText : undefined;
          const settledError = state === "failed" ? (error ?? "Run failed.") : error;
          queueCompletionLocked(record, state, finalText, settledError);
          record.notificationGeneration += 1;
          delivery.discardQuestionLocked(record.view.id);
          record.replyPendingRequestId = undefined;
          if (state === "completed") record.assignment.phase = "reported";
          record.view = viewForSettlement(record, state, now, finalText, settledError);
          yield* publish;
          const view = snapshotView(record.view);
          if (pauseOutcome) Deferred.doneUnsafe(pauseOutcome, Effect.succeed(view));
          return { transitioned: true as const, view, completedScope };
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

  const failRun = (
    record: RunRecord,
    message: string,
    pendingError?: SubagentError,
    assignmentEpoch?: number,
  ) => {
    const diagnostic = sanitizeDiagnosticText(message, MAX_ERROR_CHARS);
    return withLock(
      Effect.sync(() => {
        if (
          isInactiveRunRecord(record) ||
          (assignmentEpoch !== undefined && record.assignment.epoch !== assignmentEpoch)
        )
          return false;
        const failure =
          pendingError ?? new SubagentProcessError({ operation: "run", message: diagnostic });
        record.cleanupPending = true;
        record.backendFailure ??= failure;
        if (
          pendingError?._tag === "SubagentProcessError" &&
          pendingError.code === "steer_outcome_uncertain" &&
          !pendingError.pendingDelivery
        )
          record.view = { ...record.view, steeringDelivery: "unresolved" };
        record.process?.cancelPending(failure);
        return true;
      }),
    ).pipe(
      Effect.flatMap((shouldFail) => {
        if (!shouldFail) return Effect.succeed(snapshotView(record.view));
        const primaryDiagnostic = sanitizeDiagnosticText(
          record.backendFailure?.message ?? diagnostic,
          MAX_ERROR_CHARS,
        );
        if (record.initializationPending)
          return settle(record, "failed", primaryDiagnostic, assignmentEpoch);
        return (
          record.process ? record.process.terminate("force").pipe(Effect.ignore) : Effect.void
        ).pipe(Effect.andThen(settle(record, "failed", primaryDiagnostic, assignmentEpoch)));
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
          return { kind: "close" as const, report };
        }),
      );
      if (decision.kind !== "close") return decision.view;

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
      const completed = yield* settle(
        record,
        "completed",
        undefined,
        decision.report.assignmentEpoch,
      );
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
    runningView: SubagentRunView,
  ): Effect.Effect<AssignmentActivationReplay> =>
    Effect.suspend(() => {
      const pendingReport = record.assignment.pendingReport;
      const pendingRunSettled = record.assignment.pendingRunSettled;
      record.assignment.phase = "running";
      record.assignment.pendingReport = undefined;
      record.assignment.pendingRunSettled = false;
      record.view = runningView;
      const replay: AssignmentActivationReplay = pendingReport
        ? { kind: "close-report", report: pendingReport }
        : pendingRunSettled
          ? {
              kind: "settlement",
              assignmentEpoch: record.assignment.epoch,
              terminal: pendingRunSettled.terminal,
            }
          : { kind: "running", view: snapshotView(record.view) };
      return publish.pipe(Effect.as(replay));
    });

  const replayAssignmentActivation = (
    record: RunRecord,
    replay: AssignmentActivationReplay,
  ): Effect.Effect<SubagentRunView> => {
    switch (replay.kind) {
      case "close-report":
        return acceptValidatedBackendReport(record, replay.report);
      case "settlement":
        return runSettledFromBackend(record, replay.assignmentEpoch, replay.terminal).pipe(
          Effect.map(() => snapshotView(record.view)),
        );
      case "running":
        return Effect.succeed(replay.view);
    }
    return absurd(replay);
  };

  const acceptBackendReport = (record: RunRecord, rawReport: BackendReport) =>
    Effect.gen(function* () {
      const current = yield* withLock(
        Effect.sync(
          () =>
            !isInactiveRunRecord(record) && record.assignment.epoch === rawReport.assignmentEpoch,
        ),
      );
      if (!current) return snapshotView(record.view);
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
        return yield* processError(
          "accept report from",
          "backend_report_invalid",
          `Subagent ${record.view.id} emitted an invalid bounded report event.`,
        );
      const text = sanitizeOutputText(rawReport.text, MAX_BACKEND_REPORT_TEXT_CHARS).trim();
      if (!text)
        return yield* processError(
          "accept report from",
          "backend_report_empty",
          `Subagent ${record.view.id} submitted an empty report.`,
        );
      return yield* acceptValidatedBackendReport(record, {
        ...rawReport,
        deliveryId: rawReport.deliveryId.trim(),
        text,
      });
    }).pipe(
      Effect.catch((error) =>
        withLock(
          Effect.suspend(() =>
            isInactiveRunRecord(record) || record.assignment.epoch !== rawReport.assignmentEpoch
              ? Effect.succeed(snapshotView(record.view))
              : Effect.fail(error),
          ),
        ),
      ),
    );

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
          return yield* activateAssignmentLocked(record, running);
        }),
      );
      if (replay) yield* replayAssignmentActivation(record, replay);
    });

  const runSettledFromBackend = (
    record: RunRecord,
    assignmentEpoch: number,
    terminal?: BackendAssistantTerminal,
    isCurrent: () => boolean = () => true,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const phase = yield* withLock(
        Effect.sync(() => settledAssignmentLocked(record, assignmentEpoch, terminal)),
      );
      if (phase !== "running") return;
      // Guidance or a descendant notice admitted before this settlement may restart the child.
      const turnInputsDrained = yield* Deferred.make<void>();
      yield* withLock(Effect.sync(() => claimTurnInputDrain(record, turnInputsDrained)));
      yield* Deferred.await(turnInputsDrained);
      if (!isCurrent()) return;
      if (record.pauseRequested) {
        const now = yield* Clock.currentTimeMillis;
        if (yield* pauseFromEvent(record, now, assignmentEpoch)) return;
      }
      if (record.stoppedByParent) return;
      const finalText =
        terminal?.stopReason === "stop" && terminal.text
          ? sanitizeOutputText(terminal.text, MAX_BACKEND_REPORT_TEXT_CHARS).trim()
          : undefined;
      const outcome = yield* withLock(
        Effect.sync(() => {
          if (
            isInactiveRunRecord(record) ||
            record.assignment.epoch !== assignmentEpoch ||
            record.assignment.phase !== "running"
          )
            return "ignored";
          if (!finalText) return "failed";
          record.latestAssistantText = finalText;
          record.pausedAssignmentEpoch = undefined;
          return "completed";
        }),
      );
      if (outcome === "completed") yield* settle(record, "completed", undefined, assignmentEpoch);
      if (outcome === "failed")
        yield* failRun(record, settledFailureMessage(terminal), undefined, assignmentEpoch);
    });

  return {
    mutateEventView,
    mergeLateUsage,
    mergeProcessUsage,
    settle,
    failRun,
    activateAssignmentLocked,
    replayAssignmentActivation,
    acceptBackendReport,
    runStartedFromBackend,
    runSettledFromBackend,
  };
}

export type RunSettlement = ReturnType<typeof settlementOperations>;
