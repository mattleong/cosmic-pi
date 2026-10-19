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
  agentMessageRefusal,
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
  isResumableRunState,
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
import { spentAtLimitLocked } from "./session-usage.ts";
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
  if (!isResumableRunState(state))
    return invalidRequest("resume_state_invalid", `Subagent ${id} cannot resume while ${state}.`);
  if (record.view.supersededByRunId)
    return invalidRequest(
      "resume_superseded",
      `Subagent ${id} was already continued as ${record.view.supersededByRunId}; follow that run instead.`,
    );
  if (record.retryClaim)
    return invalidRequest(
      "resume_retry_claimed",
      `Subagent ${id} has a next-candidate retry in progress and cannot resume.`,
    );
  // A finished run respawns from its session file only after its last process is gone.
  if (
    isTerminalRunState(state) &&
    (record.process !== undefined || record.cleanupDisposition !== "confirmed")
  )
    return invalidRequest(
      "resume_cleanup_unsettled",
      `Subagent ${id} cleanup is not confirmed; inspect it with agent_read before resuming.`,
    );
  if (!hasCompletionGenerationCapacity(record))
    return invalidRequest(
      "report_delivery_backlog",
      `Subagent ${id} has ${record.completionGenerations.size} unresolved outcome generations; wait for parent delivery or claim the latest outcome before resuming.`,
    );
  return undefined;
};

const resumeUnavailableError = (record: RunRecord): InvalidSubagentRequestError => {
  const { id, runtime, state } = record.view;
  const recovery =
    state === "failed"
      ? ` Retry it on its next candidate with agent_lifecycle({ action: "retry", runIds: ["${id}"] }) or start a new run.`
      : " Start a new run instead.";
  return invalidRequest(
    "backend_resume_unavailable",
    `Subagent ${id} cannot resume because local/${runtime} did not provide continuation state.${recovery}`,
  );
};

/** An agent message that resumes a run; any agent in the tree may send one. */
export interface AgentMessageResume {
  /** Labels the sender in the resumed assignment's report notice. */
  readonly resumedBy: string;
  /** Records the message in the run's session events, in place of the parent's resume notice. */
  readonly recordNoticeLocked: (record: RunRecord, now: number) => void;
}

interface ClaimedResume {
  readonly record: RunRecord;
  readonly needsRespawn: boolean;
  readonly attemptToken: string;
}

interface RunResumeDependencies extends Pick<
  RunContext,
  | "ownerScope"
  | "records"
  | "withLock"
  | "publish"
  | "writerLeases"
  | "requireRecord"
  | "allocateAssignmentAttemptToken"
  | "sendPeerNotices"
  | "sessionUsage"
> {
  readonly writerPools: WriterPoolLookup & Pick<WriterPools, "joinLocked">;
  readonly currentNesting: Effect.Effect<SubagentNestingPolicy>;
  /** The root's `sessionSpendLimit`, which also stops agent messages from resuming runs. */
  readonly currentSpendLimit: Effect.Effect<number | undefined>;
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
    sessionUsage,
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
              `Subagent ${id} cleanup did not finish within 10 seconds; inspect it with agent_read before retrying resume.`,
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
    agentMessage: AgentMessageResume | undefined,
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
          if (agentMessage) agentMessage.recordNoticeLocked(resumed, now);
          else
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
    agentMessage?: AgentMessageResume,
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
                isResumableRunState(record.view.state),
            };
          }),
        ),
      ),
      Effect.flatMap((candidate) =>
        Effect.gen(function* () {
          const spendLimit = agentMessage ? yield* dependencies.currentSpendLimit : undefined;
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
                selected,
              );
              if (writerFailure) return yield* writerFailure;
              return undefined;
            });
          const respawnCapacityFailureLocked = (selected: RunRecord) =>
            Effect.gen(function* () {
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
                  workspaces.heldLaunchSlots(),
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
            // An explicit stop of a subtree outranks agent messages until it finishes.
            if (agentMessage && selected.subtreeStopsInProgress > 0)
              return yield* agentMessageRefusal(
                "agent_unavailable",
                `Agent ${id} is being stopped with its subtree; send again once the stop finishes.`,
              );
            // Like a new start, a resume by an agent message spends under the session's limit.
            const spent = spentAtLimitLocked(sessionUsage, records, spendLimit);
            if (spendLimit !== undefined && spent !== undefined)
              return yield* agentMessageRefusal(
                "agent_spend_limit",
                `This session's subagents have spent $${spent.toFixed(2)} of its $${spendLimit.toFixed(2)} limit (sessionSpendLimit); agent messages can't resume ${id}.`,
              );
            const needsRespawn = selected.process === undefined;
            if (needsRespawn && !selected.resumeToken)
              return yield* resumeUnavailableError(selected);
            // Ownership first: a revision successor in this workspace would otherwise surface as a
            // transient writer conflict.
            const invalidateWorkspace = yield* workspaces.invalidateForResume(selected);
            if (selected.view.writeIntent === "writer")
              yield* writerFailureLocked(selected, needsRespawn);
            if (needsRespawn) yield* respawnCapacityFailureLocked(selected);
            return { selected, needsRespawn, invalidateWorkspace };
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
                  const { selected, needsRespawn, invalidateWorkspace } = yield* admitLocked;
                  const attemptToken = allocateAssignmentAttemptToken();
                  // An explicit resume supersedes an earlier stop or failure of this run.
                  selected.stoppedByParent = false;
                  selected.backendFailure = undefined;
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
                  beginNextAssignmentLocked(
                    selected,
                    attemptToken,
                    now,
                    { question: undefined, currentTool: undefined },
                    agentMessage?.resumedBy,
                  );
                  invalidateWorkspace();
                  yield* publish;
                  return { record: selected, needsRespawn, attemptToken };
                }),
              );
              return { prompt, now, claimed };
            }),
            (admitted) =>
              commitResume(id, admitted.claimed, admitted.prompt, admitted.now, agentMessage),
          );
        }),
      ),
    );

  return {
    resume,
  };
}
