import {
  retireRunUsageLocked,
  sessionUsageLocked,
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
  type RunContext,
  type RunRecord,
} from "./internal.ts";
import { MAX_RETAINED_RUNS } from "./limits.ts";
import {
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
import type { RunSettlement } from "./settlement.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText, sanitizeName, snapshotView } from "./state.ts";
import { failedStartRecoveryForRecord } from "./retry.ts";
import { scriptOriginForStart, scriptedWriterAdmissionError } from "./launch-policy.ts";
import type { RunWorkspaceControl } from "./workspace-control.ts";
import {
  backendLaunchRequest,
  initialRunView,
  isEvictionEligible,
  validateStartRequest,
  withWriteClaims,
  type LaunchPlan,
} from "./launch-records.ts";

const failedStartRecoveries = new WeakMap<SubagentError, FailedStartRecovery>();

export const getFailedStartRecovery = (error: SubagentError): FailedStartRecovery | undefined =>
  failedStartRecoveries.get(error);

export interface RunLaunchDependencies extends Pick<
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

// Registry context variants ("model@1m") name the same model with a different window.
const baseModel = (model: string): string => model.split("@", 1)[0]?.toLowerCase() ?? model;
const samePiModel = (selected: string, required: string): boolean =>
  baseModel(selected) === baseModel(required);

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
  const validate = (request: StartSubagentRequest, scriptedRoot = false) =>
    validateStartRequest(request).pipe(
      Effect.tap(() =>
        request.writeIntent === "writer"
          ? withLock(enforceScriptedAdmissionLocked(request, scriptedRoot))
          : Effect.void,
      ),
    );

  const start = (
    request: StartSubagentRequest,
    scriptedRoot = false,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const writeClaims = yield* validate(request, scriptedRoot);
        const parentRunId = request.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
        const nestingPolicy: SubagentNestingPolicy =
          request.nestingPolicy ?? DEFAULT_SUBAGENT_NESTING_POLICY;
        const spendLimit = yield* dependencies.currentSpendLimit;
        const driver = yield* restore(
          backendRegistry.resolve({
            host: request.host,
            runtime: request.runtime,
            context: request.context,
          }),
        );
        const canonicalWriterCwd =
          request.writeIntent === "writer"
            ? yield* restore(canonicalizeWriterCwd(writerLeases, request.cwd))
            : undefined;
        const cwd = canonicalWriterCwd?.path ?? request.cwd;
        yield* restore(
          driver.preflight({
            context: request.context,
            writeIntent: request.writeIntent,
            closeOnReport: request.closeOnReport,
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

        const retryPredecessorLocked = () =>
          Effect.gen(function* () {
            const predecessor = request.supersedes
              ? records.get(request.supersedes.runId)
              : undefined;
            if (
              request.supersedes &&
              (predecessor?.view.state !== "failed" ||
                predecessor.retryClaim?.token !== request.supersedes.claimToken ||
                predecessor.view.supersededByRunId !== undefined)
            )
              return yield* invalidRequest(
                "retry_claim_stale",
                `Failed predecessor ${request.supersedes.runId} no longer owns this next-candidate retry claim.`,
              );
            return predecessor;
          });

        const parentLocked = (predecessor: RunRecord | undefined) =>
          Effect.gen(function* () {
            const parent =
              parentRunId === SUBAGENT_ROOT_RUN_ID ? undefined : records.get(parentRunId);
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
            if (parentDepth >= nestingPolicy.maxDepth)
              return yield* invalidRequest(
                "nesting_depth_limit",
                `Subagent nesting depth reached (${nestingPolicy.maxDepth}); ${parentRunId} cannot spawn another Pi run node.`,
              );
            if (
              request.supersedes &&
              predecessor &&
              (predecessor.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID) !== parentRunId
            )
              return yield* invalidRequest(
                "retry_parent_mismatch",
                "A retry successor must keep its predecessor's parent.",
              );
            return parent;
          });

        const validateCapacityLocked = (
          ownReservation: RunRecord | undefined,
          predecessor: RunRecord | undefined,
        ) =>
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
              workspaces.heldLaunchSlots(parentRunId, request),
            );
            if (treeFailure) return yield* treeFailure;
            const spent = sessionUsageLocked(dependencies.sessionUsage, records).cost ?? 0;
            if (spendLimit !== undefined && spent >= spendLimit)
              return yield* new SubagentCapacityError({
                limit: spendLimit,
                code: "session_spend_limit",
                message: `This session's subagents have spent $${spent.toFixed(2)} of its $${spendLimit.toFixed(2)} limit (sessionSpendLimit); no new runs start.`,
              });
            if (!canonicalWriterCwd) return undefined;
            const writerFailure = writerConflictError(
              records,
              writerPools,
              canonicalWriterCwd,
              writeClaims,
              ownReservation,
              predecessor,
            );
            if (writerFailure) return yield* writerFailure;
            return undefined;
          });

        const checkAdmissionLocked = (ownReservation?: RunRecord) =>
          Effect.gen(function* () {
            yield* enforceScriptedAdmissionLocked(request, scriptedRoot);
            const predecessor = yield* retryPredecessorLocked();
            const parent = yield* parentLocked(predecessor);
            yield* validateCapacityLocked(ownReservation, predecessor);
            return { parent, predecessor };
          });

        const plan: LaunchPlan = { request, parentRunId, cwd, writeClaims };
        const promptRequest = (base: StartSubagentRequest) => withWriteClaims(base, writeClaims);
        const evictionEligible = (record: RunRecord) =>
          isEvictionEligible({ records, writerPools }, record);

        const admitLocked = (
          evicted: RunRecord | undefined,
          { parent, predecessor }: Effect.Success<ReturnType<typeof checkAdmissionLocked>>,
        ) =>
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
              view: initialRunView(plan, parent, { id, name }, driver.capabilities, now),
              scope,
              driver,
              launch: backendLaunchRequest(plan, { id, name }),
              activeTools: new Map(),
              nativeAgents: new Set(),
              cleanupSettlement,
              cleanupDisposition: "pending",
              routeContinuation: request.routeContinuation,
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
            if (predecessor) {
              predecessor.retryClaim = undefined;
              predecessor.view = { ...predecessor.view, supersededByRunId: id };
            }
            records.set(id, record);
            workspaces.bind(request, record);
            yield* publish;
            return record;
          });
        const reserveOrClaim = () =>
          withLock(
            Effect.gen(function* () {
              if (isClosed()) return yield* runtimeClosedError();
              const admission = yield* checkAdmissionLocked();
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
                candidate.evictionClaim = {
                  parentRunId,
                  ...(canonicalWriterCwd && {
                    writerCwdDigest: canonicalWriterCwd.digest,
                    writeClaims,
                  }),
                };
                workspaces.bind(request);
                return { kind: "reclaim" as const, candidate };
              }
              return {
                kind: "reserved" as const,
                record: yield* admitLocked(candidate, admission),
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
                Effect.onError(() =>
                  cleanup
                    .retainCleanupQuarantine(attempt.candidate, attempt.candidate.scope)
                    .pipe(Effect.andThen(clearEvictionClaim(attempt.candidate))),
                ),
              );
        const peerNotice = peerNoticeText(records.values(), reserved.view.id);
        const initialPrompt = taskPrompt(promptRequest(request), peerNotice);
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
                view: snapshotView(reserved.view),
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
                failedStartRecoveries.set(error, failedStartRecoveryForRecord(reserved));
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
