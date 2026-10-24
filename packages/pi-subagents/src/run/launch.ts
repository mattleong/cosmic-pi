import { retireRunUsageLocked, type SessionUsageLedger } from "./session-usage.ts";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { firstLineMessage } from "pi-cosmic-core/message-text";
import type { BackendStartupState } from "../backend/model.ts";
import type { SubagentBackendRegistryContract } from "../backend/service.ts";
import { skippedCandidateRoute, type SkippedProfileCandidate } from "../profiles/model.ts";
import type { SubagentRuntime } from "../domain/routing.ts";
import {
  DEFAULT_MAX_ACTIVE_RUNS,
  DEFAULT_SUBAGENT_NESTING_POLICY,
  type SubagentNestingPolicy,
} from "../config/schema.ts";
import {
  canonicalizeWriterCwd,
  processCapacityError,
  treeCapacityError,
  writerConflictError,
} from "./admission.ts";
import {
  holdStartFailureLocked,
  releaseUnlessStartFailedLocked,
  type StartFailureHold,
} from "./completion.ts";
import { peerNoticeText } from "./coordination.ts";
import { taskPrompt } from "./tool-policy.ts";
import {
  invalidRequest,
  isCleanupUnconfirmed,
  isOutcomeUncertain,
  processError,
  subagentErrorCode,
  type SubagentError,
  SubagentHistoryCapacityError,
  SubagentRuntimeClosedError,
} from "./errors.ts";
import {
  candidateFallbackFailure,
  candidateStartupFailureLocked,
  exhaustRouteLocked,
  retargetRunLocked,
  stopFallbackLocked,
  type FallbackStop,
} from "./candidate-fallback.ts";
import {
  commitRunInitialization,
  completeRunInitialization,
  snapshotRun,
  type RunContext,
  type RunRecord,
} from "./internal.ts";
import { MAX_RETAINED_RUNS } from "./limits.ts";
import { samePiModel } from "./model-catalog.ts";
import {
  failedRunNextCandidate,
  isActiveRunState,
  isTerminalRunState,
  onStartCandidate,
  selectedRouteCandidate,
  SUBAGENT_ROOT_RUN_ID,
  type FailedStartRecovery,
  type RouteFallback,
  type StartSubagentRequest,
  type SubagentNextCandidate,
  type SubagentRunView,
  type UnsafeCandidateProbe,
} from "./model.ts";
import type { RunAssignment } from "./assignment.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import type { RunProcessInitializer } from "./process-lifecycle.ts";
import type { WriterPoolLookup, WriterPools } from "./writer-pool.ts";
import type { RunRecordCleanup } from "./record-cleanup.ts";
import { cleanupFailureDiagnostic } from "./cleanup-diagnostic.ts";
import type { RunSettlement } from "./settlement.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText, sanitizeName } from "./state.ts";
import { foldRunWarnings } from "./warnings.ts";
import { scriptOriginForStart, scriptedWriterAdmissionError } from "./launch-policy.ts";
import type { RunWorkspaceControl } from "./workspace-control.ts";
import {
  backendLaunchRequest,
  initialRunView,
  isEvictionEligible,
  validateStartRequest,
  type LaunchPlan,
} from "./launch-records.ts";

const failedStartRecoveries = new WeakMap<SubagentError, FailedStartRecovery>();

export const getFailedStartRecovery = (error: SubagentError): FailedStartRecovery | undefined =>
  failedStartRecoveries.get(error);

/** The candidate a failed start's admitted run last tried, which a fallback may have changed. */
export type FailedStartRoute = Pick<
  SubagentRunView,
  "runtime" | "model" | "effort" | "openaiFastMode" | "selection"
>;

const failedStartRoutes = new WeakMap<SubagentError, FailedStartRoute>();

export const getFailedStartRoute = (error: SubagentError): FailedStartRoute | undefined =>
  failedStartRoutes.get(error);

