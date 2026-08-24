import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { BackendLaunchRequest, BackendStartupState } from "../backend/model.ts";
import type { SubagentBackendRegistryContract } from "../backend/service.ts";
import { isRetainableProfileCandidate } from "../profiles/model.ts";
import type { WriterLeaseContract } from "../boundary/writer-lease.ts";
import { processCapacityError, writerConflictError } from "./admission.ts";
import { peerNoticeText } from "./coordination.ts";
import { childSystemPrompt, taskPrompt } from "./tool-policy.ts";
import {
  InvalidSubagentRequestError,
  type SubagentError,
  SubagentHistoryCapacityError,
  SubagentRuntimeClosedError,
  UnsupportedSafeWriterOwnershipError,
} from "./errors.ts";
import { completeRunInitialization, type RunRecord } from "./internal.ts";
import { MAX_RETAINED_RUNS } from "./limits.ts";
import {
  emptyUsage,
  isTerminalRunState,
  type StartSubagentRequest,
  type SubagentRunView,
} from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import {
  MAX_ERROR_CHARS,
  MAX_TASK_CHARS,
  sanitizeDiagnosticText,
  sanitizeName,
  snapshotView,
} from "./state.ts";
import { emptyRunWarningSlots } from "./warnings.ts";

export interface RunLaunchDependencies {
  readonly ownerScope: Scope.Scope;
  readonly backendRegistry: SubagentBackendRegistryContract;
  readonly writerLeases: WriterLeaseContract;
  /** The service-owned run registry; launch admission inserts and evicts under the lock. */
  readonly records: Map<string, RunRecord>;
  /** The shared service lock guarding every RunRecord mutation. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly publish: Effect.Effect<void>;
  readonly delivery: RunNotificationDelivery;
  readonly redactCompletionReport: (view: SubagentRunView) => SubagentRunView;
  /** Service-owned shutdown flag, observed under the admission lock. */
  readonly isClosed: () => boolean;
  /** Service-owned run ordinal/name allocation, invoked under the admission lock. */
  readonly allocateRunIdentity: (requestedName: string) => {
    readonly id: string;
    readonly name: string;
  };
  /** Service-owned assignment-attempt token allocation, invoked under the admission lock. */
  readonly allocateAssignmentAttemptToken: () => string;
  readonly reclaimRecordRunState: (record: RunRecord) => Effect.Effect<void, SubagentError>;
  /** Quarantines uncertain/partial eviction reclamation so the old run cannot resume. */
  readonly quarantineReclaimFailure: (record: RunRecord) => Effect.Effect<void>;
  readonly markCleanupPending: (record: RunRecord) => Effect.Effect<void>;
  readonly closeRecordScope: (record: RunRecord) => Effect.Effect<void>;
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
  readonly submitPrompt: (
    record: RunRecord,
    message: string,
    operation: "start" | "resume",
    attemptToken: string,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  /** Late-bound process-lifecycle initializer; resolved at call time. */
  readonly initializeProcess: (
    record: RunRecord,
  ) => Effect.Effect<BackendStartupState, SubagentError>;
  /** Late-bound process-lifecycle peer notifier; resolved at call time. */
  readonly sendPeerNotices: (changedId: string) => Effect.Effect<void>;
}

/**
 * Owns run launch: request validation, admission/eviction under history and
 * process/writer capacity, record construction, backend initialization, prompt
 * issue, and the uninterruptible stopped/failed compensation block. Run
 * identity/token allocators remain service-owned and are invoked under the
 * same admission lock.
 */
export function makeRunLaunch(dependencies: RunLaunchDependencies) {
  const {
    ownerScope,
    backendRegistry,
    writerLeases,
    records,
    withLock,
    publish,
    delivery,
    redactCompletionReport,
    isClosed,
    allocateRunIdentity,
    allocateAssignmentAttemptToken,
    reclaimRecordRunState,
    quarantineReclaimFailure,
    markCleanupPending,
    closeRecordScope,
    settle,
    failRun,
    submitPrompt,
    initializeProcess,
    sendPeerNotices,
  } = dependencies;

  const start = (request: StartSubagentRequest): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!request.task.trim())
          return yield* new InvalidSubagentRequestError({
            code: "task_required",
            message: "Subagent task is required.",
          });
        if (request.closeOnReport === false && !isRetainableProfileCandidate(request))
          return yield* new InvalidSubagentRequestError({
            code: "retained_report_capability_invalid",
            message: "closeOnReport=false requires a Herdr-hosted read-only backend.",
          });
        if (request.writeIntent === "writer" && writerLeases.platform === "win32")
          return yield* new UnsupportedSafeWriterOwnershipError({
            code: "unsupported_safe_writer_ownership",
            platform: writerLeases.platform,
            message:
              "Writer subagents are disabled on Windows because descendant termination cannot yet be proven without Job Object ownership. Read-only subagents remain available.",
          });
        const driver = yield* restore(
          backendRegistry.resolve({
            host: request.host,
            runtime: request.runtime,
            context: request.context,
          }),
        );
        const canonicalWriterCwd =
          request.writeIntent === "writer"
            ? yield* restore(
                writerLeases.canonicalize(request.cwd).pipe(
                  Effect.mapError(
                    (error) =>
                      new InvalidSubagentRequestError({
                        code: "writer_cwd_canonicalization_failed",
                        message: error.message,
                      }),
                  ),
                ),
              )
            : undefined;
        // Public profile routing already preflights for ordered fallback. Recheck at the service
        // admission boundary with the canonical writer cwd to close readiness races and protect
        // direct internal callers; failure belongs to the selected candidate and never falls through.
        yield* restore(
          driver.preflight({
            context: request.context,
            writeIntent: request.writeIntent,
            closeOnReport: request.closeOnReport,
            model: request.model,
            effort: request.effort,
            cwd: canonicalWriterCwd?.path ?? request.cwd,
          }),
        );
        if (request.task.length > MAX_TASK_CHARS)
          return yield* new InvalidSubagentRequestError({
            code: "task_too_large",
            message: "Subagent task is too large.",
          });
        const requestedName = sanitizeName(request.name ?? "");
        const now = yield* Clock.currentTimeMillis;
        // Reclaim-before-admit eviction transaction. Phase A (`reserveOrClaim`)
        // claims one eligible terminal candidate under the lock without deleting
        // it while reserving the prospective process/writer admission; phase B
        // reclaims its private run state outside the lock; phase C
        // (`admitReclaimed`) revalidates under the lock and atomically deletes
        // the evicted record, admits the new record, and creates its scopes.
        // Reclaim failure clears the claim, keeps the candidate registered, and
        // admits nothing.
        const evictionEligible = (record: RunRecord): boolean =>
          !record.cleanupPending &&
          record.process === undefined &&
          record.retryClaim === undefined &&
          record.completionClaims.size === 0 &&
          record.completionGenerations.size === 0 &&
          isTerminalRunState(record.view.state);
        const clearEvictionClaim = (candidate: RunRecord) =>
          withLock(
            Effect.sync(() => {
              if (records.get(candidate.view.id) === candidate) candidate.evictionClaim = undefined;
            }),
          );
        const runtimeClosedError = () =>
          new SubagentRuntimeClosedError({
            message: "The subagent session runtime is closed.",
          });
        /**
         * Shared locked final admission and record construction. Rechecks every
         * admission constraint before deleting history; `ownReservation` is this
         * start's own claimed candidate (excluded from the recheck because every
         * concurrent admission already counted its reservation while reclamation
         * ran), while a fresh admission excludes nothing. Caller must hold the
         * service lock, and every eviction reclaim must already have definitely
         * succeeded before this deletes the evicted record.
         */
        const admitLocked = (evicted: RunRecord | undefined, ownReservation?: RunRecord) =>
          Effect.gen(function* () {
            const predecessor = request.supersedes
              ? records.get(request.supersedes.runId)
              : undefined;
            if (
              request.supersedes &&
              (!predecessor ||
                predecessor.view.state !== "failed" ||
                predecessor.retryClaim?.token !== request.supersedes.claimToken ||
                predecessor.view.supersededByRunId !== undefined)
            )
              return yield* new InvalidSubagentRequestError({
                code: "retry_claim_stale",
                message: `Failed predecessor ${request.supersedes.runId} no longer owns this next-candidate retry claim.`,
              });
            const capacityFailure = processCapacityError(records, ownReservation);
            if (capacityFailure) return yield* capacityFailure;
            if (canonicalWriterCwd) {
              const writerFailure = writerConflictError(
                records,
                canonicalWriterCwd,
                ownReservation,
              );
              if (writerFailure) return yield* writerFailure;
            }
            if (evicted) {
              evicted.evictionClaim = undefined;
              records.delete(evicted.view.id);
              delivery.discardQuestionLocked(evicted.view.id);
            }
            // Run scopes are service-owned rather than automatically parent-closed so shutdown
            // can observe backend cleanup before authorizing the separately scoped writer lease
            // release. They are created only after every eviction reclaim already succeeded.
            const scope = yield* Scope.make();
            // Lease scope is detached from the owner scope so the service finalizer can first
            // close every backend scope, then authorize and close the corresponding lease scope.
            const writerLeaseScope = canonicalWriterCwd ? yield* Scope.make() : undefined;
            const writerLeaseReleaseState = writerLeaseScope ? { authorized: false } : undefined;
            const writerLeasePreparationSettled = writerLeaseScope
              ? Deferred.makeUnsafe<void>()
              : undefined;
            const initializationSettled = Deferred.makeUnsafe<void>();
            const cleanupSettlement = yield* Deferred.make<"confirmed" | "quarantined">();
            const { id, name } = allocateRunIdentity(requestedName);
            const assignmentAttemptToken = allocateAssignmentAttemptToken();
            const view: SubagentRunView = (() => {
              const baseResult = { id, name, task: request.task.trim() };
              const withProfile = request.profile
                ? { ...baseResult, profile: request.profile }
                : baseResult;
              const withPredecessorRunId = request.supersedes
                ? { ...withProfile, predecessorRunId: request.supersedes.runId }
                : withProfile;
              const remainingCandidateCount = request.routeContinuation
                ? Math.max(
                    0,
                    request.routeContinuation.candidates.length -
                      request.routeContinuation.selectedCandidateIndex -
                      1,
                  )
                : undefined;
              const withRemainingCandidateCount =
                remainingCandidateCount === undefined
                  ? withPredecessorRunId
                  : { ...withPredecessorRunId, remainingCandidateCount };
              const withSelectionAndAdditionalFields = {
                ...withRemainingCandidateCount,
                selection: request.selection ?? {
                  source: "profile-candidate",
                  host: request.host,
                  runtime: request.runtime,
                  closeOnReport: request.closeOnReport,
                  reason: "Profile route selection.",
                  skippedCandidates: [],
                },
                cwd: canonicalWriterCwd?.path ?? request.cwd,
                state: "starting" as const,
                context: request.context,
                writeIntent: request.writeIntent,
                fastMode: request.fastMode,
                host: request.host,
                runtime: request.runtime,
                closeOnReport: request.closeOnReport,
                reportGeneration: 0,
                capabilities: driver.capabilities,
                model: request.model,
                effort: request.effort,
                startedAt: now,
                lastActivityAt: now,
                sessionEvents: [],
                usage: emptyUsage(),
              };
              return withSelectionAndAdditionalFields;
            })();
            const launch: BackendLaunchRequest = (() => {
              const baseResult = {
                runId: id,
                name,
                closeOnReport: request.closeOnReport,
                cwd: canonicalWriterCwd?.path ?? request.cwd,
                context: request.context,
                writeIntent: request.writeIntent,
                fastMode: request.fastMode,
                model: request.model,
                effort: request.effort,
              };
              const withRuntimeApiKey = request.runtimeApiKey
                ? { ...baseResult, runtimeApiKey: request.runtimeApiKey }
                : baseResult;
              const withActiveToolsAndAdditionalFields = {
                ...withRuntimeApiKey,
                activeTools: request.activeTools,
                projectTrusted: request.projectTrusted,
                parentSessionId: request.parentSessionId,
              };
              const withParentSessionFile = request.parentSessionFile
                ? {
                    ...withActiveToolsAndAdditionalFields,
                    parentSessionFile: request.parentSessionFile,
                  }
                : withActiveToolsAndAdditionalFields;
              const withParentLeafId = request.parentLeafId
                ? { ...withParentSessionFile, parentLeafId: request.parentLeafId }
                : withParentSessionFile;
              const withSystemPrompt = {
                ...withParentLeafId,
                systemPrompt: childSystemPrompt(request),
              };
              return withSystemPrompt;
            })();
            const record: RunRecord = (() => {
              const baseResult = {
                view,
                scope,
                driver,
                launch,
                activeTools: new Map(),
                cleanupSettlement,
                routeContinuation: request.routeContinuation,
                retryExhausted: false,
                pauseRequested: false,
                stoppedByParent: false,
                cleanupPending: false,
                runStateReclaimState: "pending" as const,
              };
              const withCanonicalWriterCwd = canonicalWriterCwd
                ? { ...baseResult, canonicalWriterCwd }
                : baseResult;
              const withWriterLeaseScopeAndAdditionalFields = writerLeaseScope
                ? {
                    ...withCanonicalWriterCwd,
                    writerLeaseScope,
                    writerLeasePreparationState: "pending" as const,
                    writerLeasePreparationSettled,
                    writerLeaseReleaseState,
                  }
                : withCanonicalWriterCwd;
              const withInitializationPendingAndAdditionalFields = {
                ...withWriterLeaseScopeAndAdditionalFields,
                initializationPending: true,
                initializationSettled,
                notificationGeneration: 0,
                completionGeneration: 0,
                warningSlots: emptyRunWarningSlots(),
                completionGenerations: new Map(),
                completionClaims: new Map(),
                assignment: {
                  epoch: 1,
                  phase: "preparing" as const,
                  attemptToken: assignmentAttemptToken,
                  startedObserved: false,
                  outcomeUncertain: false,
                  pendingRunSettled: false,
                },
                nextAssignmentEpoch: 2,
              };
              return withInitializationPendingAndAdditionalFields;
            })();
            if (predecessor) {
              predecessor.retryClaim = undefined;
              predecessor.view = { ...predecessor.view, supersededByRunId: id };
            }
            records.set(id, record);
            yield* publish;
            return record;
          });
        /**
         * Phase A: admit immediately when no destructive reclamation is needed,
         * or exclusively claim one eligible candidate whose private state must
         * still be reclaimed. The claim reserves the prospective process/writer
         * slot before reclamation, so phase C cannot fail after resumable
         * private state was removed.
         */
        const reserveOrClaim = () =>
          withLock(
            Effect.gen(function* () {
              if (isClosed()) return yield* runtimeClosedError();
              let candidate: RunRecord | undefined;
              if (records.size >= MAX_RETAINED_RUNS) {
                candidate = [...records.values()]
                  .filter(
                    (record) =>
                      evictionEligible(record) &&
                      record.evictionClaim === undefined &&
                      record.runStateReclaimState !== "running",
                  )
                  .sort(
                    (left, right) =>
                      (left.view.endedAt ?? left.view.startedAt) -
                      (right.view.endedAt ?? right.view.startedAt),
                  )[0];
                if (!candidate)
                  return yield* new SubagentHistoryCapacityError({
                    limit: MAX_RETAINED_RUNS,
                    code: "history_outbox_capacity",
                    message: `Subagent history/outbox capacity reached (${MAX_RETAINED_RUNS}); unresolved or claimed reports or cleanup ownership must be resolved before another run can start.`,
                  });
                if (candidate.runStateReclaimState !== "reclaimed") {
                  const capacityFailure = processCapacityError(records);
                  if (capacityFailure) return yield* capacityFailure;
                  if (canonicalWriterCwd) {
                    const writerFailure = writerConflictError(records, canonicalWriterCwd);
                    if (writerFailure) return yield* writerFailure;
                  }
                  candidate.evictionClaim = canonicalWriterCwd
                    ? { writerCwdDigest: canonicalWriterCwd.digest }
                    : {};
                  return { kind: "reclaim" as const, candidate };
                }
              }
              return { kind: "reserved" as const, record: yield* admitLocked(candidate) };
            }),
          );
        /**
         * Phase C: after a definite reclaim success, revalidate this start's
         * exclusive claim and the candidate's eligibility under the lock, then
         * perform the atomic delete+insert. Admission is the only outcome; a
         * second reclamation phase is impossible by construction.
         */
        const admitReclaimed = (candidate: RunRecord): Effect.Effect<RunRecord, SubagentError> =>
          withLock(
            Effect.gen(function* () {
              if (isClosed()) return yield* runtimeClosedError();
              const stillOwned =
                records.get(candidate.view.id) === candidate &&
                candidate.evictionClaim !== undefined &&
                candidate.runStateReclaimState === "reclaimed" &&
                evictionEligible(candidate);
              if (!stillOwned)
                return yield* new SubagentHistoryCapacityError({
                  limit: MAX_RETAINED_RUNS,
                  code: "history_outbox_capacity",
                  message:
                    "Subagent history eviction ownership changed before admission completed; retry the start after inspecting current run state.",
                });
              return yield* admitLocked(candidate, candidate);
            }),
          );
        const attempt = yield* reserveOrClaim();
        const reserved =
          attempt.kind === "reserved"
            ? attempt.record
            : yield* reclaimRecordRunState(attempt.candidate).pipe(
                Effect.onError(() =>
                  quarantineReclaimFailure(attempt.candidate).pipe(
                    Effect.andThen(clearEvictionClaim(attempt.candidate)),
                  ),
                ),
                Effect.andThen(
                  admitReclaimed(attempt.candidate).pipe(
                    Effect.onError(() => clearEvictionClaim(attempt.candidate)),
                  ),
                ),
              );
        const peerNotice = peerNoticeText(records.values(), reserved.view.id);
        const initialPrompt = taskPrompt(request, peerNotice);
        const initialize = Effect.gen(function* () {
          const state = yield* initializeProcess(reserved);
          // Let a terminal frame already queued behind the initialization state
          // commit its deferred settlement before this start result is returned.
          yield* Effect.yieldNow;
          if (request.effortWasExplicit && state.effort !== request.effort)
            return yield* new InvalidSubagentRequestError({
              code: "pi_effort_unsupported",
              message: `Model ${request.model} does not support requested effort ${request.effort}; effective level was ${state.effort}.`,
            });
          const resolvedModel = state.model ?? reserved.view.model;
          const startedAt = yield* Clock.currentTimeMillis;
          const activated = yield* withLock(
            Effect.gen(function* () {
              if (
                reserved.stoppedByParent ||
                reserved.view.state === "stopping" ||
                reserved.view.state === "stopped"
              )
                return undefined;
              completeRunInitialization(reserved);
              reserved.resumeToken = state.resumeToken;
              const pendingSettlement = reserved.pendingInitializationSettlement;
              reserved.pendingInitializationSettlement = undefined;
              reserved.view = (() => {
                const baseResult = {
                  ...reserved.view,
                  effort: state.effort,
                  model: resolvedModel,
                  lastActivityAt: startedAt,
                  sessionId: state.sessionId,
                };
                const withSessionFile = state.sessionFile
                  ? { ...baseResult, sessionFile: state.sessionFile }
                  : baseResult;
                return withSessionFile;
              })();
              yield* publish;
              return {
                view: snapshotView(reserved.view),
                pendingSettlement,
              };
            }),
          );
          if (!activated)
            return yield* new InvalidSubagentRequestError({
              code: "start_cancelled",
              message: `Subagent ${reserved.view.id} was stopped during startup.`,
            });
          if (activated.pendingSettlement) {
            const pending = activated.pendingSettlement;
            if (pending.state === "failed")
              return yield* failRun(
                reserved,
                pending.error ?? "Subagent failed during startup.",
              ).pipe(Effect.tap(() => closeRecordScope(reserved)));
            return yield* settle(reserved, pending.state, pending.error);
          }
          const attemptToken = yield* withLock(
            Effect.gen(function* () {
              if (reserved.assignment.phase !== "preparing" || reserved.view.state !== "starting")
                return yield* new InvalidSubagentRequestError({
                  code: "start_cancelled",
                  message: `Subagent ${reserved.view.id} changed state before its task could be issued.`,
                });
              reserved.assignment.phase = "issuing";
              return reserved.assignment.attemptToken;
            }),
          );
          const issued = yield* submitPrompt(reserved, initialPrompt, "start", attemptToken);
          yield* sendPeerNotices(reserved.view.id);
          return issued;
        });

