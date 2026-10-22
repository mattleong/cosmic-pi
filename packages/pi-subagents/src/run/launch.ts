import {
  retireRunUsageLocked,
  spentAtLimitLocked,
  type SessionUsageLedger,
} from "./session-usage.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { SubagentBackendRegistryContract } from "../backend/service.ts";
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
import { peerNoticeText } from "./coordination.ts";
import { taskPrompt } from "./tool-policy.ts";
import {
  invalidRequest,
  processError,
  SubagentCapacityError,
  type SubagentError,
  SubagentHistoryCapacityError,
  SubagentRuntimeClosedError,
} from "./errors.ts";
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
  SUBAGENT_ROOT_RUN_ID,
  type FailedStartRecovery,
  type StartSubagentRequest,
  type SubagentRunView,
} from "./model.ts";
import type { RunAssignment } from "./assignment.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import type { RunProcessInitializer } from "./process-lifecycle.ts";
import type { WriterPoolLookup, WriterPools } from "./writer-pool.ts";
import type { RunRecordCleanup } from "./record-cleanup.ts";
import { cleanupFailureDiagnostic } from "./cleanup-diagnostic.ts";
import type { RunSettlement } from "./settlement.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText, sanitizeName } from "./state.ts";
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

interface RunLaunchDependencies extends Pick<
  RunContext,
  "writerLeases" | "withLock" | "publish" | "allocateAssignmentAttemptToken" | "sendPeerNotices"
> {
  readonly writerPools: WriterPoolLookup & Pick<WriterPools, "joinLocked">;
  readonly backendRegistry: SubagentBackendRegistryContract;
  readonly records: Map<string, RunRecord>;
  readonly delivery: RunNotificationDelivery;
  readonly isClosed: () => boolean;
  readonly allocateRunIdentity: (requestedName: string) => {
    readonly id: string;
    readonly name: string;
  };
  readonly cleanup: RunRecordCleanup;
  readonly settle: RunSettlement["settle"];
  readonly submitPrompt: RunAssignment["submitPrompt"];
  readonly initializeProcess: RunProcessInitializer;
  readonly workspaces: Pick<RunWorkspaceControl, "bind" | "heldLaunchSlots">;
  readonly sessionUsage: SessionUsageLedger;
  readonly currentSpendLimit: Effect.Effect<number | undefined>;
}

