import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { hasSubagentCapability, isTerminalRunState, type SubagentRunView } from "./model.ts";
import {
  clearRunActivity,
  commitRunPauseLocked,
  requireCapability,
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
import { validateParentMessage } from "./tool-policy.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import { runSessionOwned } from "./session-owned.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText, sanitizeName, snapshotView } from "./state.ts";
import { recordRunWarning } from "./warnings.ts";

export interface RunControlDependencies extends RunContext {
  /** Service-owned turn-input admission; called only while the service state lock is held. */
  readonly admitTurnInput: (record: RunRecord) => void;
  readonly releaseTurnInput: (record: RunRecord) => Effect.Effect<void>;
  /** Called only while the service state lock is held. */
  readonly claimTurnInputDrain: (record: RunRecord, drained: Deferred.Deferred<void>) => void;
  readonly processControls: RunProcessControls;
  readonly closeRecordScope: RunRecordCleanup["closeRecordScope"];
  readonly settle: RunSettlement["settle"];
}

export function makeRunControls(dependencies: RunControlDependencies) {
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
    settle,
  } = dependencies;

  const retainControlWarning = (record: RunRecord, warning: string) =>
    Effect.gen(function* () {
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

  const recordParentNoticeLocked = (record: RunRecord, text: string, now: number) => {
    record.view = {
      ...record.view,
      lastActivityAt: now,
      sessionEvents: appendNoticeSessionEvent(record.view.sessionEvents, "parent", text, now),
    };
  };

  const finalizeGuidance = (
    record: RunRecord,
    message: string,
  ): Effect.Effect<SubagentRunView, InvalidSubagentRequestError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* withLock(
        Effect.gen(function* () {
          if (record.view.state !== "running")
            return yield* invalidRequest(
              "guidance_outcome_uncertain",
              `Subagent ${record.view.id} changed state after guidance was sent, so delivery may already have applied. Inspect with subagent_status before retrying.`,
            );
          if (record.replyPendingRequestId)
            return yield* invalidRequest(
              "guidance_outcome_uncertain",
              `Subagent ${record.view.id} claimed a parent reply after guidance was sent, so delivery may already have applied. Inspect with subagent_status before retrying.`,
            );
          recordParentNoticeLocked(record, `Guidance: ${message}`, now);
          yield* publish;
          return snapshotView(record.view);
        }),
      );
    });

  const send = (id: string, message: string): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.gen(function* () {
      const normalized = yield* validateParentMessage(message, "Guidance message is required.");
      return yield* Effect.acquireUseRelease(
        withLock(
          Effect.gen(function* () {
            const selected = yield* requireRecord(id);
            if (selected.view.state === "waiting_for_parent")
              return yield* invalidRequest(
                "run_waiting_for_parent",
                `Subagent ${id} is waiting for a parent reply; use subagent_reply({ runId: "${id}", message: "..." }).`,
              );
            if (selected.replyPendingRequestId)
              return yield* invalidRequest(
                "reply_in_flight",
                `Subagent ${id} already has a parent reply in flight.`,
              );
            yield* requireCapability(selected, "steer");
            if (selected.view.state === "paused" || selected.view.state === "completed") {
              const recovery = hasSubagentCapability(selected.view, "resume")
                ? `resume it with subagent_lifecycle({ action: "resume", runIds: ["${id}"] }) before sending guidance`
                : `this backend cannot resume it; stop it with subagent_lifecycle({ action: "stop", runIds: ["${id}"] }) and start a replacement`;
              return yield* invalidRequest(
                "run_not_running",
                `Subagent ${id} is ${selected.view.state}; ${recovery}.`,
              );
            }
            if (selected.view.state === "starting")
              return yield* invalidRequest(
                "run_starting",
                `Subagent ${id} is still starting; wait for it to start before retrying subagent_send.`,
              );
            if (selected.view.state !== "running")
              return yield* invalidRequest(
                "run_not_running",
                `Subagent ${id} is ${selected.view.state} and cannot receive guidance; inspect it with subagent_status or start a replacement run.`,
              );
            if (selected.pauseRequested)
              return yield* invalidRequest(
                "interrupt_in_flight",
                `Subagent ${id} already has an interrupt pending and cannot receive new guidance.`,
              );
            admitTurnInput(selected);
            return selected;
          }),
        ),
        (admitted) =>
          processControls.steer(admitted, normalized).pipe(
            Effect.tapError((error) =>
              error._tag === "SubagentProcessError" &&
              isOutcomeUncertain(error) &&
              !error.pendingDelivery
                ? retainControlWarning(admitted, error.message)
                : Effect.void,
            ),
            Effect.andThen(finalizeGuidance(admitted, normalized)),
          ),
        releaseTurnInput,
      );
    });

  const reply = (id: string, message: string): Effect.Effect<SubagentRunView, SubagentError> =>
    runSessionOwned(
      ownerScope,
      Effect.gen(function* () {
        const normalized = yield* validateParentMessage(message, "Reply message is required.");
        const claimed = yield* withLock(
          Effect.gen(function* () {
            const record = yield* requireRecord(id);
            yield* requireCapability(record, "parent-contact");
            const question = record.view.question;
            if (record.view.state !== "waiting_for_parent" || !question)
              return yield* invalidRequest(
                "parent_question_missing",
                `Subagent ${id} has no pending parent question.`,
              );
            if (record.replyPendingRequestId)
              return yield* invalidRequest(
                "reply_in_flight",
                `Subagent ${id} already has a reply in flight.`,
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
            return { record, process, question };
          }),
        );
        return { ...claimed, normalized };
      }),
      ({ normalized, ...claimed }) =>
        claimed.process.controls.reply(claimed.question.requestId, normalized).pipe(
          Effect.mapError((error) => {
            if (error._tag !== "SubagentProcessError") return error;
            // A pre-send failure proves the reply never reached the transport, so the
            // question rolls back for an immediate retry instead of surfacing ambiguity.
            if (error.code === "transport_not_sent")
              return processError(
                "reply",
                "reply_send_failed",
                `The reply to subagent ${id} was not sent; the question remains open for a retry. (${error.message})`,
              );
            return error.code === "transport_outcome_uncertain"
              ? processError(
                  "reply",
                  "reply_outcome_uncertain",
                  `The reply to subagent ${id} may already have applied. Inspect with subagent_status before retrying. (${error.message})`,
                )
              : error;
          }),
          Effect.andThen(Clock.currentTimeMillis),
          Effect.flatMap((now) =>
            withLock(
              Effect.gen(function* () {
                if (claimed.record.replyPendingRequestId === claimed.question.requestId)
                  claimed.record.replyPendingRequestId = undefined;
                recordParentNoticeLocked(claimed.record, `Reply: ${normalized}`, now);
                yield* publish;
                return snapshotView(claimed.record.view);
              }),
            ),
          ),
          // The owner-scoped commit outlives cancellation of the requesting tool.
          // Roll back only when the transport itself reports a definite failure.
          Effect.tapError((error) => {
            if (error._tag === "SubagentProcessError" && error.code === "reply_outcome_uncertain")
              // Keep the exact request claim until a distinct question or lifecycle event resolves
              // the ambiguity, so a duplicate contact cannot invite a second reply.
              return retainControlWarning(claimed.record, error.message);
            const questionClosed =
              error._tag === "SubagentProcessError" &&
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
        ),
    );

  const interrupt = (id: string): Effect.Effect<SubagentRunView, SubagentError> =>
    runSessionOwned(
      ownerScope,
      Effect.gen(function* () {
        const pauseOutcome = yield* Deferred.make<SubagentRunView, SubagentError>();
        const turnInputsDrained = yield* Deferred.make<void>();
        const record = yield* withLock(
          Effect.gen(function* () {
            const selected = yield* requireRecord(id);
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
                  if (record.view.state === "paused") return;
                  const responseTimedOut =
                    error._tag === "SubagentProcessError" &&
                    error.code === "interrupt_outcome_uncertain";
                  if (!responseTimedOut && record.pauseOutcome === pauseOutcome) {
                    record.pauseRequested = false;
                    record.pauseOutcome = undefined;
                  }
                  if (responseTimedOut)
                    return yield* processError(
                      "interrupt",
                      "interrupt_outcome_uncertain",
                      `Subagent ${id} did not confirm interruption in time, but the pause request remains pending and may still apply. Inspect with subagent_status before retrying.`,
                    );
                  return yield* error;
                }),
              ),
            ),
          );
          const now = yield* Clock.currentTimeMillis;
          return yield* withLock(
            Effect.gen(function* () {
              if (record.view.state === "paused") return snapshotView(record.view);
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

  const renameLocked = (record: RunRecord, name: string) => {
    record.launch = { ...record.launch, name };
    record.view = { ...record.view, name };
    return publish.pipe(Effect.as(snapshotView(record.view)));
  };

  const rename = (id: string, rawName: string): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.gen(function* () {
      const name = sanitizeName(rawName);
      if (!name) return yield* invalidRequest("name_required", "Subagent name is required.");
      const selected = yield* withLock(
        Effect.gen(function* () {
          const record = yield* requireRecord(id);
          yield* requireCapability(record, "rename-display");
          if (record.view.state === "stopping")
            return yield* invalidRequest(
              "rename_state_invalid",
              `Subagent ${id} cannot be renamed while stopping.`,
            );
          // A live backend renames its own session first; any other run renames locally.
          return record.view.state === "running" ||
            record.view.state === "waiting_for_parent" ||
            record.view.state === "paused"
            ? { record }
            : { record, localView: yield* renameLocked(record, name) };
        }),
      );
      if (!selected.localView) yield* processControls.renameDisplay(selected.record, name);
      const view =
        selected.localView ??
        (yield* withLock(
          Effect.gen(function* () {
            if (
              selected.record.view.state === "stopping" ||
              isTerminalRunState(selected.record.view.state)
            )
              return yield* invalidRequest(
                "rename_outcome_uncertain",
                `Subagent ${id} stopped before rename completed.`,
              );
            return yield* renameLocked(selected.record, name);
          }),
        ));
      yield* sendPeerNotices(id);
      return view;
    });

  const stop = (id: string): Effect.Effect<SubagentRunView, SubagentError> =>
    runSessionOwned(
      ownerScope,
      withLock(
        Effect.gen(function* () {
          const selected = yield* requireRecord(id);
          if (isTerminalRunState(selected.view.state))
            return {
              record: selected,
              cleanupRequired: selected.cleanupPending,
              preserveOutcome: true,
            };
          // Overlapping subtree traversals must join descendant cleanup before
          // closing an ancestor, even when another stop already claimed it.
          if (selected.view.state === "stopping")
            return { record: selected, cleanupRequired: true as const };
          selected.stoppedByParent = true;
          selected.cleanupPending = true;
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
      ({ record, cleanupRequired, preserveOutcome }) =>
        cleanupRequired
          ? closeRecordScope(record).pipe(
              Effect.andThen(() =>
                preserveOutcome
                  ? Effect.succeed(snapshotView(record.view))
                  : settle(record, "stopped"),
              ),
            )
          : Effect.succeed(snapshotView(record.view)),
    );

  return { send, reply, interrupt, rename, stop };
}
