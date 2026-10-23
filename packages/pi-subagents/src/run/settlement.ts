import * as Fn from "effect/Function";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import {
  MAX_BACKEND_REPORT_EVIDENCE_CHARS,
  MAX_BACKEND_REPORT_ID_CHARS,
  MAX_BACKEND_REPORT_TEXT_CHARS,
  type BackendAssistantTerminal,
  type BackendHandle,
  type BackendReport,
} from "../backend/model.ts";
import type { ReportArchive, ReportArchiveEntry } from "../boundary/report-archive.ts";
import {
  PENDING_STEER_DELIVERY_CODE,
  processError,
  type SubagentError,
  SubagentProcessError,
} from "./errors.ts";
import {
  beginCleanup,
  clearRunActivity,
  commitRunPauseLocked,
  isInactiveRunRecord,
  recordLatestAssistantText,
  snapshotRun,
  type RunContext,
  type RunRecord,
  type StoredRunView,
} from "./internal.ts";
import type { SubagentReportArchive, SubagentRunView, SubagentUsage } from "./model.ts";
import {
  MAX_OUTCOME_PREVIEW_CHARS,
  MAX_UNRESOLVED_REPORT_GENERATIONS,
  REPORT_SAVE_DEADLINE_MILLIS,
} from "./limits.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import type { RunRecordCleanup } from "./record-cleanup.ts";
import {
  addUsage,
  captureOutputText,
  MAX_ERROR_CHARS,
  sanitizeDiagnosticText,
  sanitizeOutputText,
} from "./state.ts";
import {
  settledAssignmentLocked,
  settledFailureMessage,
  settlementBlocked,
  viewForSettlement,
  type SettledReport,
  type SettlementState,
} from "./settlement-outcome.ts";
import { isScopeClosed } from "./session-owned.ts";
import { foldRunWarnings, recordRunWarning } from "./warnings.ts";

interface RunSettlementDependencies extends Pick<
  RunContext,
  "ownerScope" | "withLock" | "publish" | "sendPeerNotices"
> {
  readonly delivery: RunNotificationDelivery;
  readonly closeRecordScope: RunRecordCleanup["closeRecordScope"];
  readonly claimTurnInputDrain: (record: RunRecord, drained: Deferred.Deferred<void>) => void;
  /** Session-owned follow-up for a completed worktree writer; it never delays delivery. */
  readonly settleCompletedWorkspace?:
    | ((record: RunRecord, assignmentEpoch: number) => Effect.Effect<void>)
    | undefined;
  /**
   * Saves each completed report, and each failure longer than its preview, in full; without it,
   * the parent gets previews and agent_read.
   */
  readonly archiveReport?: ReportArchive | undefined;
}

type AssignmentActivationReplay =
  | { readonly kind: "running"; readonly view: SubagentRunView }
  | {
      readonly kind: "committed-report";
      readonly view: SubagentRunView;
      readonly notifyPeers: boolean;
    }
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

interface SettlementCommit {
  /** Whether the caller sends peer notices; a completed run's backend closure sends its own. */
  readonly notifyPeers: boolean;
  readonly view: SubagentRunView;
}

/** The outcome's completion generation, or undefined when the run's outbox is full. */
const allocateCompletionLocked = (record: RunRecord, state: SettlementState) =>
  state === "stopped" || record.completionGenerations.size >= MAX_UNRESOLVED_REPORT_GENERATIONS
    ? undefined
    : ++record.completionGeneration;

const saveArchive = (
  archive: ReportArchive,
  entry: ReportArchiveEntry,
): Effect.Effect<SubagentReportArchive | undefined> =>
  Effect.suspend(() => archive.save(entry)).pipe(
    Effect.catchTag("ReportArchiveError", (error) =>
      Effect.logWarning(`Subagent report file wasn't saved (${error.reason}).`).pipe(
        Effect.as(undefined),
      ),
    ),
    Effect.catchDefect(() =>
      Effect.logWarning("Subagent report file wasn't saved (archive defect).").pipe(
        Effect.as(undefined),
      ),
    ),
  );

