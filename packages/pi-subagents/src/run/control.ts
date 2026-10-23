import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
  hasSubagentCapability,
  isTerminalRunState,
  type SubagentRunView,
  type SubagentControlExpectation,
  type SubagentSendDelivery,
  type SubagentSendOutcome,
} from "./model.ts";
import {
  beginCleanup,
  isCleanupOwed,
  clearRunActivity,
  commitRunPauseLocked,
  requireCapability,
  snapshotRun,
  type RunContext,
  type RunRecord,
} from "./internal.ts";
import {
  invalidRequest,
  type InvalidSubagentRequestError,
  isOutcomeUncertain,
  processError,
  type SubagentError,
  SubagentProcessError,
} from "./errors.ts";
import type { RunProcessControls } from "./process-lifecycle.ts";
import type { RunRecordCleanup } from "./record-cleanup.ts";
import type { RunSettlement } from "./settlement.ts";
import { commitSessionOwned, runSessionOwned } from "./session-owned.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText, sanitizeName } from "./state.ts";
import { recordRunWarning } from "./warnings.ts";
import { requireControlExpectation } from "./control-admission.ts";

interface RunControlDependencies extends Pick<
  RunContext,
  "ownerScope" | "withLock" | "requireRecord" | "publish" | "sendPeerNotices"
> {
  readonly admitTurnInput: (record: RunRecord) => void;
  readonly releaseTurnInput: (record: RunRecord) => Effect.Effect<void>;
  readonly claimTurnInputDrain: (record: RunRecord, drained: Deferred.Deferred<void>) => void;
  readonly processControls: RunProcessControls;
  readonly closeRecordScope: RunRecordCleanup["closeRecordScope"];
  readonly verifyCleanup: RunRecordCleanup["verifyCleanup"];
  readonly settle: RunSettlement["settle"];
}

/** A message for a run, decided under the run lock as an answer or as guidance. */
export interface RunControlMessage {
  /** Answers a pending question; only the run's ancestors may, so others leave it unset. */
  readonly answer?: string | undefined;
  /** Steers the turn, including a turn waiting on a question when `answer` is unset. */
  readonly guidance: string;
  /** Records the applied delivery in the run's session events. */
  readonly recordNoticeLocked: (
    record: RunRecord,
    delivery: SubagentSendDelivery,
    now: number,
  ) => void;
}