const runtimeClosedError = () =>
  new SubagentRuntimeClosedError({
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

  const enforceScriptedAdmissionLocked = (request: StartSubagentRequest, scriptedRoot: boolean) =>
    Effect.gen(function* () {
      if (request.writeIntent === "writer" && scriptOriginForStart(records, request, scriptedRoot))
        return yield* scriptedWriterAdmissionError();
      return undefined;
    });

  const parentLocked = (request: StartSubagentRequest) =>
    Effect.gen(function* () {
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

  const spendLimitLocked = (spendLimit: number | undefined) =>
    Effect.gen(function* () {
      const spent = spentAtLimitLocked(dependencies.sessionUsage, records, spendLimit);
      if (spendLimit !== undefined && spent !== undefined)
        return yield* new SubagentCapacityError({
          limit: spendLimit,
          code: "session_spend_limit",
          message: `This session's subagents have spent $${spent.toFixed(2)} of its $${spendLimit.toFixed(2)} limit (sessionSpendLimit); no new runs start.`,
        });
      return undefined;
    });

  // Writers check what admission will refuse before canonicalizing a cwd or acquiring a
  // workspace; admission repeats every check under the same lock.
  const validate = (request: StartSubagentRequest, scriptedRoot = false) =>
    validateStartRequest(request).pipe(
      Effect.tap(() =>
        request.writeIntent === "writer"
          ? dependencies.currentSpendLimit.pipe(
              Effect.flatMap((spendLimit) =>
                withLock(
                  Effect.gen(function* () {
                    yield* enforceScriptedAdmissionLocked(request, scriptedRoot);
                    yield* parentLocked(request);
                    yield* spendLimitLocked(spendLimit);
                  }),
                ),
              ),
            )
          : Effect.void,
      ),
    );

  const start = (
    request: StartSubagentRequest,
    scriptedRoot = false,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* validate(request, scriptedRoot);
        const parentRunId = request.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
        const nestingPolicy: SubagentNestingPolicy =
          request.nestingPolicy ?? DEFAULT_SUBAGENT_NESTING_POLICY;
        const spendLimit = yield* dependencies.currentSpendLimit;
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

        const validateCapacityLocked = (ownReservation: RunRecord | undefined) =>
          Effect.gen(function* () {
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
            yield* spendLimitLocked(spendLimit);
            if (!canonicalWriterCwd) return undefined;
            const writerFailure = writerConflictError(
              records,
              writerPools,
              canonicalWriterCwd,
              ownReservation,
            );
            if (writerFailure) return yield* writerFailure;
            return undefined;
          });

        const checkAdmissionLocked = (ownReservation?: RunRecord) =>
          Effect.gen(function* () {
            yield* enforceScriptedAdmissionLocked(request, scriptedRoot);
            const parent = yield* parentLocked(request);
            yield* validateCapacityLocked(ownReservation);
            return parent;
          });

        const plan: LaunchPlan = { request, parentRunId, cwd };
        const evictionEligible = (record: RunRecord) => isEvictionEligible({ records }, record);

        const admitLocked = (evicted: RunRecord | undefined, parent: RunRecord | undefined) =>
          Effect.gen(function* () {
            if (evicted) {
              evicted.evictionClaim = undefined;
              retireRunUsageLocked(dependencies.sessionUsage, evicted);
              records.delete(evicted.view.id);
              delivery.discardQuestionLocked(evicted.view.id);
            }
            const scope = yield* Scope.make();
            const initializationSettled = yield* Deferred.make<void>();
            const cleanupSettlement = yield* Deferred.make<"confirmed" | "quarantined">();
            const { id, name } = allocateRunIdentity(requestedName);
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
              const history = [...records.values()].filter((record) =>
                isTerminalRunState(record.view.state),
              );
              const candidate =
                history.length < MAX_RETAINED_RUNS
                  ? undefined
                  : history
                      .filter(
                        (record) =>
                          evictionEligible(record) &&
                          record.evictionClaim === undefined &&
                          record.runStateReclaimState !== "running",
                      )
                      .toSorted(
                        (left, right) =>
                          (left.view.endedAt ?? left.view.startedAt) -
                          (right.view.endedAt ?? right.view.startedAt),
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
                return yield* new SubagentHistoryCapacityError({
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
        const initialPrompt = taskPrompt(request, peerNotice);
        const initialize = Effect.gen(function* () {
          const state = yield* initializeProcess(reserved);
          yield* Effect.yieldNow;
          if (
            request.runtime === "pi" &&
            state.model !== undefined &&
            !samePiModel(state.model, request.model)
          )
            return yield* invalidRequest(
              "pi_model_mismatch",
              `Pi selected model ${state.model} instead of required model ${request.model}.`,
            );
          if (request.effortWasExplicit && state.effort !== request.effort)
            return yield* invalidRequest(
              "pi_effort_unsupported",
              `Model ${request.model} does not support requested effort ${request.effort}; effective level was ${state.effort}.`,
            );
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
              yield* withLock(Effect.sync(() => completeRunInitialization(reserved)));
              yield* cleanup.markCleanupPending(reserved);
              if (!reserved.stoppedByParent) {
                if (interruptedOnly) yield* settle(reserved, "stopped");
                else
                  yield* settle(
                    reserved,
                    "failed",
                    sanitizeDiagnosticText(Cause.pretty(cause), MAX_ERROR_CHARS),
                  );
              }
              yield* cleanup.closeRecordScope(reserved);
            }),
          ),
          Effect.tapError((error) =>
            withLock(
              Effect.sync(() => {
                const nextCandidate = failedRunNextCandidate(reserved.view);
                failedStartRecoveries.set(error, {
                  runId: reserved.view.id,
                  cleanupDisposition:
                    reserved.cleanupDisposition === "none"
                      ? "pending"
                      : reserved.cleanupDisposition,
                  ...(nextCandidate && { nextCandidate }),
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