export function settlementOperations(dependencies: RunSettlementDependencies) {
  const {
    ownerScope,
    withLock,
    publish,
    delivery,
    closeRecordScope,
    sendPeerNotices,
    claimTurnInputDrain,
    settleCompletedWorkspace,
    archiveReport,
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
    update: (view: StoredRunView) => StoredRunView | undefined,
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
        return snapshotRun(record);
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
  const discardArchive = (archive: SubagentReportArchive | undefined) =>
    archiveReport && archive
      ? Effect.suspend(() => archiveReport.discard(archive)).pipe(
          Effect.catchTag("ReportArchiveError", (error) =>
            Effect.logWarning(`Uncommitted subagent report file remains (${error.reason}).`),
          ),
          Effect.catchDefect(() =>
            Effect.logWarning("Uncommitted subagent report file remains (archive defect)."),
          ),
        )
      : Effect.void;

  // Saving under the run lock keeps each settlement one atomic transition, so no other operation can
  // overtake an outcome while its file is written. The write is bounded (1 MiB) asynchronous local
  // I/O that never blocks the event loop, but every run's locked transitions wait for it, so the
  // settlement waits only until its deadline and then settles without the file: the parent gets a
  // preview and agent_read, as for any file that can't be saved. The save itself can't be cut short
  // without risking a partial file, so it finishes in the session scope and removes a file it made
  // after the settlement stopped waiting; nothing names that file. A closing session scope would
  // refuse the save without running it, and nothing delivers a completion by then, so the
  // settlement goes on without a file rather than waiting out the deadline.
  const saveArchiveLocked = (
    entry: ReportArchiveEntry,
  ): Effect.Effect<SubagentReportArchive | undefined> =>
    archiveReport
      ? Effect.gen(function* () {
          if (isScopeClosed(ownerScope)) {
            yield* Effect.logWarning("Subagent report file wasn't saved (session closing).");
            return undefined;
          }
          // The file, or none once the deadline passed first. Whichever completes it first owns
          // the outcome, so a save that loses removes its file.
          const outcome = yield* Deferred.make<Option.Option<SubagentReportArchive | undefined>>();
          yield* saveArchive(archiveReport, entry).pipe(
            Effect.flatMap((file) =>
              Deferred.succeed(outcome, Option.some(file)).pipe(
                Effect.flatMap((won) => (won ? Effect.void : discardArchive(file))),
              ),
            ),
            // Uninterruptible from its start, so closing the session scope waits for the write.
            Effect.forkIn(ownerScope, { startImmediately: true, uninterruptible: true }),
          );
          const deadline = yield* Effect.sleep(Duration.millis(REPORT_SAVE_DEADLINE_MILLIS)).pipe(
            Effect.andThen(Deferred.succeed(outcome, Option.none())),
            Effect.forkChild({ startImmediately: true }),
          );
          const saved = yield* Deferred.await(outcome);
          yield* Fiber.interrupt(deadline);
          if (Option.isSome(saved)) return saved.value;
          yield* Effect.logWarning("Subagent report file wasn't saved (deadline).");
          return undefined;
        })
      : Effect.undefined;

  // Only an admitted generation is archived, so every file names the generation that delivers it.
  const archiveReportLocked = Effect.fn("SubagentSettlement.archiveReportLocked")(function* (
    record: RunRecord,
    finalText: string,
    generation: number | undefined,
  ): Effect.fn.Return<SettledReport> {
    const truncation = record.latestAssistantTruncation;
    const reportArchive =
      generation === undefined
        ? undefined
        : yield* saveArchiveLocked({
            id: record.view.id,
            generation,
            text: record.latestAssistantFullText ?? finalText,
            ...(truncation && { originalChars: truncation.originalChars }),
          });
    return {
      ...(truncation && { finalTextTruncation: truncation }),
      ...(reportArchive && { reportArchive }),
    };
  });

  // Like a report, only an admitted failure generation is archived.
  const archiveFailureLocked = (
    record: RunRecord,
    error: string,
    generation: number | undefined,
  ): Effect.Effect<SubagentReportArchive | undefined> =>
    generation !== undefined && error.length > MAX_OUTCOME_PREVIEW_CHARS
      ? saveArchiveLocked({ id: record.view.id, generation, kind: "failure", text: error })
      : Effect.undefined;

  const queueCompletionLocked = (
    record: RunRecord,
    state: SettlementState,
    generation: number | undefined,
    finalText: string | undefined,
    settledError: string | undefined,
    report: SettledReport,
  ) => {
    if (generation === undefined || state === "stopped") return;
    const warning = foldRunWarnings(record.warningSlots);
    delivery.insertCompletionLocked(record, {
      outcome: state,
      ...(finalText && { finalText, ...report }),
      ...(state === "failed" && {
        error: settledError,
        ...(report.errorArchive && { errorArchive: report.errorArchive }),
      }),
      generation,
      ...(warning && { warning }),
    });
  };

  const commitSettlementLocked = Effect.fn("SubagentSettlement.commitSettlementLocked")(function* (
    record: RunRecord,
    state: SettlementState,
    generation: number | undefined,
    finalText: string | undefined,
    settledError: string | undefined,
    report: SettledReport,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const { completedScope, pauseOutcome } = yield* Effect.sync(() => {
      const scope =
        state === "completed" && record.process !== undefined ? record.scope : undefined;
      if (scope) beginCleanup(record);
      const outcome = record.pauseOutcome;
      record.pauseOutcome = undefined;
      record.pauseRequested = false;
      clearRunActivity(record);
      record.latestAssistantFullText = undefined;
      queueCompletionLocked(record, state, generation, finalText, settledError, report);
      return { completedScope: scope, pauseOutcome: outcome };
    }).pipe(
      // Until the completion outbox owns them, nothing else owns the files this settlement
      // saved. Once queued, later failures must keep them: the parent is told their paths.
      Effect.onError(() =>
        discardArchive(report.reportArchive).pipe(
          Effect.andThen(discardArchive(report.errorArchive)),
        ),
      ),
    );
    record.notificationGeneration += 1;
    delivery.discardQuestionLocked(record.view.id);
    record.replyPendingRequestId = undefined;
    if (state === "completed") record.assignment.phase = "reported";
    record.view = viewForSettlement(record, state, now, finalText, settledError, report);
    yield* publish;
    const view = snapshotRun(record);
    if (pauseOutcome) Deferred.doneUnsafe(pauseOutcome, Effect.succeed(view));
    // Transfer post-commit work with the outcome, not with its interruptible waiter. Peer notices
    // still precede backend closure, and their interruption cannot abandon cleanup. This fork
    // never joins under the run lock; its session-owned work acquires it independently. A closing
    // session scope refuses both forks; shutdown then closes every run's scope leaf-first.
    if (completedScope)
      yield* sendPeerNotices(record.view.id).pipe(
        Effect.ensuring(closeRecordScope(record, completedScope)),
        Effect.forkIn(ownerScope),
      );
    if (state === "completed" && record.view.workspaceId !== undefined && settleCompletedWorkspace)
      yield* settleCompletedWorkspace(record, record.assignment.epoch).pipe(
        Effect.forkIn(ownerScope),
      );
    return { notifyPeers: completedScope === undefined, view };
  });

  const settleLocked = Effect.fn("SubagentSettlement.settleLocked")(function* (
    record: RunRecord,
    state: SettlementState,
    error?: string,
    assignmentEpoch?: number,
  ): Effect.fn.Return<SettlementCommit> {
    if (
      settlementBlocked(record, state) ||
      (assignmentEpoch !== undefined && record.assignment.epoch !== assignmentEpoch)
    ) {
      // This settlement never reports, so its full text is never archived.
      record.latestAssistantFullText = undefined;
      return { notifyPeers: false, view: snapshotRun(record) };
    }
    if (record.initialization && state !== "stopped") {
      record.initialization.pendingSettlement = { state, ...(error && { error }) };
      return { notifyPeers: false, view: snapshotRun(record) };
    }
    const acceptedReport =
      state === "failed" && record.assignment.phase === "issuing"
        ? record.assignment.pendingReport
        : undefined;
    if (acceptedReport) {
      // An accepted report proves the assignment ran, so an exit or failure before its start
      // confirmed never replaces it with a retryable failure. Only an explicit stop does.
      record.assignment.pendingReport = undefined;
      record.assignment.pendingRunSettled = false;
      return yield* commitReportLocked(record, acceptedReport);
    }
    const finalText = state === "completed" ? record.latestAssistantText : undefined;
    const generation = allocateCompletionLocked(record, state);
    const reportArchive = finalText
      ? yield* archiveReportLocked(record, finalText, generation)
      : {};
    const settledError = state === "failed" ? (error ?? "Run failed.") : error;
    const errorArchive =
      state === "failed" && settledError !== undefined
        ? yield* archiveFailureLocked(record, settledError, generation)
        : undefined;
    const report: SettledReport = { ...reportArchive, ...(errorArchive && { errorArchive }) };
    return yield* commitSettlementLocked(
      record,
      state,
      generation,
      finalText,
      settledError,
      report,
    );
  }, Effect.uninterruptible);

  const settle = Effect.fn("SubagentSettlement.settle")(function* (
    record: RunRecord,
    state: SettlementState,
    error?: string,
    assignmentEpoch?: number,
  ) {
    const result = yield* withLock(settleLocked(record, state, error, assignmentEpoch));
    if (result.notifyPeers) yield* sendPeerNotices(record.view.id);
    return result.view;
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
          pendingError ?? SubagentProcessError.make({ operation: "run", message: diagnostic });
        beginCleanup(record);
        record.backendFailure ??= failure;
        if (
          Predicate.isTagged(pendingError, "SubagentProcessError") &&
          pendingError.code === PENDING_STEER_DELIVERY_CODE &&
          !pendingError.pendingDelivery
        )
          record.view = { ...record.view, steeringDelivery: "unresolved" };
        record.process?.cancelPending(failure);
        return true;
      }),
    ).pipe(
      Effect.flatMap((shouldFail) => {
        if (!shouldFail) return Effect.succeed(snapshotRun(record));
        const primaryDiagnostic = sanitizeDiagnosticText(
          record.backendFailure?.message ?? diagnostic,
          MAX_ERROR_CHARS,
        );
        if (record.initialization)
          return settle(record, "failed", primaryDiagnostic, assignmentEpoch);
        return (
          record.process ? record.process.terminate("force").pipe(Effect.ignore) : Effect.void
        ).pipe(Effect.andThen(settle(record, "failed", primaryDiagnostic, assignmentEpoch)));
      }),
    );
  };

  const rejectReportAndPublishLocked = Effect.fn("SubagentSettlement.rejectReportAndPublishLocked")(
    function* (record: RunRecord, reason: string, now: number) {
      const warning = sanitizeDiagnosticText(
        `Rejected protocol-invalid backend report: ${reason}`,
        MAX_ERROR_CHARS,
      );
      record.view = {
        ...record.view,
        ...recordRunWarning(record, record.view.sessionEvents, "system", warning, now),
      };
      const view = snapshotRun(record);
      yield* publish;
      return { kind: "unchanged" as const, view };
    },
  );

  const commitReportLocked = Effect.fn("SubagentSettlement.commitReportLocked")(function* (
    record: RunRecord,
    report: BackendReport,
  ) {
    recordLatestAssistantText(record, captureOutputText({ text: report.text ?? "" }));
    record.lastBackendReport = {
      assignmentEpoch: report.assignmentEpoch,
      sequence: report.sequence,
      deliveryId: report.deliveryId,
    };
    return yield* settleLocked(record, "completed", undefined, report.assignmentEpoch);
  }, Effect.uninterruptible);

  const acceptValidatedBackendReport = Effect.fn("SubagentSettlement.acceptValidatedBackendReport")(
    function* (record: RunRecord, report: BackendReport) {
      const now = yield* Clock.currentTimeMillis;
      const decision = yield* withLock(
        Effect.gen(function* () {
          if (isInactiveRunRecord(record) || record.assignment.epoch !== report.assignmentEpoch)
            return { kind: "unchanged" as const, view: snapshotRun(record) };
          const pair = reportPairStatus(record, report);
          if (pair === "exact-retry")
            return { kind: "unchanged" as const, view: snapshotRun(record) };
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
            return { kind: "buffered" as const, view: snapshotRun(record) };
          }
          if (record.assignment.phase !== "running")
            return yield* rejectReportAndPublishLocked(
              record,
              `sequence ${report.sequence} arrived while assignment ${report.assignmentEpoch} was ${record.assignment.phase}.`,
              now,
            );
          const committed = yield* commitReportLocked(record, report);
          return { kind: "committed" as const, ...committed };
        }),
      );
      if (decision.kind === "committed" && decision.notifyPeers)
        yield* sendPeerNotices(record.view.id);
      return decision.view;
    },
  );

  const activateAssignmentLocked = Effect.fn("SubagentSettlement.activateAssignmentLocked")(
    function* (
      record: RunRecord,
      runningView: StoredRunView,
    ): Effect.fn.Return<AssignmentActivationReplay> {
      const pendingReport = record.assignment.pendingReport;
      const pendingRunSettled = record.assignment.pendingRunSettled;
      record.assignment.phase = "running";
      record.assignment.pendingReport = undefined;
      record.assignment.pendingRunSettled = false;
      record.view = runningView;
      if (pendingReport) {
        // The buffered report owns this activation. No running projection or post-lock replay may
        // let process exit/failure overtake its completion payload and retry eligibility.
        const committed = yield* commitReportLocked(record, pendingReport);
        return { kind: "committed-report" as const, ...committed };
      }
      const replay: AssignmentActivationReplay = pendingRunSettled
        ? {
            kind: "settlement",
            assignmentEpoch: record.assignment.epoch,
            terminal: pendingRunSettled.terminal,
          }
        : { kind: "running", view: snapshotRun(record) };
      yield* publish;
      return replay;
    },
    Effect.uninterruptible,
  );

  const replayAssignmentActivation = (
    record: RunRecord,
    replay: AssignmentActivationReplay,
  ): Effect.Effect<SubagentRunView> => {
    switch (replay.kind) {
      case "committed-report":
        return replay.notifyPeers
          ? sendPeerNotices(record.view.id).pipe(Effect.as(replay.view))
          : Effect.succeed(replay.view);
      case "settlement":
        return runSettledFromBackend(record, replay.assignmentEpoch, replay.terminal).pipe(
          Effect.map(() => snapshotRun(record)),
        );
      case "running":
        return Effect.succeed(replay.view);
    }
    return Fn.absurd(replay);
  };

  const acceptBackendReport = Effect.fn("SubagentSettlement.acceptBackendReport")(
    function* (record: RunRecord, rawReport: BackendReport) {
      const current = yield* withLock(
        Effect.sync(
          () =>
            !isInactiveRunRecord(record) && record.assignment.epoch === rawReport.assignmentEpoch,
        ),
      );
      if (!current) return snapshotRun(record);
      if (
        rawReport.runId !== record.view.id ||
        !Number.isSafeInteger(rawReport.assignmentEpoch) ||
        rawReport.assignmentEpoch <= 0 ||
        !Number.isSafeInteger(rawReport.sequence) ||
        rawReport.sequence <= 0 ||
        !Str.trim(rawReport.deliveryId) ||
        rawReport.deliveryId.length > MAX_BACKEND_REPORT_ID_CHARS ||
        (rawReport.evidence !== undefined &&
          rawReport.evidence.length > MAX_BACKEND_REPORT_EVIDENCE_CHARS) ||
        rawReport.text === undefined ||
        !Str.trim(rawReport.text) ||
        rawReport.text.length > MAX_BACKEND_REPORT_TEXT_CHARS
      )
        return yield* processError(
          "accept report from",
          "backend_report_invalid",
          `Subagent ${record.view.id} emitted an invalid bounded report event.`,
        );
      const text = Str.trim(sanitizeOutputText(rawReport.text, MAX_BACKEND_REPORT_TEXT_CHARS));
      if (!text)
        return yield* processError(
          "accept report from",
          "backend_report_empty",
          `Subagent ${record.view.id} submitted an empty report.`,
        );
      return yield* acceptValidatedBackendReport(record, {
        ...rawReport,
        deliveryId: Str.trim(rawReport.deliveryId),
        text,
      });
    },
    (effect, record, rawReport) =>
      effect.pipe(
        Effect.catch((error) =>
          withLock(
            Effect.suspend(() =>
              isInactiveRunRecord(record) || record.assignment.epoch !== rawReport.assignmentEpoch
                ? Effect.succeed(snapshotRun(record))
                : Effect.fail(error),
            ),
          ),
        ),
      ),
  );

  const runStartedFromBackend = Effect.fn("SubagentSettlement.runStartedFromBackend")(function* (
    record: RunRecord,
    assignmentEpoch: number,
  ) {
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
        const running: StoredRunView = {
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

  const runSettledFromBackend = Effect.fn("SubagentSettlement.runSettledFromBackend")(function* (
    record: RunRecord,
    assignmentEpoch: number,
    terminal?: BackendAssistantTerminal,
    isCurrent: () => boolean = () => true,
  ): Effect.fn.Return<void> {
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
        ? captureOutputText({ text: terminal.text, originalSize: terminal.originalSize })
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
        recordLatestAssistantText(record, finalText);
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
