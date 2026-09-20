import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import {
  hasSubagentCapability,
  isTerminalRunState,
  type SubagentCapability,
  type SubagentRunView,
} from "./model.ts";
import { clearRunNativeActivity, type RunRecord } from "./internal.ts";
import {
  InvalidSubagentRequestError,
  isOutcomeUncertain,
  type SubagentError,
  SubagentProcessError,
  SubagentNotFoundError,
  UnsupportedSubagentCapabilityError,
} from "./errors.ts";
import { hasRetainedAssignmentCapacity } from "./completion.ts";
import { isCurrentIssuingAssignment } from "./assignment.ts";
import { validateParentMessage } from "./tool-policy.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import { runSessionOwned } from "./session-owned.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText, sanitizeName, snapshotView } from "./state.ts";
import { emptyRunWarningSlots, projectRunWarning, setRunWarning } from "./warnings.ts";

export interface RunControlDependencies {
  readonly ownerScope: Scope.Scope;
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly requireRecord: (id: string) => Effect.Effect<RunRecord, SubagentNotFoundError>;
  readonly requireCapability: (
    record: RunRecord,
    capability: SubagentCapability,
  ) => Effect.Effect<void, UnsupportedSubagentCapabilityError>;
  readonly steerBackend: (record: RunRecord, message: string) => Effect.Effect<void, SubagentError>;
  readonly beginAssignmentBackend: (
    record: RunRecord,
    message: string,
    attemptToken: string,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly allocateAssignmentAttemptToken: () => string;
  readonly retainUncertainAssignment: (
    record: RunRecord,
    attemptToken: string,
    warning: string,
  ) => Effect.Effect<void>;
  readonly interruptBackend: (record: RunRecord) => Effect.Effect<void, SubagentError>;
  /** Called only while the service state lock is held. */
  readonly admitTurnInput: (record: RunRecord) => void;
  readonly releaseTurnInput: (record: RunRecord) => Effect.Effect<void>;
  /** Called only while the service state lock is held. */
  readonly claimTurnInputDrain: (record: RunRecord, drained: Deferred.Deferred<void>) => void;
  readonly renameBackend: (record: RunRecord, name: string) => Effect.Effect<void, SubagentError>;
  readonly publish: Effect.Effect<void>;
  readonly sendPeerNotices: (changedId: string) => Effect.Effect<void>;
  readonly failPendingResponses: (record: RunRecord, error: SubagentError) => void;
  readonly closeRecordScope: (record: RunRecord) => Effect.Effect<void>;
  readonly settle: (
    record: RunRecord,
    state: "completed" | "failed" | "stopped",
    error?: string,
  ) => Effect.Effect<SubagentRunView>;
}

export function makeRunControls(dependencies: RunControlDependencies) {
  const {
    ownerScope,
    withLock,
    requireRecord,
    requireCapability,
    steerBackend,
    beginAssignmentBackend,
    allocateAssignmentAttemptToken,
    retainUncertainAssignment,
    interruptBackend,
    admitTurnInput,
    releaseTurnInput,
    claimTurnInputDrain,
    renameBackend,
    publish,
    sendPeerNotices,
    failPendingResponses,
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
          record.warningSlots = setRunWarning(record.warningSlots, "system", diagnostic);
          record.view = {
            ...record.view,
            ...projectRunWarning(record.warningSlots, "system"),
            sessionEvents: appendNoticeSessionEvent(
              record.view.sessionEvents,
              "warning",
              diagnostic,
              now,
            ),
          };
          yield* publish;
        }),
      );
    });

  const finalizeGuidance = (
    record: RunRecord,
    message: string,
    allowReported: boolean,
  ): Effect.Effect<SubagentRunView, InvalidSubagentRequestError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* withLock(
        Effect.gen(function* () {
          if (allowReported && record.view.state === "reported") return snapshotView(record.view);
          if (record.view.state !== "running")
            return yield* new InvalidSubagentRequestError({
              code: "guidance_outcome_uncertain",
              message: `Subagent ${record.view.id} changed state after guidance was sent, so delivery may already have applied. Inspect with subagent_status before retrying.`,
            });
          if (record.replyPendingRequestId)
            return yield* new InvalidSubagentRequestError({
              code: "guidance_outcome_uncertain",
              message: `Subagent ${record.view.id} claimed a parent reply after guidance was sent, so delivery may already have applied. Inspect with subagent_status before retrying.`,
            });
          record.view = {
            ...record.view,
            lastActivityAt: now,
            sessionEvents: appendNoticeSessionEvent(
              record.view.sessionEvents,
              "parent",
              `Guidance: ${message}`,
              now,
            ),
          };
          yield* publish;
          return snapshotView(record.view);
        }),
      );
    });

  const send = (id: string, message: string): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.gen(function* () {
      const normalized = yield* validateParentMessage(message, "Guidance message is required.");
      const selected = yield* Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          const selected = yield* withLock(
            Effect.gen(function* () {
              const selected = yield* requireRecord(id);
              if (selected.view.state === "waiting_for_parent")
                return yield* new InvalidSubagentRequestError({
                  code: "run_waiting_for_parent",
                  message: `Subagent ${id} is waiting for a parent reply; use subagent_reply({ runId: "${id}", message: "..." }).`,
                });
              if (selected.replyPendingRequestId)
                return yield* new InvalidSubagentRequestError({
                  code: "reply_in_flight",
                  message: `Subagent ${id} already has a parent reply in flight.`,
                });
              if (selected.view.state === "reported" && selected.view.closeOnReport === false) {
                if (!hasRetainedAssignmentCapacity(selected))
                  return yield* new InvalidSubagentRequestError({
                    code: "report_delivery_backlog",
                    message: `Subagent ${id} has ${selected.completionGenerations.size} unresolved report generations; wait for parent delivery or claim the latest report before beginning another assignment.`,
                  });
                const attemptToken = allocateAssignmentAttemptToken();
                const previous = {
                  view: snapshotView(selected.view),
                  latestAssistantText: selected.latestAssistantText,
                  warningSlots: { ...selected.warningSlots },
                  assignment: { ...selected.assignment },
                  activeTools: [...selected.activeTools.entries()] as const,
                  pauseRequested: selected.pauseRequested,
                  pauseOutcome: selected.pauseOutcome,
                  replyPendingRequestId: selected.replyPendingRequestId,
                };
                selected.pausedAssignmentEpoch = undefined;
                selected.latestAssistantText = undefined;
                selected.warningSlots = emptyRunWarningSlots();
                selected.assignment = {
                  epoch: selected.nextAssignmentEpoch++,
                  phase: "issuing",
                  attemptToken,
                  startedObserved: false,
                  outcomeUncertain: false,
                  pendingRunSettled: false,
                };
                selected.view = {
                  ...selected.view,
                  state: "starting",
                  endedAt: undefined,
                  finalText: undefined,
                  progress: undefined,
                  warning: undefined,
                  warningSource: undefined,
                  systemWarning: undefined,
                  error: undefined,
                  lastActivityAt: yield* Clock.currentTimeMillis,
                };
                yield* publish;
                return {
                  record: selected,
                  retained: true as const,
                  previous,
                  attemptToken,
                };
              }
              // A retained report starts a new assignment through `controls.start`; it is not
              // active-turn steering and does not rely on the backend's `steer` capability.
              yield* requireCapability(selected, "steer");
              if (selected.view.state === "paused" || selected.view.state === "completed") {
                const recovery = hasSubagentCapability(selected.view, "resume")
                  ? `resume it with subagent_lifecycle({ action: "resume", runIds: ["${id}"] }) before sending guidance`
                  : `this backend cannot resume it; stop it with subagent_lifecycle({ action: "stop", runIds: ["${id}"] }) and start a replacement`;
                return yield* new InvalidSubagentRequestError({
                  code: "run_not_running",
                  message: `Subagent ${id} is ${selected.view.state}; ${recovery}.`,
                });
              }
              if (selected.view.state === "starting")
                return yield* new InvalidSubagentRequestError({
                  code: "run_starting",
                  message: `Subagent ${id} is still starting; wait for it to start before retrying subagent_send.`,
                });
              if (selected.view.state !== "running")
                return yield* new InvalidSubagentRequestError({
                  code: "run_not_running",
                  message: `Subagent ${id} is ${selected.view.state} and cannot receive guidance; inspect it with subagent_status or start a replacement run.`,
                });
              if (selected.pauseRequested)
                return yield* new InvalidSubagentRequestError({
                  code: "interrupt_in_flight",
                  message: `Subagent ${id} already has an interrupt pending and cannot receive new guidance.`,
                });
              return { record: selected, retained: false as const };
            }),
          );
          if (!selected.retained) return selected;

          const record = selected.record;
          const commit = Effect.gen(function* () {
            yield* beginAssignmentBackend(record, normalized, selected.attemptToken).pipe(
              Effect.tapError((error) => {
                if (error._tag === "SubagentProcessError" && isOutcomeUncertain(error))
                  return retainUncertainAssignment(record, selected.attemptToken, error.message);
                return withLock(
                  Effect.gen(function* () {
                    if (!isCurrentIssuingAssignment(record, selected.attemptToken)) return;
                    const sessionEvents = record.view.sessionEvents;
                    record.view = {
                      ...selected.previous.view,
                      sessionEvents,
                      usage: record.view.usage,
                    };
                    record.latestAssistantText = selected.previous.latestAssistantText;
                    record.warningSlots = selected.previous.warningSlots;
                    record.assignment = selected.previous.assignment;
                    record.activeTools.clear();
                    for (const [toolCallId, toolName] of selected.previous.activeTools)
                      record.activeTools.set(toolCallId, toolName);
                    record.pauseRequested = selected.previous.pauseRequested;
                    record.pauseOutcome = selected.previous.pauseOutcome;
                    record.replyPendingRequestId = selected.previous.replyPendingRequestId;
                    yield* publish;
                  }),
                );
              }),
            );
            return yield* finalizeGuidance(record, normalized, true);
          });
          const commitFiber = yield* commit.pipe(
            Effect.forkIn(ownerScope, { startImmediately: true }),
          );
          return { ...selected, commitFiber };
        }),
      );
      if (selected.retained) return yield* Fiber.join(selected.commitFiber);

      const record = selected.record;
      return yield* Effect.acquireUseRelease(
        withLock(
          Effect.gen(function* () {
            const current = yield* requireRecord(id);
            if (current !== record || current.view.state !== "running")
              return yield* new InvalidSubagentRequestError({
                code: "run_not_running",
                message: `Subagent ${id} is ${current.view.state} and cannot receive guidance; inspect it with subagent_status or start a replacement run.`,
              });
            if (current.pauseRequested)
              return yield* new InvalidSubagentRequestError({
                code: "interrupt_in_flight",
                message: `Subagent ${id} already has an interrupt pending and cannot receive new guidance.`,
              });
            admitTurnInput(current);
            return current;
          }),
        ),
        (admitted) =>
          steerBackend(admitted, normalized).pipe(
            Effect.tapError((error) =>
              error._tag === "SubagentProcessError" && isOutcomeUncertain(error)
                ? retainControlWarning(admitted, error.message)
                : Effect.void,
            ),
            Effect.andThen(finalizeGuidance(admitted, normalized, false)),
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
              return yield* new InvalidSubagentRequestError({
                code: "parent_question_missing",
                message: `Subagent ${id} has no pending parent question.`,
              });
            if (record.replyPendingRequestId)
              return yield* new InvalidSubagentRequestError({
                code: "reply_in_flight",
                message: `Subagent ${id} already has a reply in flight.`,
              });
            if (record.pauseRequested)
              return yield* new InvalidSubagentRequestError({
                code: "interrupt_in_flight",
                message: `Subagent ${id} already has an interrupt pending and cannot receive a parent reply.`,
              });
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
              return new SubagentProcessError({
                operation: "reply",
                code: "reply_send_failed",
                message: `The reply to subagent ${id} was not sent; the question remains open for a retry. (${error.message})`,
              });
            return error.code === "transport_outcome_uncertain"
              ? new SubagentProcessError({
                  operation: "reply",
                  code: "reply_outcome_uncertain",
                  message: `The reply to subagent ${id} may already have applied. Inspect with subagent_status before retrying. (${error.message})`,
                })
              : error;
          }),
          Effect.andThen(Clock.currentTimeMillis),
          Effect.flatMap((now) =>
            withLock(
              Effect.gen(function* () {
                if (claimed.record.replyPendingRequestId === claimed.question.requestId)
                  claimed.record.replyPendingRequestId = undefined;
                claimed.record.view = {
                  ...claimed.record.view,
                  lastActivityAt: now,
                  sessionEvents: appendNoticeSessionEvent(
                    claimed.record.view.sessionEvents,
                    "parent",
                    `Reply: ${normalized}`,
                    now,
                  ),
                };
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
            if (
              error._tag === "SubagentProcessError" &&
              (error.code === "question_transport_closed" ||
                error.code === "question_ownership_mismatch")
            )
              return withLock(
                Effect.sync(() => {
                  if (claimed.record.replyPendingRequestId === claimed.question.requestId)
                    claimed.record.replyPendingRequestId = undefined;
                }),
              );
            return withLock(
              Effect.gen(function* () {
                if (claimed.record.replyPendingRequestId !== claimed.question.requestId) return;
                claimed.record.replyPendingRequestId = undefined;
                if (
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
              return yield* new InvalidSubagentRequestError({
                code: "interrupt_state_invalid",
                message: `Subagent ${id} cannot be interrupted while ${selected.view.state}.`,
              });
            if (selected.pauseRequested)
              return yield* new InvalidSubagentRequestError({
                code: "interrupt_in_flight",
                message: `Subagent ${id} already has an interrupt pending.`,
              });
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
            interruptBackend(record),
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
                    return yield* new SubagentProcessError({
                      operation: "interrupt",
                      code: "interrupt_outcome_uncertain",
                      message: `Subagent ${id} did not confirm interruption in time, but the pause request remains pending and may still apply. Inspect with subagent_status before retrying.`,
                    });
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
                return yield* new InvalidSubagentRequestError({
                  code: "interrupt_outcome_uncertain",
                  message: `Subagent ${id} stopped before interruption completed.`,
                });
              record.pauseRequested = false;
              if (record.pauseOutcome === pauseOutcome) record.pauseOutcome = undefined;
              record.pausedAssignmentEpoch = record.assignment.epoch;
              record.activeTools.clear();
              clearRunNativeActivity(record);
              record.view = {
                ...record.view,
                state: "paused",
                question: undefined,
                currentTool: undefined,
                lastActivityAt: now,
              };
              const view = snapshotView(record.view);
              yield* publish;
              return view;
            }),
          );
        }),
    );

  const rename = (id: string, rawName: string): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.gen(function* () {
      const name = sanitizeName(rawName);
      if (!name)
        return yield* new InvalidSubagentRequestError({
          code: "name_required",
          message: "Subagent name is required.",
        });
      const selected = yield* withLock(
        Effect.gen(function* () {
          const record = yield* requireRecord(id);
          yield* requireCapability(record, "rename-display");
          if (record.view.state === "stopping")
            return yield* new InvalidSubagentRequestError({
              code: "rename_state_invalid",
              message: `Subagent ${id} cannot be renamed while stopping.`,
            });
          if (
            record.view.state !== "running" &&
            record.view.state !== "waiting_for_parent" &&
            record.view.state !== "paused" &&
            record.view.state !== "reported"
          ) {
            record.launch = { ...record.launch, name };
            record.view = { ...record.view, name };
            yield* publish;
            return { record, localView: snapshotView(record.view) };
          }
          return { record };
        }),
      );
      if (selected.localView) {
        yield* sendPeerNotices(id);
        return selected.localView;
      }
      yield* renameBackend(selected.record, name);
      const view = yield* withLock(
        Effect.gen(function* () {
          if (
            selected.record.view.state === "stopping" ||
            isTerminalRunState(selected.record.view.state)
          )
            return yield* new InvalidSubagentRequestError({
              code: "rename_outcome_uncertain",
              message: `Subagent ${id} stopped before rename completed.`,
            });
          selected.record.launch = { ...selected.record.launch, name };
          selected.record.view = { ...selected.record.view, name };
          yield* publish;
          return snapshotView(selected.record.view);
        }),
      );
      yield* sendPeerNotices(id);
      return view;
    });

  const stop = (id: string): Effect.Effect<SubagentRunView, SubagentError> =>
    runSessionOwned(
      ownerScope,
      Effect.gen(function* () {
        const stopError = new SubagentProcessError({
          operation: "stop",
          message: `Subagent ${id} was stopped.`,
        });
        return yield* withLock(
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
            selected.activeTools.clear();
            clearRunNativeActivity(selected);
            selected.view = {
              ...selected.view,
              state: "stopping",
              question: undefined,
              currentTool: undefined,
            };
            failPendingResponses(selected, stopError);
            yield* publish;
            return { record: selected, cleanupRequired: true as const };
          }),
        );
      }),
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
