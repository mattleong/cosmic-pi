import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import {
  canonicalizeWriterCwd,
  processCapacityError,
  treeCapacityError,
  writerConflictError,
} from "./admission.ts";
import { DEFAULT_MAX_ACTIVE_RUNS, type SubagentNestingPolicy } from "../config/schema.ts";
import { beginNextAssignmentLocked, type RunAssignment } from "./assignment.ts";
import { hasCompletionGenerationCapacity } from "./completion.ts";
import { validateParentMessage } from "./tool-policy.ts";
import {
  invalidRequest,
  type InvalidSubagentRequestError,
  processError,
  type SubagentError,
  SubagentProcessError,
} from "./errors.ts";
import {
  clearRunActivity,
  commitRunInitialization,
  completeRunInitialization,
  type PendingInitializationSettlement,
  requireCapability,
  type RunContext,
  type RunRecord,
} from "./internal.ts";
import {
  isTerminalRunState,
  SUBAGENT_ROOT_RUN_ID,
  type SubagentRunView,
  type SubagentControlExpectation,
} from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import type { RunProcessInitializer } from "./process-lifecycle.ts";
import type { WriterPoolLookup, WriterPools } from "./writer-pool.ts";
import type { RunRecordCleanup } from "./record-cleanup.ts";
import type { RunSettlement } from "./settlement.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import { runSessionOwned } from "./session-owned.ts";
import { snapshotView } from "./state.ts";
import type { RunWorkspaceControl } from "./workspace-control.ts";
import { requireControlExpectation } from "./control-admission.ts";

const resumeStateError = (record: RunRecord): InvalidSubagentRequestError | undefined => {
  const { id, state } = record.view;
  if (record.evictionClaim)
    return invalidRequest(
      "resume_state_invalid",
      `Subagent ${id} is being evicted by start admission and can no longer resume.`,
    );
  if (record.runStateReclaimState === "reclaimed")
    return invalidRequest(
      "resume_state_reclaimed",
      `Subagent ${id} cannot resume because its private continuation state was already reclaimed.`,
    );
  if (state !== "paused" && state !== "completed")
    return invalidRequest("resume_state_invalid", `Subagent ${id} cannot resume while ${state}.`);
  if (record.stoppedByParent)
    return invalidRequest("resume_cancelled", `Subagent ${id} was stopped and cannot resume.`);
  if (!hasCompletionGenerationCapacity(record))
    return invalidRequest(
      "report_delivery_backlog",
      `Subagent ${id} has ${record.completionGenerations.size} unresolved outcome generations; wait for parent delivery or claim the latest outcome before resuming.`,
    );
  return undefined;
};

interface ClaimedResume {
  readonly record: RunRecord;
  readonly needsRespawn: boolean;
  readonly attemptToken: string;
}

export interface RunResumeDependencies extends Pick<
  RunContext,
  | "ownerScope"
  | "records"
  | "withLock"
  | "publish"
  | "writerLeases"
  | "requireRecord"
  | "allocateAssignmentAttemptToken"
  | "sendPeerNotices"
> {
  readonly writerPools: WriterPoolLookup & Pick<WriterPools, "joinLocked">;
  readonly currentNesting: Effect.Effect<SubagentNestingPolicy>;
  readonly delivery: RunNotificationDelivery;
  readonly initializeProcess: RunProcessInitializer;
  readonly assignment: RunAssignment;
  readonly settlement: Pick<RunSettlement, "settle" | "failRun">;
  readonly closeRecordScope: RunRecordCleanup["closeRecordScope"];
  readonly workspaces: Pick<RunWorkspaceControl, "invalidateForResume" | "heldLaunchSlots">;
}

