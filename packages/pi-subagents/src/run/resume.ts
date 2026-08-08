import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import type { BackendStartupState } from "../backend/model.ts";
import type { WriterLeaseShape } from "../boundary/writer-lease.ts";
import { processCapacityError, writerConflictError } from "./admission.ts";
import { hasCompletionGenerationCapacity } from "./completion.ts";
import { validateParentMessage } from "./coordination.ts";
import {
  InvalidSubagentRequestError,
  type SubagentError,
  SubagentNotFoundError,
  SubagentProcessError,
  UnsupportedSafeWriterOwnershipError,
  UnsupportedSubagentCapabilityError,
} from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { isTerminalRunState, type SubagentCapability, type SubagentRunView } from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import { snapshotView } from "./state.ts";
import { emptyRunWarningSlots } from "./warnings.ts";

export interface RunResumeDependencies {
  readonly ownerScope: Scope.Scope;
  readonly records: ReadonlyMap<string, RunRecord>;
  /** The shared service lock guarding every RunRecord mutation. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly publish: () => void;
  readonly writerLeases: WriterLeaseShape;
  readonly delivery: RunNotificationDelivery;
  readonly requireRecord: (id: string) => Effect.Effect<RunRecord, SubagentNotFoundError>;
  readonly requireCapability: (
    record: RunRecord,
    capability: SubagentCapability,
  ) => Effect.Effect<void, UnsupportedSubagentCapabilityError>;
  /** Assignment-attempt token allocation stays owned by the service. */
  readonly allocateAssignmentAttemptToken: () => string;
  /** Late-bound process-lifecycle initializer; resolved at call time. */
  readonly initializeProcess: (
    record: RunRecord,
  ) => Effect.Effect<BackendStartupState, SubagentError>;
  readonly submitPrompt: (
    record: RunRecord,
    message: string,
    operation: "start" | "resume",
    attemptToken: string,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly settle: (
    record: RunRecord,
    state: "completed" | "failed" | "stopped",
    error?: string,
  ) => Effect.Effect<SubagentRunView>;
  readonly failRun: (
    record: RunRecord,
    message: string,
    pendingError?: SubagentError,
  ) => Effect.Effect<SubagentRunView>;
  readonly closeRecordScope: (record: RunRecord) => Effect.Effect<void>;
  readonly retainUncertainAssignment: (
    record: RunRecord,
    attemptToken: string,
    warning: string,
  ) => Effect.Effect<void>;
  /** Late-bound process-lifecycle peer notifier; resolved at call time. */
  readonly sendPeerNotices: (changedId: string) => Effect.Effect<void>;
}

/**
 * Owns paused/completed-run resumption: cleanup waiting, assignment epoch
 * rollover, replacement backend/lease scopes, completion backlog and writer
 * admission guards, respawn/initialization uncertainty, and uninterruptible
 * ownership of the resume commit.
 */
export function makeRunResume(dependencies: RunResumeDependencies) {
  const {
    ownerScope,
    records,
    withLock,
    publish,
    writerLeases,
    delivery,
    requireRecord,
    requireCapability,
    allocateAssignmentAttemptToken,
    initializeProcess,
    submitPrompt,
    settle,
    failRun,
    closeRecordScope,
    retainUncertainAssignment,
    sendPeerNotices,
  } = dependencies;

  const waitForRunCleanup: (id: string) => Effect.Effect<void, SubagentNotFoundError> = (id) =>
    withLock(
      Effect.gen(function* () {
        const record = yield* requireRecord(id);
        return record.cleanupPending;
      }),
    ).pipe(
      Effect.flatMap((cleanupPending) =>
        cleanupPending
          ? Effect.sleep("25 millis").pipe(Effect.andThen(waitForRunCleanup(id)))
          : Effect.void,
      ),
    );

  const waitForRunCleanupBounded = (
    id: string,
  ): Effect.Effect<void, SubagentNotFoundError | SubagentProcessError> =>
    waitForRunCleanup(id).pipe(
      Effect.timeoutOption("10 seconds"),
      Effect.flatMap((outcome) =>
        Option.isSome(outcome)
          ? Effect.void
          : Effect.fail(
              new SubagentProcessError({
                operation: "resume",
                code: "cleanup_timeout",
                message: `Subagent ${id} cleanup did not finish within 10 seconds; inspect with subagent_status before retrying resume.`,
              }),
            ),
      ),
    );

  const resume = (id: string, message?: string): Effect.Effect<SubagentRunView, SubagentError> =>
    waitForRunCleanupBounded(id).pipe(
      Effect.andThen(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const prompt = message?.trim()
              ? yield* validateParentMessage(message, "Resume message is required.")
              : "Continue the assigned task from the current session state.";
            const nextSettlement = yield* Deferred.make<SubagentRunView>();
            const now = yield* Clock.currentTimeMillis;
            const claimed = yield* withLock(
              Effect.gen(function* () {
                const selected = yield* requireRecord(id);
                yield* requireCapability(selected, "resume");
                if (selected.evictionReclaimClaim)
                  return yield* new InvalidSubagentRequestError({
                    code: "resume_state_invalid",
                    message: `Subagent ${id} is being evicted by start admission and can no longer resume.`,
                  });
                if (selected.view.state !== "paused" && selected.view.state !== "completed")
                  return yield* new InvalidSubagentRequestError({
                    code: "resume_state_invalid",
                    message:
                      selected.view.state === "reported"
                        ? `Subagent ${id} is retained after report generation ${selected.view.reportGeneration}; use subagent_send to begin its next assignment on the same backend resource.`
                        : `Subagent ${id} cannot resume while ${selected.view.state}.`,
                  });
                if (!hasCompletionGenerationCapacity(selected))
                  return yield* new InvalidSubagentRequestError({
                    code: "report_delivery_backlog",
                    message: `Subagent ${id} has ${selected.completionGenerations.size} unresolved outcome generations; wait for parent delivery or claim the latest outcome before resuming.`,
                  });
                if (selected.view.writeIntent === "writer") {
                  if (writerLeases.platform === "win32")
                    return yield* new UnsupportedSafeWriterOwnershipError({
                      code: "unsupported_safe_writer_ownership",
                      platform: writerLeases.platform,
                      message:
                        "Writer subagents cannot respawn on Windows because descendant termination cannot yet be proven without Job Object ownership.",
                    });
                  const canonicalCwd = selected.canonicalWriterCwd;
                  if (!canonicalCwd)
                    return yield* new InvalidSubagentRequestError({
                      code: "writer_cwd_canonicalization_missing",
                      message: `Subagent ${id} has no canonical writer cwd ownership evidence.`,
                    });
                  const writerFailure = writerConflictError(records, canonicalCwd, selected);
                  if (writerFailure) return yield* writerFailure;
                }
                const needsRespawn = selected.process === undefined;
                if (needsRespawn) {
                  const capacityFailure = processCapacityError(records, selected);
                  if (capacityFailure) return yield* capacityFailure;
                  if (!selected.resumeToken)
                    return yield* new InvalidSubagentRequestError({
                      code: "backend_resume_unavailable",
                      message: `Subagent ${id} cannot resume because ${selected.view.host}/${selected.view.runtime} did not provide continuation state.`,
                    });
                }
                const attemptToken = allocateAssignmentAttemptToken();
                selected.settlement = nextSettlement;
                selected.pauseRequested = false;
                selected.pauseOutcome = undefined;
                selected.pausedAssignmentEpoch = undefined;
                selected.activeTools.clear();
                selected.notificationGeneration += 1;
                selected.questionNotificationGeneration = selected.notificationGeneration;
                delivery.discardRunQuestionsLocked(selected.view.id);
                selected.replyPendingRequestId = undefined;
                selected.initializationPending = needsRespawn;
                selected.pendingInitializationSettlement = undefined;
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
                  question: undefined,
                  currentTool: undefined,
                  warning: undefined,
                  endedAt: undefined,
                  error: undefined,
                  lastActivityAt: now,
                };
                publish();
                return { record: selected, needsRespawn, attemptToken };
              }),
            );
            const commit = Effect.gen(function* () {
              const record = claimed.record;
              if (claimed.needsRespawn) {
                const nextScope = yield* Scope.make();
                const nextWriterLeaseScope = claimed.record.canonicalWriterCwd
                  ? yield* Scope.make()
                  : undefined;
                const nextWriterLeaseReleaseState = nextWriterLeaseScope
                  ? { authorized: false }
                  : undefined;
                const installed = yield* withLock(
                  Effect.sync(() => {
                    if (
                      record.stoppedByParent ||
                      record.view.state !== "starting" ||
                      record.process !== undefined
                    )
                      return false;
                    record.scope = nextScope;
                    record.cleanupPending = false;
                    record.closingScope = undefined;
                    record.closingScopeSettled = undefined;
                    record.writerLease = undefined;
                    record.writerLeaseScope = nextWriterLeaseScope;
                    record.writerLeasePreparationState = nextWriterLeaseScope
                      ? "pending"
                      : undefined;
                    record.writerLeaseReleaseState = nextWriterLeaseReleaseState;
                    record.launch = {
                      ...record.launch,
                      resumeToken: record.resumeToken,
                    };
                    return true;
                  }),
                );
                if (!installed) {
                  yield* Scope.close(nextScope, Exit.void);
                  if (nextWriterLeaseScope) yield* Scope.close(nextWriterLeaseScope, Exit.void);
                  return yield* new InvalidSubagentRequestError({
                    code: "resume_cancelled",
                    message: `Subagent ${id} stopped before its session could be restored.`,
                  });
                }
                const state = yield* initializeProcess(record);
                const resolvedModel = state.model ?? record.view.model;
                const committed = yield* withLock(
                  Effect.sync(() => {
                    if (record.view.state !== "starting") return undefined;
                    record.initializationPending = false;
                    record.resumeToken = state.resumeToken;
                    const pendingSettlement = record.pendingInitializationSettlement;
                    record.pendingInitializationSettlement = undefined;
                    record.view = {
                      ...record.view,
                      model: resolvedModel,
                      effort: state.effort,
                      sessionId: state.sessionId,
                      ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
                    };
                    publish();
                    return pendingSettlement;
                  }),
                );
                if (committed) {
                  if (committed.state === "failed")
                    return yield* failRun(
                      record,
                      committed.error ?? "Subagent failed while resuming.",
                    ).pipe(Effect.tap(() => closeRecordScope(record)));
                  return yield* settle(record, committed.state, committed.error);
                }
              }
              const issued = yield* submitPrompt(
                claimed.record,
                prompt,
                "resume",
                claimed.attemptToken,
              );
              const view = yield* withLock(
                Effect.sync(() => {
                  const record = claimed.record;
                  if (issued.state !== "running") return snapshotView(record.view);
                  record.view = {
                    ...record.view,
                    sessionEvents: appendNoticeSessionEvent(
                      record.view.sessionEvents,
                      "parent",
                      `Resume: ${prompt}`,
                      now,
                    ),
                  };
                  publish();
                  return snapshotView(record.view);
                }),
              );
              if (view.state !== "running" && !isTerminalRunState(view.state))
                return yield* new SubagentProcessError({
                  operation: "resume",
                  message: view.error ?? `Subagent ${id} stopped before resume completed.`,
                });
              yield* sendPeerNotices(id);
              return view;
            }).pipe(
              Effect.tapError((error) =>
                error._tag === "SubagentProcessError" && error.code === "resume_outcome_uncertain"
                  ? withLock(
                      Effect.sync(() => {
                        claimed.record.initializationPending = false;
                        const pending = claimed.record.pendingInitializationSettlement;
                        claimed.record.pendingInitializationSettlement = undefined;
                        return pending;
                      }),
                    ).pipe(
                      Effect.flatMap((pending) =>
                        pending
                          ? pending.state === "failed"
                            ? failRun(
                                claimed.record,
                                pending.error ?? "Subagent failed while resuming.",
                              ).pipe(Effect.asVoid)
                            : settle(claimed.record, pending.state, pending.error).pipe(
                                Effect.asVoid,
                              )
                          : retainUncertainAssignment(
                              claimed.record,
                              claimed.attemptToken,
                              error.message,
                            ),
                      ),
                    )
                  : withLock(
                      Effect.sync(() => {
                        claimed.record.initializationPending = false;
                        claimed.record.pendingInitializationSettlement = undefined;
                      }),
                    ).pipe(
                      Effect.andThen(failRun(claimed.record, error.message)),
                      Effect.andThen(closeRecordScope(claimed.record)),
                      Effect.asVoid,
                    ),
              ),
            );
            const commitFiber = yield* commit.pipe(
              Effect.forkIn(ownerScope, { startImmediately: true }),
            );
            return yield* restore(Fiber.join(commitFiber));
          }),
        ),
      ),
    );

  return {
    /** Bounded cleanup wait plus uninterruptible epoch-rollover resume coordinator. */
    resume,
  };
}

export type RunResume = ReturnType<typeof makeRunResume>;