// A run's error says what failed, never a rendered cause, whose stack frames and dependency paths
// would reach its card, previews, and failure file. A defect keeps its message's first line.
const startFailureMessage = (cause: Cause.Cause<SubagentError>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: (error) => error.message,
    onNone: () => {
      const defect = Result.getOrUndefined(Cause.findDefect(cause));
      const line = firstLineMessage(
        Predicate.hasProperty(defect, "message") && Predicate.isString(defect.message)
          ? defect.message
          : "",
        "",
      );
      return line
        ? `Subagent startup failed unexpectedly: ${line}.`
        : "Subagent startup failed unexpectedly.";
    },
  });

interface RunLaunchDependencies extends Pick<
  RunContext,
  "writerLeases" | "withLock" | "publish" | "allocateAssignmentAttemptToken" | "sendPeerNotices"
> {
  readonly writerPools: WriterPoolLookup & Pick<WriterPools, "joinLocked">;
  readonly backendRegistry: SubagentBackendRegistryContract;
  readonly records: Map<string, RunRecord>;
  readonly delivery: RunNotificationDelivery;
  readonly isClosed: () => boolean;
  readonly allocateRunIdentity: (
    requestedName: string,
    taken: (id: string) => boolean,
  ) => {
    readonly id: string;
    readonly name: string;
  };
  readonly cleanup: RunRecordCleanup;
  readonly settle: RunSettlement["settle"];
  readonly submitPrompt: RunAssignment["submitPrompt"];
  readonly initializeProcess: RunProcessInitializer;
  readonly workspaces: Pick<RunWorkspaceControl, "bind" | "heldLaunchSlots">;
  readonly sessionUsage: SessionUsageLedger;
}

const runtimeClosedError = () =>
  SubagentRuntimeClosedError.make({
    message: "The subagent session runtime is closed.",
  });

