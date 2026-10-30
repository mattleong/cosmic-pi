import * as Fn from "effect/Function";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type { BackendAssistantTerminal, BackendHandle } from "../backend/model.ts";
import type { ReportArchive, ReportArchiveEntry } from "../boundary/report-archive.ts";
import {
  errorText,
  failureFields,
  guidedText,
  type GuidedText,
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
import { addUsage, captureOutputText, sanitizeGuidedDiagnostic } from "./state.ts";
import {
  settledAssignmentLocked,
  settledFailureMessage,
  settlementBlocked,
  viewForSettlement,
  type SettledReport,
  type SettlementState,
} from "./settlement-outcome.ts";
import { isScopeClosed } from "./session-owned.ts";
import { foldRunWarnings, foldUserRunWarnings } from "./warnings.ts";

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
      readonly kind: "settlement";
      readonly assignmentEpoch: number;
      readonly terminal?: BackendAssistantTerminal | undefined;
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
        delivery.handOnTakenByLocked(record.view.id);
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
    settledError: GuidedText | undefined,
    report: SettledReport,
  ) => {
    if (generation === undefined || state === "stopped") return;
    const warning = foldRunWarnings(record.warningSlots);
    const userWarning = foldUserRunWarnings(record.warningSlots);
    delivery.insertCompletionLocked(record, {
      outcome: state,
      ...(finalText && { finalText, ...report }),
      ...(state === "failed" &&
        settledError && {
          error: settledError.message,
          ...(settledError.userMessage !== settledError.message && {
            userError: settledError.userMessage,
          }),
          ...(report.errorArchive && { errorArchive: report.errorArchive }),
        }),
      generation,
      ...(warning && { warning }),
      ...(userWarning && userWarning !== warning && { userWarning }),
    });
  };

  const commitSettlementLocked = Effect.fn("SubagentSettlement.commitSettlementLocked")(function* (
    record: RunRecord,
    state: SettlementState,
    generation: number | undefined,
    finalText: string | undefined,
    settledError: GuidedText | undefined,
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
    delivery.handOnTakenByLocked(record.view.id, state === "completed");
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
    error?: string | GuidedText,
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
    const finalText = state === "completed" ? record.latestAssistantText : undefined;
    const generation = allocateCompletionLocked(record, state);
    const reportArchive = finalText
      ? yield* archiveReportLocked(record, finalText, generation)
      : {};
    const settledError =
      state === "failed"
        ? guidedText(error ?? "Run failed.")
        : error === undefined
          ? undefined
          : guidedText(error);
    // The saved failure is the model's copy, which the parent reads.
    const errorArchive =
      state === "failed" && settledError !== undefined
        ? yield* archiveFailureLocked(record, settledError.message, generation)
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
    error?: string | GuidedText,
    assignmentEpoch?: number,
  ) {
    const result = yield* withLock(settleLocked(record, state, error, assignmentEpoch));
    if (result.notifyPeers) yield* sendPeerNotices(record.view.id);
    return result.view;
  });

  const failRun = (
    record: RunRecord,
    message: string | GuidedText,
    pendingError?: SubagentError,
    assignmentEpoch?: number,
  ) => {
    const diagnostic = sanitizeGuidedDiagnostic(message);
    return withLock(
      Effect.sync(() => {
        if (
          isInactiveRunRecord(record) ||
          (assignmentEpoch !== undefined && record.assignment.epoch !== assignmentEpoch)
        )
          return false;
        const failure =
          pendingError ??
          SubagentProcessError.make({ operation: "run", ...failureFields(diagnostic) });
        beginCleanup(record);
        record.backendFailure ??= failure;
        record.process?.cancelPending(failure);
        return true;
      }),
    ).pipe(
      Effect.flatMap((shouldFail) => {
        if (!shouldFail) return Effect.succeed(snapshotRun(record));
        const primaryDiagnostic = sanitizeGuidedDiagnostic(
          record.backendFailure ? errorText(record.backendFailure) : diagnostic,
        );
        if (record.initialization)
          return settle(record, "failed", primaryDiagnostic, assignmentEpoch);
        return (
          record.process ? record.process.terminate("force").pipe(Effect.ignore) : Effect.void
        ).pipe(Effect.andThen(settle(record, "failed", primaryDiagnostic, assignmentEpoch)));
      }),
    );
  };

  const activateAssignmentLocked = Effect.fn("SubagentSettlement.activateAssignmentLocked")(
    function* (
      record: RunRecord,
      runningView: StoredRunView,
    ): Effect.fn.Return<AssignmentActivationReplay> {
      const pendingRunSettled = record.assignment.pendingRunSettled;
      record.assignment.phase = "running";
      record.assignment.pendingRunSettled = false;
      record.view = runningView;
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
      case "settlement":
        return runSettledFromBackend(record, replay.assignmentEpoch, replay.terminal).pipe(
          Effect.map(() => snapshotRun(record)),
        );
      case "running":
        return Effect.succeed(replay.view);
    }
    return Fn.absurd(replay);
  };

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
    const finalText =
      terminal?.stopReason === "stop" && terminal.text
        ? captureOutputText({ text: terminal.text, originalSize: terminal.originalSize })
        : undefined;
    // Guidance or a descendant notice admitted before this settlement may restart the child, and
    // one admitted while it waited must be waited for too, so the commit claims the drain again.
    let turnInputsDrained = yield* Deferred.make<void>();
    yield* withLock(Effect.sync(() => claimTurnInputDrain(record, turnInputsDrained)));
    while (true) {
      yield* Deferred.await(turnInputsDrained);
      if (!isCurrent()) return;
      if (record.pauseRequested) {
        const now = yield* Clock.currentTimeMillis;
        if (yield* pauseFromEvent(record, now, assignmentEpoch)) return;
      }
      if (record.stoppedByParent) return;
      const nextDrain = Deferred.makeUnsafe<void>();
      const outcome = yield* withLock(
        Effect.gen(function* () {
          if (
            isInactiveRunRecord(record) ||
            record.assignment.epoch !== assignmentEpoch ||
            record.assignment.phase !== "running" ||
            !isCurrent()
          )
            return "ignored" as const;
          claimTurnInputDrain(record, nextDrain);
          if (!Deferred.isDoneUnsafe(nextDrain)) return "draining" as const;
          if (!finalText) return "failed" as const;
          recordLatestAssistantText(record, finalText);
          record.pausedAssignmentEpoch = undefined;
          // Committed in this lock hold, so no notice is admitted between the check and the outcome.
          return yield* settleLocked(record, "completed", undefined, assignmentEpoch);
        }),
      );
      if (outcome === "draining") {
        turnInputsDrained = nextDrain;
        continue;
      }
      if (outcome === "failed")
        yield* failRun(record, settledFailureMessage(terminal), undefined, assignmentEpoch);
      else if (outcome !== "ignored" && outcome.notifyPeers) yield* sendPeerNotices(record.view.id);
      return;
    }
  });

  return {
    mutateEventView,
    mergeLateUsage,
    mergeProcessUsage,
    settle,
    failRun,
    activateAssignmentLocked,
    replayAssignmentActivation,
    runStartedFromBackend,
    runSettledFromBackend,
  };
}

export type RunSettlement = ReturnType<typeof settlementOperations>;
