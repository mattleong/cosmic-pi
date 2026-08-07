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
import type { RunRecord } from "./internal.ts";
import {
  InvalidSubagentRequestError,
  type SubagentError,
  SubagentProcessError,
  SubagentNotFoundError,
  UnsupportedSubagentCapabilityError,
} from "./errors.ts";
import { validateParentMessage } from "./coordination.ts";
import { MAX_UNRESOLVED_REPORT_GENERATIONS } from "./limits.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import { sanitizeName, snapshotView } from "./state.ts";
import { emptyRunWarningSlots } from "./warnings.ts";

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
  readonly renameBackend: (record: RunRecord, name: string) => Effect.Effect<void, SubagentError>;
  readonly publish: () => void;
  readonly sendPeerNotices: (changedId: string) => Effect.Effect<void>;
  readonly deliverForeground: (record: RunRecord, view: SubagentRunView) => boolean;
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
    renameBackend,
    publish,
    sendPeerNotices,
    deliverForeground,
    failPendingResponses,
    closeRecordScope,
    settle,
  } = dependencies;

  const send = (id: string, message: string): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.gen(function* () {
      const normalized = yield* validateParentMessage(message, "Guidance message is required.");
      const nextSettlement = yield* Deferred.make<SubagentRunView>();
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
            if (selected.completionGenerations.size >= MAX_UNRESOLVED_REPORT_GENERATIONS)
              return yield* new InvalidSubagentRequestError({
                code: "report_delivery_backlog",
                message: `Subagent ${id} has ${selected.completionGenerations.size} unresolved report generations; wait for parent delivery or claim the latest report before beginning another assignment.`,
              });
            const attemptToken = allocateAssignmentAttemptToken();
            const previous = {
              view: snapshotView(selected.view),
              settlement: selected.settlement,
              latestAssistantText: selected.latestAssistantText,
              warningSlots: { ...selected.warningSlots },
              assignment: { ...selected.assignment },
              activeTools: [...selected.activeTools.entries()] as const,
              pauseRequested: selected.pauseRequested,
              pauseOutcome: selected.pauseOutcome,
              replyPendingRequestId: selected.replyPendingRequestId,
            };
            selected.settlement = nextSettlement;
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
              error: undefined,
              lastActivityAt: yield* Clock.currentTimeMillis,
            };
            publish();
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
          return { record: selected, retained: false as const };
        }),
      );
      const record = selected.record;
      yield* selected.retained
        ? beginAssignmentBackend(record, normalized, selected.attemptToken).pipe(
            Effect.tapError((error) => {
              if (
                error._tag === "SubagentProcessError" &&
                error.code?.endsWith("_outcome_uncertain")
              )
                return retainUncertainAssignment(record, selected.attemptToken, error.message);
              return withLock(
                Effect.sync(() => {
                  if (record.assignment.attemptToken !== selected.attemptToken) return;
                  const sessionEvents = record.view.sessionEvents;
                  record.view = { ...selected.previous.view, sessionEvents };
                  record.settlement = selected.previous.settlement;
                  record.latestAssistantText = selected.previous.latestAssistantText;
                  record.warningSlots = selected.previous.warningSlots;
                  record.assignment = selected.previous.assignment;
                  record.activeTools.clear();
                  for (const [toolCallId, toolName] of selected.previous.activeTools)
                    record.activeTools.set(toolCallId, toolName);
                  record.pauseRequested = selected.previous.pauseRequested;
                  record.pauseOutcome = selected.previous.pauseOutcome;
                  record.replyPendingRequestId = selected.previous.replyPendingRequestId;
                  publish();
                }),
              );
            }),
          )
        : steerBackend(record, normalized);
      const now = yield* Clock.currentTimeMillis;
      return yield* withLock(
        Effect.gen(function* () {
          if (record.view.state === "reported" && selected.retained)
            return snapshotView(record.view);
          if (record.view.state !== "running")
            return yield* new InvalidSubagentRequestError({
              code: "guidance_outcome_uncertain",
              message: `Subagent ${id} changed state after guidance was sent, so delivery may already have applied. Inspect with subagent_status before retrying.`,
            });
          if (record.replyPendingRequestId)
            return yield* new InvalidSubagentRequestError({
              code: "guidance_outcome_uncertain",
              message: `Subagent ${id} claimed a parent reply after guidance was sent, so delivery may already have applied. Inspect with subagent_status before retrying.`,
            });
          record.view = {
            ...record.view,
            lastActivityAt: now,
            sessionEvents: appendNoticeSessionEvent(
              record.view.sessionEvents,
              "parent",
              `Guidance: ${normalized}`,
              now,
            ),
          };
          publish();
          return snapshotView(record.view);
        }),
      );
    });

  const reply = (id: string, message: string): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.uninterruptibleMask((restore) =>
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
            const process = record.process;
            if (!process)
              return yield* new SubagentProcessError({
                operation: "reply to",
                message: `Subagent ${id} has no active process.`,
              });
            record.replyPendingRequestId = question.requestId;
            record.view = { ...record.view, state: "running", question: undefined };
            publish();
            return { record, process, question };
          }),
        );
        const commit = claimed.process.controls.reply(claimed.question.requestId, normalized).pipe(
          Effect.mapError((error) =>
            error._tag === "SubagentProcessError" && error.code === "transport_outcome_uncertain"
              ? new SubagentProcessError({
                  operation: "reply",
                  code: "reply_outcome_uncertain",
                  message: `The reply to subagent ${id} may already have applied. Inspect with subagent_status before retrying. (${error.message})`,
                })
              : error,
          ),
          Effect.andThen(Clock.currentTimeMillis),
          Effect.flatMap((now) =>
            withLock(
              Effect.sync(() => {
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
                publish();
                return snapshotView(claimed.record.view);
              }),
            ),
          ),
          // The owner-scoped commit outlives cancellation of the requesting tool.
          // Roll back only when the transport itself reports a definite failure.
          Effect.tapError((error) =>
            error._tag === "SubagentProcessError" && error.code === "reply_outcome_uncertain"
              ? Effect.void
              : withLock(
                  Effect.sync(() => {
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
                      publish();
                    }
                  }),
                ),
          ),
        );
        const commitFiber = yield* commit.pipe(
          Effect.forkIn(ownerScope, { startImmediately: true }),
        );
        return yield* restore(Fiber.join(commitFiber));
      }),
    );

  const interrupt = (id: string): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const pauseOutcome = yield* Deferred.make<SubagentRunView, SubagentError>();
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
            return selected;
          }),
        );
        const commit = Effect.gen(function* () {
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
              record.activeTools.clear();
              record.view = {
                ...record.view,
                state: "paused",
                question: undefined,
                currentTool: undefined,
                lastActivityAt: now,
              };
              const view = snapshotView(record.view);
              publish();
              deliverForeground(record, view);
              return view;
            }),
          );
        });
        const commitFiber = yield* commit.pipe(
          Effect.forkIn(ownerScope, { startImmediately: true }),
        );
        return yield* restore(Fiber.join(commitFiber));
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
            publish();
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
          publish();
          return snapshotView(selected.record.view);
        }),
      );
      yield* sendPeerNotices(id);
      return view;
    });

  const stop = (id: string): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const stopError = new SubagentProcessError({
          operation: "stop",
          message: `Subagent ${id} was stopped.`,
        });
        const claim = yield* withLock(
          Effect.gen(function* () {
            const selected = yield* requireRecord(id);
            if (isTerminalRunState(selected.view.state) || selected.view.state === "stopping")
              return { record: selected, cleanupRequired: false as const };
            selected.stoppedByParent = true;
            selected.cleanupPending = true;
            selected.activeTools.clear();
            selected.view = {
              ...selected.view,
              state: "stopping",
              question: undefined,
              currentTool: undefined,
            };
            failPendingResponses(selected, stopError);
            publish();
            return { record: selected, cleanupRequired: true as const };
          }),
        );
        const record = claim.record;
        if (!claim.cleanupRequired) return snapshotView(record.view);
        const cleanup = closeRecordScope(record).pipe(Effect.andThen(settle(record, "stopped")));
        const cleanupFiber = yield* cleanup.pipe(
          Effect.forkIn(ownerScope, { startImmediately: true }),
        );
        return yield* restore(Fiber.join(cleanupFiber));
      }),
    );

  return { send, reply, interrupt, rename, stop };
}