        return yield* restore(initialize).pipe(
          Effect.onError((cause) =>
            Effect.gen(function* () {
              const interruptedOnly =
                cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason);
              yield* withLock(
                Effect.sync(() => {
                  completeRunInitialization(reserved);
                  reserved.pendingInitializationSettlement = undefined;
                }),
              );
              yield* markCleanupPending(reserved);
              if (!reserved.stoppedByParent) {
                if (interruptedOnly) yield* settle(reserved, "stopped");
                else
                  yield* settle(
                    reserved,
                    "failed",
                    sanitizeDiagnosticText(Cause.pretty(cause), MAX_ERROR_CHARS),
                  );
              }
              yield* closeRecordScope(reserved);
            }),
          ),
        );
      }),
    );

  const startSessionOwned = (
    request: StartSubagentRequest,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const fiber = yield* start(request).pipe(
          Effect.forkIn(ownerScope, { startImmediately: true }),
        );
        // Public start is admission-only. A report racing prompt confirmation remains unresolved
        // for exact-once await/notifier delivery and is never exposed or claimed here.
        return redactCompletionReport(yield* restore(Fiber.join(fiber)));
      }),
    );

  return {
    /** Admission, eviction, record construction, initialization, prompt issue, compensation. */
    start,
    /** Session-owned launch; cancelling the waiter never abandons ownership. */
    startSessionOwned,
  };
}