export function launchOperations(dependencies: RunLaunchDependencies) {
  const {
    backendRegistry,
    writerLeases,
    records,
    writerPools,
    withLock,
    publish,
    delivery,
    isClosed,
    allocateRunIdentity,
    allocateAssignmentAttemptToken,
    cleanup,
    settle,
    submitPrompt,
    initializeProcess,
    sendPeerNotices,
    workspaces,
  } = dependencies;

  const enforceScriptedAdmissionLocked = Effect.fn("SubagentLaunch.enforceScriptedAdmissionLocked")(
    function* (request: StartSubagentRequest, scriptedRoot: boolean) {
      if (request.writeIntent === "writer" && scriptOriginForStart(records, request, scriptedRoot))
        return yield* scriptedWriterAdmissionError();
      return undefined;
    },
  );

  const parentLocked = Effect.fn("SubagentLaunch.parentLocked")(function* (
    request: StartSubagentRequest,
  ) {
    const parentRunId = request.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
    const { maxDepth } = request.nestingPolicy ?? DEFAULT_SUBAGENT_NESTING_POLICY;
    const parent = parentRunId === SUBAGENT_ROOT_RUN_ID ? undefined : records.get(parentRunId);
    if (parentRunId !== SUBAGENT_ROOT_RUN_ID && !parent)
      return yield* invalidRequest(
        "parent_run_not_found",
        `Subagent parent ${parentRunId} is no longer registered.`,
      );
    if (parent && (parent.stoppedByParent || !isActiveRunState(parent.view.state)))
      return yield* invalidRequest(
        "parent_run_disconnected",
        `Subagent parent ${parentRunId} is not connected and cannot spawn a child.`,
      );
    const parentDepth = parent?.view.depth ?? 0;
    if (parentDepth >= maxDepth)
      return yield* invalidRequest(
        "nesting_depth_limit",
        `Subagent nesting depth reached (${maxDepth}); ${parentRunId} cannot spawn another Pi run node.`,
      );
    return parent;
  });

  // Writers check what admission will refuse before canonicalizing a cwd or acquiring a
  // workspace; admission repeats every check under the same lock.
  const validate = (request: StartSubagentRequest, scriptedRoot = false) =>
    validateStartRequest(request).pipe(
      Effect.tap(() =>
        request.writeIntent === "writer"
          ? withLock(
              Effect.gen(function* () {
                yield* enforceScriptedAdmissionLocked(request, scriptedRoot);
                yield* parentLocked(request);
              }),
            )
          : Effect.void,
      ),
    );

  const start = (
    request: StartSubagentRequest,
    scriptedRoot = false,
    hold?: StartFailureHold,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* validate(request, scriptedRoot);
        const parentRunId = request.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
        const nestingPolicy: SubagentNestingPolicy =
          request.nestingPolicy ?? DEFAULT_SUBAGENT_NESTING_POLICY;
        const driver = yield* restore(
          backendRegistry.resolve({
            runtime: request.runtime,
            context: request.context,
          }),
        );
        const canonicalWriterCwd =
          request.writeIntent === "writer"
            ? yield* restore(canonicalizeWriterCwd(writerLeases, request.cwd))
            : undefined;
        if (
          request.workspace &&
          (request.workspace.writerCwd === undefined ||
            canonicalWriterCwd?.filesystemIdentity !==
              request.workspace.writerCwd.filesystemIdentity ||
            canonicalWriterCwd.digest !== request.workspace.writerCwd.digest)
        )
          return yield* invalidRequest(
            "writer_cwd_identity_changed",
            "The workspace writer directory no longer matches its original lease identity; startup was denied.",
          );
        const cwd = canonicalWriterCwd?.path ?? request.cwd;
        yield* restore(
          driver.preflight({
            context: request.context,
            writeIntent: request.writeIntent,
            model: request.model,
            effort: request.effort,
            cwd,
          }),
        );
        const requestedName = sanitizeName(request.name ?? "");
        const now = yield* Clock.currentTimeMillis;
        const clearEvictionClaim = (candidate: RunRecord) =>
          withLock(
            Effect.sync(() => {
              if (records.get(candidate.view.id) === candidate) candidate.evictionClaim = undefined;
            }),
          );

        const validateCapacityLocked = Effect.fn("SubagentLaunch.validateCapacityLocked")(
          function* (ownReservation: RunRecord | undefined) {
            const capacityFailure = processCapacityError(
              records,
              parentRunId,
              nestingPolicy.maxDirectChildren,
              ownReservation,
              workspaces.heldLaunchSlots(parentRunId, request),
            );
            if (capacityFailure) return yield* capacityFailure;
            const treeFailure = treeCapacityError(
              records,
              nestingPolicy.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS,
              ownReservation,
              workspaces.heldLaunchSlots(undefined, request),
            );
            if (treeFailure) return yield* treeFailure;
            if (!canonicalWriterCwd) return undefined;
            const writerFailure = writerConflictError(
              records,
              writerPools,
              canonicalWriterCwd,
              ownReservation,
            );
            if (writerFailure) return yield* writerFailure;
            return undefined;
          },
        );

        const checkAdmissionLocked = Effect.fn("SubagentLaunch.checkAdmissionLocked")(function* (
          ownReservation?: RunRecord,
        ) {
          yield* enforceScriptedAdmissionLocked(request, scriptedRoot);
          const parent = yield* parentLocked(request);
          yield* validateCapacityLocked(ownReservation);
          return parent;
        });

        const plan: LaunchPlan = { request, parentRunId, cwd };
        const evictionEligible = (record: RunRecord) => isEvictionEligible({ records }, record);

        const admitLocked = Effect.fn("SubagentLaunch.admitLocked")(function* (
          evicted: RunRecord | undefined,
          parent: RunRecord | undefined,
        ) {
          if (evicted) {
            evicted.evictionClaim = undefined;
            retireRunUsageLocked(dependencies.sessionUsage, evicted);
            records.delete(evicted.view.id);
            delivery.discardQuestionLocked(evicted.view.id);
          }
          const scope = yield* Scope.make();
          const initializationSettled = yield* Deferred.make<void>();
          const cleanupSettlement = yield* Deferred.make<"confirmed" | "quarantined">();
          const { id, name } = allocateRunIdentity(requestedName, (candidate) =>
            records.has(candidate),
          );
          const attemptToken = allocateAssignmentAttemptToken();
          const writerPool = canonicalWriterCwd
            ? yield* writerPools.joinLocked(canonicalWriterCwd, id)
            : undefined;
          const record: RunRecord = {
            scriptOrigin: scriptOriginForStart(records, request, scriptedRoot),
            view: initialRunView(plan, parent, id, driver.capabilities, now),
            scope,
            driver,
            launch: backendLaunchRequest(plan, { id, name }),
            activeTools: new Map(),
            nativeAgents: new Set(),
            cleanupSettlement,
            cleanupDisposition: "none",
            pauseRequested: false,
            stoppedByParent: false,
            runStateReclaimState: "pending",
            ...(canonicalWriterCwd && { canonicalWriterCwd, writerPool }),
            initialization: { settled: initializationSettled },
            notificationGeneration: 0,
            completionGeneration: 0,
            warningSlots: {},
            completionGenerations: new Map(),
            completionClaims: new Map(),
            assignment: {
              epoch: 1,
              phase: "preparing",
              attemptToken,
              startedObserved: false,
              outcomeUncertain: false,
              pendingRunSettled: false,
            },
            nextAssignmentEpoch: 2,
          };
          records.set(id, record);
          workspaces.bind(request, record);
          yield* publish;
          return record;
        });
        const reserveOrClaim = () =>
          withLock(
            Effect.gen(function* () {
              if (isClosed()) return yield* runtimeClosedError();
              const parent = yield* checkAdmissionLocked();
              const history = Arr.filter([...records.values()], (record) =>
                isTerminalRunState(record.view.state),
              );
              const candidate =
                history.length < MAX_RETAINED_RUNS
                  ? undefined
                  : Arr.sort(
                      Arr.filter(
                        history,
                        (record) =>
                          evictionEligible(record) &&
                          record.evictionClaim === undefined &&
                          record.runStateReclaimState !== "running",
                      ),
                      Order.mapInput(
                        Order.Number,
                        (record: RunRecord) => record.view.endedAt ?? record.view.startedAt,
                      ),
                    )[0];
              if (candidate && candidate.runStateReclaimState !== "reclaimed") {
                candidate.evictionClaim = { parentRunId };
                workspaces.bind(request);
                return { kind: "reclaim" as const, candidate };
              }
              return {
                kind: "reserved" as const,
                record: yield* admitLocked(candidate, parent),
              };
            }),
          );
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
                return yield* SubagentHistoryCapacityError.make({
                  limit: MAX_RETAINED_RUNS,
                  code: "history_outbox_capacity",
                  message:
                    "Subagent history eviction ownership changed before admission completed; retry the start after inspecting current run state.",
                });
              return yield* admitLocked(candidate, yield* checkAdmissionLocked(candidate));
            }),
          );
        const attempt = yield* reserveOrClaim();
        const reserved =
          attempt.kind === "reserved"
            ? attempt.record
            : yield* cleanup.reclaimRecordRunState(attempt.candidate).pipe(
                Effect.andThen(admitReclaimed(attempt.candidate)),
                Effect.onError((cause) =>
                  cleanup
                    .retainCleanupQuarantine(
                      attempt.candidate,
                      attempt.candidate.scope,
                      cleanupFailureDiagnostic("backend-scope", cause),
                    )
                    .pipe(Effect.andThen(clearEvictionClaim(attempt.candidate))),
                ),
              );
        const peerNotice = peerNoticeText(records.values(), reserved.view.id);
        const initialize = Effect.fn("SubagentLaunch.initialize")(function* (
          candidate: StartSubagentRequest,
        ) {
          const state = yield* initializeProcess(reserved);
          yield* Effect.yieldNow;
          if (
            candidate.runtime === "pi" &&
            state.model !== undefined &&
            !samePiModel(state.model, candidate.model)
          )
            return yield* invalidRequest(
              "pi_model_mismatch",
              `Pi selected model ${state.model} instead of required model ${candidate.model}.`,
            );
          if (candidate.effortWasExplicit && state.effort !== candidate.effort)
            return yield* invalidRequest(
              "pi_effort_unsupported",
              `Model ${candidate.model} does not support requested effort ${candidate.effort}; effective level was ${state.effort}.`,
            );
          return yield* activate(state, candidate);
        });
        const activate = Effect.fn("SubagentLaunch.activate")(function* (
          state: BackendStartupState,
          candidate: StartSubagentRequest,
        ) {
          const startedAt = yield* Clock.currentTimeMillis;
          const activated = yield* withLock(
            Effect.gen(function* () {
              if (
                reserved.stoppedByParent ||
                reserved.view.state === "stopping" ||
                reserved.view.state === "stopped"
              )
                return undefined;
              const pendingSettlement = commitRunInitialization(reserved, state);
              reserved.view = { ...reserved.view, lastActivityAt: startedAt };
              yield* publish;
              return {
                view: snapshotRun(reserved),
                pendingSettlement,
              };
            }),
          );
          if (!activated)
            return yield* invalidRequest(
              "start_cancelled",
              `Subagent ${reserved.view.id} was stopped during startup.`,
            );
          if (activated.pendingSettlement) {
            const pending = activated.pendingSettlement;
            if (pending.state === "failed")
              return yield* processError(
                "start",
                "start_failed_before_prompt",
                pending.error ?? "Subagent failed during startup.",
              );
            return yield* settle(reserved, pending.state, pending.error);
          }
          const attemptToken = yield* withLock(
            Effect.gen(function* () {
              if (reserved.assignment.phase !== "preparing" || reserved.view.state !== "starting")
                return yield* invalidRequest(
                  "start_cancelled",
                  `Subagent ${reserved.view.id} changed state before its task could be issued.`,
                );
              // The task is issued from here on, so no other candidate may take the run.
              reserved.assignment.phase = "issuing";
              return reserved.assignment.attemptToken;
            }),
          );
          const issued = yield* submitPrompt(
            reserved,
            taskPrompt(candidate, peerNotice),
            "start",
            attemptToken,
          );
          yield* sendPeerNotices(reserved.view.id);
          return issued;
        });

        // Each candidate this launch started on that failed, in order.
        const tried: SkippedProfileCandidate[] = [];
        // Runtimes whose own startup failed, so the route passes over their other candidates.
        const failedRuntimes = new Map<SubagentRuntime, SkippedProfileCandidate>();
        // Once the launch moved past a candidate or stopped trying, its final failure names every
        // one it tried and why it stopped; an attempt's own failure is the last of them.
        const failedStart = (error: SubagentError, fromAttempt: boolean, stop?: FallbackStop) =>
          Effect.fail(
            tried.length > (fromAttempt ? 1 : 0) || stop
              ? candidateFallbackFailure(error, tried, stop)
              : error,
          );
        // A stop, runtime shutdown, or issued task ends the chain before each step.
        const preparingLocked = Effect.fn("SubagentLaunch.preparingLocked")(function* () {
          if (isClosed()) return yield* runtimeClosedError();
          if (
            reserved.stoppedByParent ||
            reserved.view.state !== "starting" ||
            reserved.assignment.phase !== "preparing"
          )
            return yield* invalidRequest(
              "start_cancelled",
              `Subagent ${reserved.view.id} was stopped during startup.`,
            );
          return undefined;
        });
        const stillPreparing = withLock(preparingLocked()).pipe(
          Effect.catch((error) => failedStart(error, false)),
        );
        /** Ends the chain with the attempt's failure, naming why and recording it on the run. */
        const stopFallback = Effect.fn("SubagentLaunch.stopFallback")(function* (
          lastError: SubagentError,
          stop: FallbackStop,
          hint: {
            readonly skippedCandidates?: ReadonlyArray<SkippedProfileCandidate> | undefined;
            readonly nextCandidate: SubagentNextCandidate | "keep" | "drop";
          },
          failure: SubagentError = lastError,
        ) {
          const stoppedAt = yield* Clock.currentTimeMillis;
          yield* withLock(
            Effect.gen(function* () {
              stopFallbackLocked(reserved, { stop, failed: tried, ...hint, now: stoppedAt });
              yield* publish;
            }),
          );
          return yield* failedStart(
            failure,
            failure === lastError,
            failure === lastError ? stop : undefined,
          );
        });
        // A probe that couldn't confirm its cleanup or outcome may have left a process behind, so
        // the run fails with its error and suggests no candidate.
        const endOnUnsafeProbe = (
          lastError: SubagentError,
          unsafe: UnsafeCandidateProbe,
          skippedCandidates: ReadonlyArray<SkippedProfileCandidate>,
        ) =>
          stopFallback(
            lastError,
            { code: unsafe.candidate.code, reason: unsafe.candidate.reason },
            { skippedCandidates: [...skippedCandidates, unsafe.candidate], nextCandidate: "drop" },
            unsafe.error,
          );
        const startOn = (
          candidate: StartSubagentRequest,
        ): Effect.Effect<SubagentRunView, SubagentError> =>
          restore(initialize(candidate)).pipe(
            Effect.catch((error) => fallBackFrom(candidate, error)),
          );
        const fallBackFrom = Effect.fn("SubagentLaunch.fallBackFrom")(function* (
          candidate: StartSubagentRequest,
          error: SubagentError,
        ) {
          const { failure, fallBack } = yield* withLock(
            Effect.sync(() => candidateStartupFailureLocked(reserved, candidate, error)),
          );
          tried.push(failure);
          const routeFallback = candidate.routeFallback;
          if (!fallBack || !routeFallback) return yield* failedStart(error, true);
          if (fallBack === "runtime" && !failedRuntimes.has(candidate.runtime))
            failedRuntimes.set(candidate.runtime, failure);
          // The failed candidate's processes are gone before another candidate takes the run,
          // which keeps its writer-pool membership so a writer's lease never lapses.
          yield* cleanup.closeCandidateScope(reserved);
          const handedOver = yield* withLock(
            Effect.sync(() => reserved.writerPoolHandover === reserved.scope),
          );
          if (!handedOver) return yield* failedStart(error, true);
          // So is its private state, which the next candidate's backend may not know how to reclaim.
          const reclaimed = yield* cleanup.reclaimCandidateRunState(reserved).pipe(Effect.result);
          if (Result.isFailure(reclaimed))
            return yield* stopFallback(
              error,
              { code: subagentErrorCode(reclaimed.failure), reason: reclaimed.failure.message },
              { nextCandidate: "keep" },
            );
          return yield* moveOn(candidate, failure, routeFallback, error);
        });
        const moveOn = Effect.fn("SubagentLaunch.moveOn")(function* (
          from: StartSubagentRequest,
          failed: SkippedProfileCandidate,
          routeFallback: RouteFallback,
          lastError: SubagentError,
        ): Effect.fn.Return<SubagentRunView, SubagentError> {
          yield* stillPreparing;
          const step = yield* restore(
            routeFallback({
              selection: from.selection ?? reserved.view.selection,
              failed,
              failedRuntimes,
            }),
          ).pipe(Effect.result);
          if (Result.isFailure(step))
            return yield* stopFallback(
              lastError,
              { code: subagentErrorCode(step.failure), reason: step.failure.message },
              { nextCandidate: "keep" },
            );
          const { skippedCandidates, unsafe } = step.success;
          if (unsafe) return yield* endOnUnsafeProbe(lastError, unsafe, skippedCandidates);
          const candidate = step.success.next;
          if (!candidate) {
            yield* withLock(
              Effect.gen(function* () {
                exhaustRouteLocked(reserved, skippedCandidates);
                yield* publish;
              }),
            );
            return yield* failedStart(lastError, true);
          }
          const next = onStartCandidate(from, candidate);
          // Admission and workspace ownership hold for the launch's write intent only.
          if (next.writeIntent !== request.writeIntent)
            return yield* stopFallback(
              lastError,
              {
                code: "fallback_write_intent_changed",
                reason: `The next candidate, ${next.runtime}/${next.model}, runs ${next.writeIntent}, but this run was admitted ${request.writeIntent}.`,
              },
              // That candidate is still the route's next one for a new run.
              {
                skippedCandidates,
                nextCandidate: selectedRouteCandidate(candidate.routeContinuation),
              },
            );
          yield* stillPreparing;
          const prepared = yield* restore(
            backendRegistry.resolve({ runtime: next.runtime, context: next.context }).pipe(
              Effect.tap((nextDriver) =>
                nextDriver.preflight({
                  context: next.context,
                  writeIntent: next.writeIntent,
                  model: next.model,
                  effort: next.effort,
                  cwd,
                }),
              ),
            ),
          ).pipe(Effect.result);
          if (Result.isFailure(prepared)) {
            const skipped: SkippedProfileCandidate = {
              ...(candidate.selection.candidateIndex !== undefined && {
                candidateIndex: candidate.selection.candidateIndex,
              }),
              candidate: skippedCandidateRoute(next),
              code: subagentErrorCode(prepared.failure),
              reason: prepared.failure.message,
            };
            if (isCleanupUnconfirmed(prepared.failure) || isOutcomeUncertain(prepared.failure))
              return yield* endOnUnsafeProbe(
                lastError,
                { candidate: skipped, error: prepared.failure },
                skippedCandidates,
              );
            // Like a planning skip, a candidate that fails preflight here passes to the one after it.
            return yield* moveOn(next, skipped, routeFallback, lastError);
          }
          const retarget = yield* Effect.all({
            scope: Scope.make(),
            cleanupSettlement: Deferred.make<"confirmed" | "quarantined">(),
            settled: Deferred.make<void>(),
            now: Clock.currentTimeMillis,
          });
          const installed = yield* withLock(
            Effect.gen(function* () {
              yield* preparingLocked();
              // Another close of the failed candidate's scope ended its handover.
              if (reserved.writerPoolHandover !== reserved.scope)
                return yield* invalidRequest(
                  "start_cancelled",
                  `Subagent ${reserved.view.id} was stopped during startup.`,
                );
              yield* checkAdmissionLocked(reserved);
              retargetRunLocked(reserved, {
                plan: { request: next, parentRunId, cwd },
                driver: prepared.success,
                scope: retarget.scope,
                cleanupSettlement: retarget.cleanupSettlement,
                initialization: { settled: retarget.settled },
                failed: tried,
                now: retarget.now,
              });
              yield* publish;
              return undefined;
            }),
          ).pipe(Effect.result);
          if (Result.isFailure(installed)) {
            yield* Scope.close(retarget.scope, Exit.void);
            return yield* failedStart(installed.failure, false);
          }
          return yield* startOn(next);
        });

        return yield* startOn(request).pipe(
          Effect.onError((cause) =>
            Effect.gen(function* () {
              const interruptedOnly = Cause.hasInterruptsOnly(cause);
              // The caller gets this failure as its start result, so a hold keeps its outcome
              // from also reaching a notice or an await.
              const heldGeneration = yield* withLock(
                Effect.sync(() => {
                  completeRunInitialization(reserved);
                  return hold && !interruptedOnly
                    ? holdStartFailureLocked(hold, reserved)
                    : undefined;
                }),
              );
              yield* cleanup.markCleanupPending(reserved);
              if (!reserved.stoppedByParent) {
                if (interruptedOnly) yield* settle(reserved, "stopped");
                else
                  yield* settle(
                    reserved,
                    "failed",
                    sanitizeDiagnosticText(startFailureMessage(cause), MAX_ERROR_CHARS),
                  );
              }
              if (hold && heldGeneration !== undefined)
                yield* withLock(
                  Effect.sync(() => {
                    if (releaseUnlessStartFailedLocked(hold, reserved, heldGeneration))
                      delivery.wakeCompletionLocked();
                  }),
                );
              yield* cleanup.closeRecordScope(reserved);
            }),
          ),
          // The start result carries what the run's notice would, since its hold may replace it.
          Effect.tapError((error) =>
            withLock(
              Effect.sync(() => {
                const nextCandidate = failedRunNextCandidate(reserved.view);
                const failureFile = reserved.view.errorArchive;
                const warning = foldRunWarnings(reserved.warningSlots);
                const { runtime, model, effort, openaiFastMode, selection } = reserved.view;
                failedStartRoutes.set(error, { runtime, model, effort, openaiFastMode, selection });
                failedStartRecoveries.set(error, {
                  runId: reserved.view.id,
                  cleanupDisposition:
                    reserved.cleanupDisposition === "none"
                      ? "pending"
                      : reserved.cleanupDisposition,
                  ...(nextCandidate && { nextCandidate }),
                  ...(failureFile && { failureFile }),
                  ...(warning && warning !== reserved.view.error && { warning }),
                });
              }),
            ),
          ),
        );
      }),
    );

  return {
    validate,
    start,
  };
}
