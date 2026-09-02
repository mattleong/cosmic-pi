import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { BackendLaunchRequest, BackendStartupState } from "../backend/model.ts";
import type { SubagentBackendRegistryContract } from "../backend/service.ts";
import { DEFAULT_SUBAGENT_NESTING_POLICY, type SubagentNestingPolicy } from "../config/schema.ts";
import { isRetainableProfileCandidate } from "../profiles/model.ts";
import type { WriterLeaseContract } from "../boundary/writer-lease.ts";
import { normalizeWriteClaims } from "../domain/write-claims.ts";
import { processCapacityError, writerConflictError } from "./admission.ts";
import { peerNoticeText } from "./coordination.ts";
import { childSystemPrompt, taskPrompt } from "./tool-policy.ts";
import {
  InvalidSubagentRequestError,
  type SubagentError,
  SubagentHistoryCapacityError,
  SubagentProcessError,
  SubagentRuntimeClosedError,
  UnsupportedSafeWriterOwnershipError,
} from "./errors.ts";
import { completeRunInitialization, type RunRecord } from "./internal.ts";
import { descendantRunIds } from "./tree.ts";
import { MAX_RETAINED_RUNS } from "./limits.ts";
import {
  emptyUsage,
  isActiveRunState,
  isTerminalRunState,
  SUBAGENT_ROOT_RUN_ID,
  type FailedStartRecovery,
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
import type { WriterPoolEntry } from "./writer-pool.ts";
import { failedStartRecoveryForRecord } from "./retry.ts";

const failedStartRecoveries = new WeakMap<SubagentError, FailedStartRecovery>();

/** Available only for an error returned after this service admitted and fully compensated a run. */
export const getFailedStartRecovery = (error: SubagentError): FailedStartRecovery | undefined =>
  failedStartRecoveries.get(error);

export interface RunLaunchDependencies {
  readonly ownerScope: Scope.Scope;
  readonly backendRegistry: SubagentBackendRegistryContract;
  readonly writerLeases: WriterLeaseContract;
  /** The service-owned run registry; launch admission inserts and evicts under the lock. */
  readonly records: Map<string, RunRecord>;
  /** One session-owned cross-process writer pool per canonical cwd digest. */
  readonly writerPools: Map<string, WriterPoolEntry>;
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
  readonly submitPrompt: (
    record: RunRecord,
    message: string,
    operation: "start" | "resume",
    attemptToken: string,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly initializeProcess: (
    record: RunRecord,
  ) => Effect.Effect<BackendStartupState, SubagentError>;
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
    writerPools,
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
        const parentRunId = request.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
        const nestingPolicy: SubagentNestingPolicy =
          request.nestingPolicy ?? DEFAULT_SUBAGENT_NESTING_POLICY;
        const normalizedClaims =
          request.writes === undefined ? undefined : normalizeWriteClaims(request.writes);
        if (normalizedClaims && !normalizedClaims.ok)
          return yield* new InvalidSubagentRequestError({
            code: normalizedClaims.code,
            message: normalizedClaims.message,
          });
        if (normalizedClaims && request.writeIntent !== "writer")
          return yield* new InvalidSubagentRequestError({
            code: "write_claims_read_only",
            message: "writes may be supplied only for a writer subagent.",
          });
        const writeClaims = normalizedClaims?.claims;
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
          descendantRunIds(records, record.view.id).length === 0 &&
          writerPools
            .get(record.canonicalWriterCwd?.digest ?? "")
            ?.violationRunIds.has(record.view.id) !== true &&
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
         * succeeded before this deletes the evicted record. A mutable writer-pool
         * safety transition may still reject phase C; that path quarantines the
         * already-reclaimed history record against resume.
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
            const parent =
              parentRunId === SUBAGENT_ROOT_RUN_ID ? undefined : records.get(parentRunId);
            if (parentRunId !== SUBAGENT_ROOT_RUN_ID && !parent)
              return yield* new InvalidSubagentRequestError({
                code: "parent_run_not_found",
                message: `Subagent parent ${parentRunId} is no longer registered.`,
              });
            if (parent && (parent.stoppedByParent || !isActiveRunState(parent.view.state)))
              return yield* new InvalidSubagentRequestError({
                code: "parent_run_disconnected",
                message: `Subagent parent ${parentRunId} is not connected and cannot spawn a child.`,
              });
            const parentDepth = parent?.view.depth ?? 0;
            if (parentDepth >= nestingPolicy.maxDepth)
              return yield* new InvalidSubagentRequestError({
                code: "nesting_depth_limit",
                message: `Subagent nesting depth reached (${nestingPolicy.maxDepth}); ${parentRunId} cannot spawn another Pi run node.`,
              });
            if (
              request.supersedes &&
              predecessor &&
              (predecessor.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID) !== parentRunId
            )
              return yield* new InvalidSubagentRequestError({
                code: "retry_parent_mismatch",
                message: "A retry successor must keep its predecessor's parent.",
              });
            const capacityFailure = processCapacityError(
              records,
              parentRunId,
              nestingPolicy.maxDirectChildren,
              ownReservation,
            );
            if (capacityFailure) return yield* capacityFailure;
            if (canonicalWriterCwd) {
              const writerFailure = writerConflictError(
                records,
                writerPools,
                canonicalWriterCwd,
                writeClaims,
                ownReservation,
                predecessor,
              );
              if (writerFailure) return yield* writerFailure;
            }
            if (evicted) {
              evicted.evictionClaim = undefined;
              records.delete(evicted.view.id);
              delivery.discardQuestionLocked(evicted.view.id);
            }
            // Run scopes are service-owned rather than automatically parent-closed so shutdown
            // can observe backend cleanup before authorizing shared writer-pool lease release.
            // They are created only after every eviction reclaim already succeeded.
            const scope = yield* Scope.make();
            const initializationSettled = Deferred.makeUnsafe<void>();
            const cleanupSettlement = yield* Deferred.make<"confirmed" | "quarantined">();
            const { id, name } = allocateRunIdentity(requestedName);
            const assignmentAttemptToken = allocateAssignmentAttemptToken();
            let writerPool: WriterPoolEntry | undefined;
            if (canonicalWriterCwd) {
              writerPool = writerPools.get(canonicalWriterCwd.digest);
              if (!writerPool) {
                writerPool = {
                  cwd: canonicalWriterCwd,
                  leaseScope: yield* Scope.make(),
                  releaseState: { authorized: false },
                  preparationSettled: Deferred.makeUnsafe<void, SubagentError>(),
                  members: new Map(),
                  violationRunIds: new Set(),
                  state: "pending",
                  admissionPaused: false,
                };
                writerPools.set(canonicalWriterCwd.digest, writerPool);
              }
              writerPool.members.set(id, writeClaims);
            }
            const remainingCandidateCount = request.routeContinuation
              ? Math.max(
                  0,
                  request.routeContinuation.candidates.length -
                    request.routeContinuation.selectedCandidateIndex -
                    1,
                )
              : undefined;
            const view: SubagentRunView = {
              id,
              name,
              task: request.task.trim(),
              ...(request.profile && { profile: request.profile }),
              ...(request.supersedes && { predecessorRunId: request.supersedes.runId }),
              ...(remainingCandidateCount !== undefined && { remainingCandidateCount }),
              parentRunId,
              depth: (parent?.view.depth ?? 0) + 1,
              selection: request.selection ?? {
                source: "profile-candidate",
                host: request.host,
                runtime: request.runtime,
                closeOnReport: request.closeOnReport,
                reason: "Profile route selection.",
                skippedCandidates: [],
              },
              cwd: canonicalWriterCwd?.path ?? request.cwd,
              state: "starting",
              context: request.context,
              writeIntent: request.writeIntent,
              ...(writeClaims !== undefined && {
                writeClaims,
                writeAudit: {
                  observedFileWrites: [],
                  violations: [],
                  bashWriteHints: 0,
                },
              }),
              openaiFastMode: request.openaiFastMode,
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
            const launch: BackendLaunchRequest = {
              runId: id,
              name,
              closeOnReport: request.closeOnReport,
              cwd: canonicalWriterCwd?.path ?? request.cwd,
              context: request.context,
              writeIntent: request.writeIntent,
              openaiFastMode: request.openaiFastMode,
              model: request.model,
              effort: request.effort,
              ...(request.runtimeApiKey && { runtimeApiKey: request.runtimeApiKey }),
              activeTools: request.activeTools,
              projectTrusted: request.projectTrusted,
              parentSessionId: request.parentSessionId,
              ...(request.parentSessionFile && {
                parentSessionFile: request.parentSessionFile,
              }),
              ...(request.parentLeafId && { parentLeafId: request.parentLeafId }),
              systemPrompt: childSystemPrompt(
                writeClaims === undefined ? request : { ...request, writes: writeClaims },
              ),
            };
            const record: RunRecord = {
              view,
              scope,
              driver,
              launch,
              activeTools: new Map(),
              nativeAgents: new Map(),
              nativeAgentTotal: 0,
              cleanupSettlement,
              cleanupDisposition: "pending",
              routeContinuation: request.routeContinuation,
              retryExhausted: false,
              pauseRequested: false,
              stoppedByParent: false,
              cleanupPending: false,
              runStateReclaimState: "pending",
              writeViolationContainmentStarted: false,
              ...(canonicalWriterCwd && { canonicalWriterCwd, writerPool }),
              initializationPending: true,
              initializationSettled,
              notificationGeneration: 0,
              completionGeneration: 0,
              warningSlots: emptyRunWarningSlots(),
              completionGenerations: new Map(),
              completionClaims: new Map(),
              assignment: {
                epoch: 1,
                phase: "preparing",
                attemptToken: assignmentAttemptToken,
                startedObserved: false,
                outcomeUncertain: false,
                pendingRunSettled: false,
              },
              nextAssignmentEpoch: 2,
            };
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
              const terminalHistoryCount = [...records.values()].filter((record) =>
                isTerminalRunState(record.view.state),
              ).length;
              if (terminalHistoryCount >= MAX_RETAINED_RUNS) {
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
                if (candidate && candidate.runStateReclaimState !== "reclaimed") {
                  const capacityFailure = processCapacityError(
                    records,
                    parentRunId,
                    nestingPolicy.maxDirectChildren,
                  );
                  if (capacityFailure) return yield* capacityFailure;
                  if (canonicalWriterCwd) {
                    const writerFailure = writerConflictError(
                      records,
                      writerPools,
                      canonicalWriterCwd,
                      writeClaims,
                      undefined,
                      request.supersedes ? records.get(request.supersedes.runId) : undefined,
                    );
                    if (writerFailure) return yield* writerFailure;
                  }
                  candidate.evictionClaim = canonicalWriterCwd
                    ? {
                        parentRunId,
                        writerCwdDigest: canonicalWriterCwd.digest,
                        writeClaims,
                      }
                    : { parentRunId };
                  return { kind: "reclaim" as const, candidate };
                }
              }
              return { kind: "reserved" as const, record: yield* admitLocked(candidate) };
            }),
          );
        /**
         * Phase C: after a definite reclaim success, revalidate this start's
         * exclusive claim and the candidate's eligibility under the lock, then
         * perform the atomic delete+insert. A second reclamation phase is
         * impossible; any post-reclaim admission rejection quarantines the old
         * record because its resumable private state is already gone.
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
                    Effect.onError(() =>
                      quarantineReclaimFailure(attempt.candidate).pipe(
                        Effect.andThen(clearEvictionClaim(attempt.candidate)),
                      ),
                    ),
                  ),
                ),
              );
        const peerNotice = peerNoticeText(records.values(), reserved.view.id);
        const initialPrompt = taskPrompt(
          writeClaims === undefined ? request : { ...request, writes: writeClaims },
          peerNotice,
        );
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
              reserved.view = {
                ...reserved.view,
                effort: state.effort,
                model: resolvedModel,
                lastActivityAt: startedAt,
                sessionId: state.sessionId,
                ...(state.sessionFile && { sessionFile: state.sessionFile }),
              };
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
              return yield* new SubagentProcessError({
                operation: "start",
                code: "start_failed_before_prompt",
                message: pending.error ?? "Subagent failed during startup.",
              });
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
              const interruptedOnly = Cause.hasInterruptsOnly(cause);
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
              // This is the complete backend/process/writer/private-state cleanup barrier.
              // Recovery metadata is attached only after it settles or quarantines.
              yield* closeRecordScope(reserved);
            }),
          ),
          Effect.tapError((error) =>
            withLock(
              Effect.sync(() => {
                failedStartRecoveries.set(error, failedStartRecoveryForRecord(reserved));
              }),
            ),
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