export function controlOperations(dependencies: RunControlDependencies) {
  const {
    ownerScope,
    withLock,
    requireRecord,
    processControls,
    admitTurnInput,
    releaseTurnInput,
    claimTurnInputDrain,
    publish,
    sendPeerNotices,
    closeRecordScope,
    verifyCleanup,
    settle,
  } = dependencies;

  const retainControlWarning = Effect.fn("SubagentControl.retainControlWarning")(function* (
    record: RunRecord,
    warning: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const diagnostic = sanitizeDiagnosticText(warning, MAX_ERROR_CHARS);
    yield* withLock(
      Effect.gen(function* () {
        if (isTerminalRunState(record.view.state) || record.view.state === "stopping") return;
        record.view = {
          ...record.view,
          ...recordRunWarning(record, record.view.sessionEvents, "system", diagnostic, now),
        };
        yield* publish;
      }),
    );
  });

  const finalizeGuidance = Effect.fn("SubagentControl.finalizeGuidance")(function* (
    record: RunRecord,
    message: RunControlMessage,
  ): Effect.fn.Return<SubagentRunView, InvalidSubagentRequestError> {
    const now = yield* Clock.currentTimeMillis;
    return yield* withLock(
      Effect.gen(function* () {
        const steerable =
          record.view.state === "running" ||
          (message.answer === undefined && record.view.state === "waiting_for_parent");
        if (!steerable)
          return yield* invalidRequest(
            "guidance_outcome_uncertain",
            `Subagent ${record.view.id} changed state after guidance was sent, so delivery may already have applied. Inspect it with agent_read before retrying.`,
          );
        if (record.replyPendingRequestId)
          return yield* invalidRequest(
            "guidance_outcome_uncertain",
            `Subagent ${record.view.id} claimed a parent reply after guidance was sent, so delivery may already have applied. Inspect it with agent_read before retrying.`,
          );
        message.recordNoticeLocked(record, "guided", now);
        yield* publish;
        return snapshotRun(record);
      }),
    );
  });

  // Both claims run under the run lock that claimDelivery holds.
  const claimAnswerLocked = Effect.fn("SubagentControl.claimAnswerLocked")(function* (
    record: RunRecord,
  ) {
    const id = record.view.id;
    yield* requireCapability(record, "parent-contact");
    const question = record.view.question;
    if (!question)
      return yield* invalidRequest(
        "parent_question_missing",
        `Subagent ${id} has no pending parent question.`,
      );
    if (record.pauseRequested)
      return yield* invalidRequest(
        "interrupt_in_flight",
        `Subagent ${id} already has an interrupt pending and cannot receive a parent reply.`,
      );
    const process = record.process;
    if (!process)
      return yield* new SubagentProcessError({
        operation: "reply to",
        message: `Subagent ${id} has no active process.`,
      });
    admitTurnInput(record);
    record.replyPendingRequestId = question.requestId;
    record.view = { ...record.view, state: "running", question: undefined };
    yield* publish;
    return { delivery: "answered" as const, record, process, question };
  });

  const claimGuidanceLocked = Effect.fn("SubagentControl.claimGuidanceLocked")(function* (
    record: RunRecord,
    steerWaiting: boolean,
  ) {
    const id = record.view.id;
    yield* requireCapability(record, "steer");
    if (steerWaiting && record.view.state === "waiting_for_parent") {
      if (record.pauseRequested)
        return yield* invalidRequest(
          "interrupt_in_flight",
          `Subagent ${id} already has an interrupt pending and cannot receive new guidance.`,
        );
      admitTurnInput(record);
      return { delivery: "guided" as const, record };
    }
    if (record.view.state === "paused" || record.view.state === "completed") {
      const recovery = hasSubagentCapability(record.view, "resume")
        ? `send the message with agent_send({ to: "${id}", message: "..." }) to resume it`
        : `this backend cannot resume it; stop it with agent_lifecycle({ action: "stop", runIds: ["${id}"] }) and start a replacement`;
      return yield* invalidRequest(
        "run_not_running",
        `Subagent ${id} is ${record.view.state}; ${recovery}.`,
      );
    }
    if (record.view.state === "starting")
      return yield* invalidRequest(
        "run_starting",
        `Subagent ${id} is still starting; wait for it to start before sending again.`,
      );
    if (record.view.state !== "running")
      return yield* invalidRequest(
        "run_not_running",
        `Subagent ${id} is ${record.view.state} and cannot receive guidance; inspect it with agent_read or start a replacement run.`,
      );
    if (record.pauseRequested)
      return yield* invalidRequest(
        "interrupt_in_flight",
        `Subagent ${id} already has an interrupt pending and cannot receive new guidance.`,
      );
    admitTurnInput(record);
    return { delivery: "guided" as const, record };
  });

  const claimDelivery = (
    id: string,
    expected: SubagentControlExpectation | undefined,
    mayAnswer: boolean,
  ) =>
    withLock(
      Effect.gen(function* () {
        const record = yield* requireRecord(id);
        yield* requireControlExpectation(record, expected);
        if (record.replyPendingRequestId)
          return yield* invalidRequest(
            "reply_in_flight",
            `Subagent ${id} already has a parent reply in flight; inspect it with agent_read before sending again.`,
          );
        return mayAnswer && record.view.state === "waiting_for_parent"
          ? yield* claimAnswerLocked(record)
          : yield* claimGuidanceLocked(record, !mayAnswer);
      }),
    );

  const guide = (
    record: RunRecord,
    message: RunControlMessage,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    processControls.steer(record, message.guidance).pipe(
      Effect.tapError((error) =>
        Predicate.isTagged(error, "SubagentProcessError") &&
        isOutcomeUncertain(error) &&
        !error.pendingDelivery
          ? retainControlWarning(record, error.message)
          : Effect.void,
      ),
      Effect.andThen(finalizeGuidance(record, message)),
    );

  const answer = (
    claimed: Extract<Effect.Success<ReturnType<typeof claimDelivery>>, { delivery: "answered" }>,
    message: RunControlMessage,
    reply: string,
  ): Effect.Effect<SubagentRunView, SubagentError> => {
    const id = claimed.record.view.id;
    return claimed.process.controls.reply(claimed.question.requestId, reply).pipe(
      Effect.catchTag("SubagentProcessError", (error) => {
        if (error.code === "transport_not_sent")
          return Effect.fail(
            processError(
              "reply",
              "reply_send_failed",
              `The reply to subagent ${id} was not sent; the question remains open for a retry. (${error.message})`,
            ),
          );
        return Effect.fail(
          error.code === "transport_outcome_uncertain"
            ? processError(
                "reply",
                "reply_outcome_uncertain",
                `The reply to subagent ${id} may already have applied. Inspect it with agent_read before retrying. (${error.message})`,
              )
            : error,
        );
      }),
      Effect.andThen(Clock.currentTimeMillis),
      Effect.flatMap((now) =>
        withLock(
          Effect.gen(function* () {
            if (claimed.record.replyPendingRequestId === claimed.question.requestId)
              claimed.record.replyPendingRequestId = undefined;
            message.recordNoticeLocked(claimed.record, "answered", now);
            yield* publish;
            return snapshotRun(claimed.record);
          }),
        ),
      ),
      Effect.tapError((error) => {
        if (
          Predicate.isTagged(error, "SubagentProcessError") &&
          error.code === "reply_outcome_uncertain"
        )
          return retainControlWarning(claimed.record, error.message);
        const questionClosed =
          Predicate.isTagged(error, "SubagentProcessError") &&
          (error.code === "question_transport_closed" ||
            error.code === "question_ownership_mismatch");
        return withLock(
          Effect.gen(function* () {
            if (claimed.record.replyPendingRequestId !== claimed.question.requestId) return;
            claimed.record.replyPendingRequestId = undefined;
            if (
              !questionClosed &&
              claimed.record.view.state === "running" &&
              claimed.record.view.question === undefined
            ) {
              claimed.record.view = {
                ...claimed.record.view,
                state: "waiting_for_parent",
                question: claimed.question,
              };
              yield* publish;
            }
          }),
        );
      }),
      Effect.ensuring(releaseTurnInput(claimed.record)),
    );
  };

  // One locked claim decides whether the message answers a pending question or steers the turn.
  // An answer commits in the owner scope so a cancelled caller never abandons the claimed
  // question; guidance stays caller-scoped and releases its turn-input admission on exit.
  const deliver = (
    id: string,
    message: RunControlMessage,
    expected?: SubagentControlExpectation,
  ): Effect.Effect<SubagentSendOutcome, SubagentError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(
        claimDelivery(id, expected, message.answer !== undefined),
        (claimed): Effect.Effect<SubagentSendOutcome, SubagentError> =>
          claimed.delivery === "answered" && message.answer !== undefined
            ? commitSessionOwned(
                ownerScope,
                answer(claimed, message, message.answer),
                restore,
              ).pipe(Effect.map((run) => ({ delivery: claimed.delivery, run })))
            : restore(guide(claimed.record, message)).pipe(
                Effect.ensuring(releaseTurnInput(claimed.record)),
                Effect.map((run) => ({ delivery: "guided" as const, run })),
              ),
      ),
    );

  const interrupt = (
    id: string,
    expected?: SubagentControlExpectation,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    runSessionOwned(
      ownerScope,
      Effect.gen(function* () {
        const pauseOutcome = yield* Deferred.make<SubagentRunView, SubagentError>();
        const turnInputsDrained = yield* Deferred.make<void>();
        const record = yield* withLock(
          Effect.gen(function* () {
            const selected = yield* requireRecord(id);
            yield* requireControlExpectation(selected, expected);
            yield* requireCapability(selected, "interrupt");
            if (selected.view.state !== "running" && selected.view.state !== "waiting_for_parent")
              return yield* invalidRequest(
                "interrupt_state_invalid",
                `Subagent ${id} cannot be interrupted while ${selected.view.state}.`,
              );
            if (selected.pauseRequested)
              return yield* invalidRequest(
                "interrupt_in_flight",
                `Subagent ${id} already has an interrupt pending.`,
              );
            selected.pauseRequested = true;
            selected.pauseOutcome = pauseOutcome;
            claimTurnInputDrain(selected, turnInputsDrained);
            return selected;
          }),
        );
        return { record, pauseOutcome, turnInputsDrained };
      }),
      ({ record, pauseOutcome, turnInputsDrained }) =>
        Effect.gen(function* () {
          yield* Deferred.await(turnInputsDrained);
          yield* Effect.raceFirst(
            processControls.interrupt(record),
            Deferred.await(pauseOutcome).pipe(Effect.asVoid),
          ).pipe(
            Effect.catch((error) =>
              withLock(
                Effect.gen(function* () {
                  if (record.view.state === "paused") return undefined;
                  const responseTimedOut =
                    Predicate.isTagged(error, "SubagentProcessError") &&
                    error.code === "interrupt_outcome_uncertain";
                  if (!responseTimedOut && record.pauseOutcome === pauseOutcome) {
                    record.pauseRequested = false;
                    record.pauseOutcome = undefined;
                  }
                  if (responseTimedOut)
                    return yield* processError(
                      "interrupt",
                      "interrupt_outcome_uncertain",
                      `Subagent ${id} did not confirm interruption in time, but the pause request remains pending and may still apply. Inspect it with agent_read before retrying.`,
                    );
                  return yield* error;
                }),
              ),
            ),
          );
          const now = yield* Clock.currentTimeMillis;
          return yield* withLock(
            Effect.gen(function* () {
              if (record.view.state === "paused") return snapshotRun(record);
              if (record.view.state !== "running" && record.view.state !== "waiting_for_parent")
                return yield* invalidRequest(
                  "interrupt_outcome_uncertain",
                  `Subagent ${id} stopped before interruption completed.`,
                );
              if (record.pauseOutcome === pauseOutcome) record.pauseOutcome = undefined;
              const view = commitRunPauseLocked(record, now);
              yield* publish;
              return view;
            }),
          );
        }),
    );

  // Renaming is root-owned and changes only the display name; the child session never sees it.
  const rename = Effect.fn("SubagentControl.rename")(function* (
    id: string,
    rawName: string,
    expected?: SubagentControlExpectation,
  ): Effect.fn.Return<SubagentRunView, SubagentError> {
    const name = sanitizeName(rawName);
    if (!name) return yield* invalidRequest("name_required", "Subagent name is required.");
    const view = yield* withLock(
      Effect.gen(function* () {
        const record = yield* requireRecord(id);
        yield* requireControlExpectation(record, expected);
        record.launch = { ...record.launch, name };
        yield* publish;
        return snapshotRun(record);
      }),
    );
    yield* sendPeerNotices(id);
    return view;
  });

  const stop = (
    id: string,
    expected?: SubagentControlExpectation,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    runSessionOwned(
      ownerScope,
      withLock(
        Effect.gen(function* () {
          const selected = yield* requireRecord(id);
          yield* requireControlExpectation(selected, expected);
          if (isTerminalRunState(selected.view.state))
            return {
              record: selected,
              cleanupRequired: isCleanupOwed(selected),
              preserveOutcome: true,
              recoverCleanup:
                selected.cleanupDisposition === "quarantined" ||
                selected.cleanupVerification !== undefined,
            };
          if (selected.view.state === "stopping")
            return { record: selected, cleanupRequired: true as const };
          selected.stoppedByParent = true;
          beginCleanup(selected);
          clearRunActivity(selected);
          selected.view = {
            ...selected.view,
            state: "stopping",
            question: undefined,
            currentTool: undefined,
          };
          selected.process?.cancelPending(
            new SubagentProcessError({ operation: "stop", message: `Subagent ${id} was stopped.` }),
          );
          yield* publish;
          return { record: selected, cleanupRequired: true as const };
        }),
      ),
      ({ record, cleanupRequired, preserveOutcome, recoverCleanup }) =>
        cleanupRequired
          ? closeRecordScope(record).pipe(
              Effect.andThen(recoverCleanup ? verifyCleanup(record) : Effect.void),
              Effect.andThen(() =>
                preserveOutcome ? Effect.succeed(snapshotRun(record)) : settle(record, "stopped"),
              ),
            )
          : Effect.succeed(snapshotRun(record)),
    );

  return { deliver, interrupt, rename, stop };
}