export function resumeOperations(dependencies: RunResumeDependencies) {
  const {
    ownerScope,
    records,
    writerPools,
    withLock,
    publish,
    writerLeases,
    delivery,
    requireRecord,
    allocateAssignmentAttemptToken,
    initializeProcess,
    assignment,
    settlement,
    closeRecordScope,
    workspaces,
    sendPeerNotices,
  } = dependencies;

  const waitForRunCleanup = (id: string) =>
    withLock(
      Effect.gen(function* () {
        const record = yield* requireRecord(id);
        return record.cleanupPending ? record.cleanupSettlement : undefined;
      }),
    ).pipe(
      Effect.flatMap((cleanupSettlement) =>
        cleanupSettlement === undefined
          ? Effect.void
          : Deferred.await(cleanupSettlement).pipe(
              Effect.flatMap((outcome) =>
                outcome === "confirmed"
                  ? Effect.void
                  : Effect.fail(
                      processError(
                        "resume",
                        "cleanup_unconfirmed",
                        `Subagent ${id} cleanup could not be confirmed; resume remains blocked for this session.`,
                      ),
                    ),
              ),
            ),
      ),
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () =>
          Effect.fail(
            processError(
              "resume",
              "cleanup_timeout",
              `Subagent ${id} cleanup did not finish within 10 seconds; inspect with subagent_status before retrying resume.`,
            ),
          ),
      }),
    );

  const settlePendingInitialization = (
    record: RunRecord,
    pending: PendingInitializationSettlement,
  ) =>
    pending.state === "failed"
      ? settlement.failRun(record, pending.error ?? "Subagent failed while resuming.")
      : settlement.settle(record, pending.state, pending.error);

  const commitResume = (
    id: string,
    claimed: ClaimedResume,
    prompt: string,
    now: number,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.gen(function* () {
      const record = claimed.record;
      if (claimed.needsRespawn) {
        const nextScope = yield* Scope.make();
        const nextCleanupSettlement = yield* Deferred.make<"confirmed" | "quarantined">();
        const installed = yield* withLock(
          Effect.gen(function* () {
            if (
              record.stoppedByParent ||
              record.view.state !== "starting" ||
              record.process !== undefined
            )
              return false;
            const writerPool = record.canonicalWriterCwd
              ? yield* writerPools.joinLocked(record.canonicalWriterCwd, record.view.id)
              : undefined;
            record.scope = nextScope;
            record.cleanupSettlement = nextCleanupSettlement;
            record.cleanupPending = false;
            record.cleanupDisposition = "pending";
            record.cleanupRecovery = undefined;
            record.cleanupVerification = undefined;
            record.view = { ...record.view, cleanup: undefined };
            record.closingScope = undefined;
            record.closingScopeSettled = undefined;
            record.writerPool = writerPool;
            record.writeViolationContainmentStarted = false;
            record.launch = {
              ...record.launch,
              resumeToken: record.resumeToken,
            };
            return true;
          }),
        );
        if (!installed) {
          yield* Scope.close(nextScope, Exit.void);
          return yield* invalidRequest(
            "resume_cancelled",
            `Subagent ${id} stopped before its session could be restored.`,
          );
        }
        const state = yield* initializeProcess(record);
        const committed = yield* withLock(
          Effect.gen(function* () {
            if (record.view.state !== "starting") return undefined;
            const pendingSettlement = commitRunInitialization(record, state);
            yield* publish;
            return pendingSettlement;
          }),
        );
        if (committed)
          return yield* settlePendingInitialization(record, committed).pipe(
            Effect.tap(() =>
              committed.state === "failed" ? closeRecordScope(record) : Effect.void,
            ),
          );
      }
      const issued = yield* assignment.submitPrompt(
        claimed.record,
        prompt,
        "resume",
        claimed.attemptToken,
      );
      const view = yield* withLock(
        Effect.gen(function* () {
          const resumed = claimed.record;
          if (issued.state !== "running") return snapshotView(resumed.view);
          resumed.view = {
            ...resumed.view,
            sessionEvents: appendNoticeSessionEvent(
              resumed.view.sessionEvents,
              "parent",
              `Resume: ${prompt}`,
              now,
            ),
          };
          yield* publish;
          return snapshotView(resumed.view);
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
        withLock(Effect.sync(() => completeRunInitialization(claimed.record))).pipe(
          Effect.flatMap((pending) => {
            if (
              !Predicate.isTagged(error, "SubagentProcessError") ||
              error.code !== "resume_outcome_uncertain"
            )
              return settlement
                .failRun(claimed.record, error.message)
                .pipe(Effect.andThen(closeRecordScope(claimed.record)));
            return pending
              ? settlePendingInitialization(claimed.record, pending)
              : assignment.retainUncertainAssignment(
                  claimed.record,
                  claimed.attemptToken,
                  error.message,
                );
          }),
          Effect.asVoid,
        ),
      ),
    );

  const resume = (
    id: string,
    message?: string,
    expected?: SubagentControlExpectation,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    waitForRunCleanup(id).pipe(
      Effect.andThen(
        withLock(
          Effect.gen(function* () {
            const record = yield* requireRecord(id);
            yield* requireCapability(record, "resume");
            return {
              record,
              assignment: record.assignment,
              process: record.process,
              cwd: record.launch.cwd,
              validateCwd:
                record.view.writeIntent === "writer" &&
                record.process === undefined &&
                (record.view.state === "paused" || record.view.state === "completed"),
            };
          }),
        ),
      ),
      Effect.flatMap((candidate) =>
        Effect.gen(function* () {
          const currentCwd = candidate.validateCwd
            ? yield* canonicalizeWriterCwd(writerLeases, candidate.cwd)
            : undefined;
          const isCurrentCandidate = (record: RunRecord) =>
            record === candidate.record &&
            record.assignment === candidate.assignment &&
            record.process === candidate.process &&
            record.launch.cwd === candidate.cwd;
          const hasCurrentWriterCwd = (record: RunRecord) =>
            currentCwd !== undefined &&
            currentCwd.filesystemIdentity === record.canonicalWriterCwd?.filesystemIdentity &&
            currentCwd.digest === record.canonicalWriterCwd?.digest;
          const writerFailureLocked = (selected: RunRecord, needsRespawn: boolean) =>
            Effect.gen(function* () {
              const canonicalCwd = selected.canonicalWriterCwd;
              if (!canonicalCwd)
                return yield* invalidRequest(
                  "writer_cwd_canonicalization_missing",
                  `Subagent ${id} has no canonical writer cwd ownership evidence.`,
                );
              if (needsRespawn && !hasCurrentWriterCwd(selected))
                return yield* invalidRequest(
                  "writer_cwd_identity_changed",
                  `Subagent ${id} cannot resume because its writer directory identity changed.`,
                );
              const writerFailure = writerConflictError(
                records,
                writerPools,
                canonicalCwd,
                selected.view.writeClaims,
                selected,
              );
              if (writerFailure) return yield* writerFailure;
              return undefined;
            });
          const respawnFailureLocked = (selected: RunRecord) =>
            Effect.gen(function* () {
              if (!selected.resumeToken)
                return yield* invalidRequest(
                  "backend_resume_unavailable",
                  `Subagent ${id} cannot resume because ${selected.view.host}/${selected.view.runtime} did not provide continuation state.`,
                );
              const parentRunId = selected.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
              const nesting = yield* dependencies.currentNesting;
              const capacityFailure =
                processCapacityError(
                  records,
                  parentRunId,
                  nesting.maxDirectChildren,
                  selected,
                  workspaces.heldLaunchSlots(parentRunId),
                ) ??
                treeCapacityError(
                  records,
                  nesting.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS,
                  selected,
                  workspaces.heldLaunchSlots(parentRunId),
                );
              if (capacityFailure) return yield* capacityFailure;
              return undefined;
            });
          const admitLocked = Effect.gen(function* () {
            const selected = yield* requireRecord(id);
            yield* requireControlExpectation(selected, expected);
            if (!isCurrentCandidate(selected))
              return yield* invalidRequest(
                "resume_state_invalid",
                `Subagent ${id} changed while resume was being prepared.`,
              );
            yield* requireCapability(selected, "resume");
            const stateFailure = resumeStateError(selected);
            if (stateFailure) return yield* stateFailure;
            const needsRespawn = selected.process === undefined;
            if (selected.view.writeIntent === "writer")
              yield* writerFailureLocked(selected, needsRespawn);
            if (needsRespawn) yield* respawnFailureLocked(selected);
            return { selected, needsRespawn };
          });
          const prompt = message?.trim()
            ? yield* validateParentMessage(message, "Resume message is required.")
            : "Continue the assigned task from the current session state.";
          return yield* runSessionOwned(
            ownerScope,
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const claimed = yield* withLock(
                Effect.gen(function* () {
                  const { selected, needsRespawn } = yield* admitLocked;
                  const invalidateWorkspace = yield* workspaces.invalidateForResume(selected);
                  const attemptToken = allocateAssignmentAttemptToken();
                  selected.pauseRequested = false;
                  selected.pauseOutcome = undefined;
                  clearRunActivity(selected);
                  selected.notificationGeneration += 1;
                  delivery.discardQuestionLocked(selected.view.id);
                  selected.replyPendingRequestId = undefined;
                  selected.initializationPending = needsRespawn;
                  selected.initializationSettled = needsRespawn
                    ? Deferred.makeUnsafe<void>()
                    : undefined;
                  selected.pendingInitializationSettlement = undefined;
                  beginNextAssignmentLocked(selected, attemptToken, now, {
                    question: undefined,
                    currentTool: undefined,
                  });
                  invalidateWorkspace();
                  yield* publish;
                  return { record: selected, needsRespawn, attemptToken };
                }),
              );
              return { prompt, now, claimed };
            }),
            (admitted) => commitResume(id, admitted.claimed, admitted.prompt, admitted.now),
          );
        }),
      ),
    );

  return {
    resume,
  };
}
