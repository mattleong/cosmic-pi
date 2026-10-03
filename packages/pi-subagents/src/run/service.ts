import { hasObjectRuntimeType } from "pi-cosmic-core";
import type { AskUserRequest, QuestionnaireOwner } from "pi-ask-user/protocol";
import { makeQuestionnaireLifetimes } from "./questionnaire-lifetime.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { BackendProxyRequest, BackendProxyResult } from "../backend/model.ts";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type {
  SubagentNotification,
  SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import { WriterLeaseService } from "../boundary/writer-lease.ts";
import {
  InvalidSubagentRequestError,
  isOutcomeUncertain,
  type SubagentError,
  SubagentNotFoundError,
  SubagentRuntimeClosedError,
} from "./errors.ts";
import { makeQueuedStartCheck, makeRunAdmissionSignal } from "./admission-signal.ts";
import { makeRunAssignment } from "./assignment.ts";
import { makeRunCompletionObservations } from "./completion-observations.ts";
import { makeRunPeerNotifier } from "./coordination.ts";
import { makeRunControls } from "./control.ts";
import { makeRunEventHandler } from "./events.ts";
import { makeRunLaunch } from "./launch.ts";
import type { RunContext, RunOwnership, RunRecord, WithRunLock } from "./internal.ts";
import {
  makeRunNotificationDelivery,
  type QuestionNotificationReceipt,
} from "./notification-delivery.ts";
import { makeRunOwnedRuns, type OwnedRunCoordinatorContract } from "./owned-runs.ts";
import { makeRunProcessControls, makeRunProcessInitializer } from "./process-lifecycle.ts";
import { makeRunRecordCleanup } from "./record-cleanup.ts";
import { makeRunResume } from "./resume.ts";
import { makeRunRetry, type SubagentRetryClaim } from "./retry.ts";
import { makeRunSettlement } from "./settlement.ts";
import {
  type FailedStartRecovery,
  hasSubagentCapability,
  isActiveRunState,
  SUBAGENT_ROOT_RUN_ID,
  type StartSubagentRequest,
  type SubagentRetrySupersession,
  type SubagentProjection,
  type SubagentRunView,
} from "./model.ts";
import { sortRuns } from "./projection.ts";
import { sanitizeOutputText, snapshotView } from "./state.ts";
import { runSessionOwned } from "./session-owned.ts";
import { descendantRunIds, isRunInSubtree, leafFirst, projectRunTree } from "./tree.ts";
import { makeRunProxyExecution } from "./proxy-execution.ts";
import { makeRunStructuredResults } from "./structured-result.ts";
import { makeWriterPreparation } from "./writer-preparation.ts";
import type { WriterPoolEntry } from "./writer-pool.ts";
import { makeRunWriteClaimControl } from "./write-claim-control.ts";
import { makeWorkspaceControl, type WorkspaceCoordinatorContract } from "./workspace-control.ts";
import { WorkspaceService } from "../workspace/service.ts";
import type { WriterWorkspaceMode } from "../config/schema.ts";

let nextRuntimeNamespace = 1;
const allocateRuntimeNamespace = (): string => `r${(nextRuntimeNamespace++).toString(36)}`;

export type SubagentNotificationCallback =
  | ((notification: SubagentNotification) => SubagentNotificationDelivery | undefined)
  | ((notification: SubagentNotification) => void);

export interface SubagentServiceOptions {
  readonly writerWorkspaceMode?: WriterWorkspaceMode;
  readonly workspaceOwnerId?: string;
  readonly workspaceSourceCwd?: string;
  readonly publish?: (projection: SubagentProjection) => void;
  readonly notify?: SubagentNotificationCallback;
  readonly questionnaireHandler?: (
    request: AskUserRequest,
    owner: QuestionnaireOwner,
  ) => Effect.Effect<BackendProxyResult, SubagentError>;
  readonly proxyHandler?:
    | ((
        service: SubagentServiceContract,
        callerRunId: string,
        request: BackendProxyRequest,
      ) => Effect.Effect<
        BackendProxyResult,
        SubagentError,
        SubagentProfileService | SubagentBackendRegistry
      >)
    | undefined;
}

export type SubagentAwaitUntil = "all_finished" | "any_finished";

export interface SubagentCompletionReceipt {
  readonly id: string;
  readonly generation: number;
  /** Capability proving ownership of this exact unresolved generation. */
  readonly claimToken: string;
}

export interface SubagentRunObservation {
  readonly run: SubagentRunView;
  readonly completionReceipt?: SubagentCompletionReceipt | undefined;
  /** Exact pending question owned by this await, never by status. */
  readonly questionReceipt?: QuestionNotificationReceipt | undefined;
  /** Authoritative record cleanup and retry facts for a failed initial assignment. */
  readonly recovery?: FailedStartRecovery | undefined;
}

export interface SubagentStatusObservations {
  readonly observations: ReadonlyArray<SubagentRunObservation>;
  readonly missingIds: ReadonlyArray<string>;
}

export interface SubagentStatusObservationOptions {
  /**
   * Read back the latest retained report after its outcome was delivered and no other
   * operation owns it. Read-back carries no receipt, so it never consumes or re-notifies.
   */
  readonly includeDeliveredReports?: boolean | undefined;
}

export interface SubagentServiceContract
  extends WorkspaceCoordinatorContract, OwnedRunCoordinatorContract {
  readonly start: (request: StartSubagentRequest) => Effect.Effect<SubagentRunView, SubagentError>;
  /** Submit one launch to the session owner; cancelling the waiter never abandons ownership. */
  readonly startSessionOwned: (
    request: StartSubagentRequest,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  /** Trusted root host boundary seeds immutable script-origin subtree policy. */
  readonly startScriptSessionOwned: (
    request: StartSubagentRequest,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  /** Authenticated nested-Pi admission; ancestry comes only from the server-side caller identity. */
  readonly startSessionOwnedFrom: (
    callerRunId: string,
    request: StartSubagentRequest,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly visibleList: (callerRunId: string) => Effect.Effect<ReadonlyArray<SubagentRunView>>;
  readonly authorizeTargets: (
    callerRunId: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, SubagentNotFoundError>;
  readonly claimRetryContinuation: (id: string) => Effect.Effect<SubagentRetryClaim, SubagentError>;
  readonly releaseRetryClaim: (id: string, claimToken: string) => Effect.Effect<void>;
  readonly exhaustRetryClaim: (
    id: string,
    claimToken: string,
  ) => Effect.Effect<void, SubagentError>;
  readonly blockRetryClaim: (id: string, claimToken: string) => Effect.Effect<void, SubagentError>;
  /** Submit an exclusively claimed successor; waiter cancellation never abandons ownership. */
  readonly startRetrySessionOwned: (
    request: StartSubagentRequest & { readonly supersedes: SubagentRetrySupersession },
    onOwned?: () => void,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  /**
   * Await selected observations. The optional update projection is the root-owned immutable
   * snapshot; consumers must derive only authorized target subtrees before external rendering.
   */
  readonly awaitTerminal: (
    ids: ReadonlyArray<string>,
    until: SubagentAwaitUntil,
    onUpdate?: (
      runs: ReadonlyArray<SubagentRunView>,
      projection?: ReadonlyArray<SubagentRunView>,
    ) => void,
  ) => Effect.Effect<ReadonlyArray<SubagentRunView>, SubagentError>;
  readonly withAwaitTerminalObservations: <A, E, R>(
    ids: ReadonlyArray<string>,
    until: SubagentAwaitUntil,
    onUpdate:
      | ((
          runs: ReadonlyArray<SubagentRunView>,
          projection?: ReadonlyArray<SubagentRunView>,
        ) => void)
      | undefined,
    use: (observations: ReadonlyArray<SubagentRunObservation>) => Effect.Effect<A, E, R>,
    /** A bounded result may omit a question even when its observation was claimed. */
    questionCoverage?: (result: A) => ReadonlySet<string>,
  ) => Effect.Effect<A, SubagentError | E, R>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentRunView>>;
  readonly status: (id: string) => Effect.Effect<SubagentRunView, SubagentNotFoundError>;
  readonly withStatusObservations: <A, E, R>(
    ids: ReadonlyArray<string>,
    use: (selection: SubagentStatusObservations) => Effect.Effect<A, E, R>,
    options?: SubagentStatusObservationOptions,
  ) => Effect.Effect<A, InvalidSubagentRequestError | E, R>;
  readonly consumeCompletions: (
    receipts: ReadonlyArray<SubagentCompletionReceipt>,
  ) => Effect.Effect<void>;
  readonly send: (id: string, message: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly reply: (id: string, message: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly interrupt: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly resume: (id: string, message?: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly rename: (id: string, name: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly stop: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly grantWriteClaims: (
    id: string,
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly revokeWriteClaims: (
    id: string,
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly resumeWriterAdmission: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly projection: Effect.Effect<SubagentProjection>;
}

const notFound = (id: string) =>
  new SubagentNotFoundError({ id, message: `Subagent run not found: ${id}` });
const makeService = Effect.fn("SubagentService.make")(function* (options: SubagentServiceOptions) {
  const backendRegistry = yield* SubagentBackendRegistry;
  const profileService = yield* SubagentProfileService;
  const writerLeases = yield* WriterLeaseService;
  const workspaceEngine = yield* Effect.serviceOption(WorkspaceService);
  const initialProfiles = yield* profileService.capture;
  const ownerScope = yield* Effect.scope;
  // Keyed parent-proxy executions for the `${runId}:${requestId}` identity. Effect v4
  // FiberMap.make registers one acquireRelease finalizer on the service scope that marks the
  // map Closed and then interrupts every managed fiber; because it is acquired before the
  // leaf-first shutdown finalizer below, LIFO finalizer order runs that shutdown first and
  // interrupts surviving proxy executions only afterwards.
  const proxyRuns = yield* FiberMap.make<string, void, never>();
  const lock = yield* Semaphore.make(1);
  const completionGate = yield* Semaphore.make(1);
  const records = new Map<string, RunRecord>();
  const writerPools = new Map<string, WriterPoolEntry>();
  // Each run view is already deeply frozen by snapshotView, so only the fresh
  // top-level container and array need freezing before publication.
  const frozenProjection = (revision: number): SubagentProjection => {
    const tree = projectRunTree(records);
    return Object.freeze({
      revision,
      root: tree.root,
      runs: Object.freeze(sortRuns(tree.runs.map((view) => snapshotView(view)))),
    });
  };
  const projectionRef = yield* SubscriptionRef.make(frozenProjection(0));
  const runtimeNamespace = allocateRuntimeNamespace();
  let nextRunOrdinal = 1;
  let nextClaimOrdinal = 1;
  let nextRetryClaimOrdinal = 1;
  let nextAssignmentAttemptOrdinal = 1;
  let closed = false;
  const questionnaires = makeQuestionnaireLifetimes(() => closed);
  // Workspace launch slots join the signal once workspace control exists below.
  let launchSlotHoldings = (): Iterable<string> => [];
  const admission = makeRunAdmissionSignal(records, writerPools, () => launchSlotHoldings());
  const recheckAdmission = Effect.sync(admission.observe);

  // Every locked section ends with an admission check, so a claim taken under the lock is in
  // the signal's snapshot before any start it refuses, and its later release wakes waiters.
  const withLock: WithRunLock = (effect) =>
    lock.withPermits(1)(Effect.ensuring(effect, recheckAdmission));
  const withCompletionGate = completionGate.withPermits(1);
  interface TurnInputAdmission {
    count: number;
    drained: Deferred.Deferred<void> | undefined;
  }
  const turnInputs = new WeakMap<RunRecord, TurnInputAdmission>();
  const admitTurnInput = (record: RunRecord): void => {
    const admission = turnInputs.get(record);
    if (admission) admission.count += 1;
    else turnInputs.set(record, { count: 1, drained: undefined });
  };
  const releaseTurnInput = (record: RunRecord): Effect.Effect<void> =>
    withLock(
      Effect.sync(() => {
        const admission = turnInputs.get(record);
        if (!admission) return;
        admission.count -= 1;
        if (admission.count > 0) return;
        turnInputs.delete(record);
        if (admission.drained) Deferred.doneUnsafe(admission.drained, Effect.void);
      }),
    );
  const claimTurnInputDrain = (record: RunRecord, drained: Deferred.Deferred<void>): void => {
    const admission = turnInputs.get(record);
    if (admission && admission.count > 0) admission.drained = drained;
    else Deferred.doneUnsafe(drained, Effect.void);
  };
  const allocateClaimToken = (): string => `completion-${runtimeNamespace}-${nextClaimOrdinal++}`;
  const allocateRetryClaimToken = (): string =>
    `retry-${runtimeNamespace}-${nextRetryClaimOrdinal++}`;
  const allocateAssignmentAttemptToken = (): string =>
    `assignment-${runtimeNamespace}-${nextAssignmentAttemptOrdinal++}`;
  const runIdPrefix = `agent-${runtimeNamespace}-`;
  const allocateRunIdentity = (requestedName: string, reservedId?: string) => {
    if (reservedId !== undefined)
      return {
        id: reservedId,
        name: requestedName || `subagent-${reservedId.slice(runIdPrefix.length)}`,
      };
    const ordinal = nextRunOrdinal++;
    return { id: `${runIdPrefix}${ordinal}`, name: requestedName || `subagent-${ordinal}` };
  };
  const reserveRunId = Effect.sync(() => `${runIdPrefix}${nextRunOrdinal++}`);
  const isAllocatedRunId = (id: string): boolean => {
    const ordinal = Number(id.slice(runIdPrefix.length));
    return (
      id === `${runIdPrefix}${ordinal}` &&
      Number.isSafeInteger(ordinal) &&
      ordinal >= 1 &&
      ordinal < nextRunOrdinal
    );
  };
  const publish = Effect.uninterruptible(
    questionnaires.invalidate.pipe(
      Effect.andThen(recheckAdmission),
      Effect.andThen(
        Effect.suspend(() =>
          // Late cleanup still commits record state, but a closed projection channel
          // must neither interrupt that cleanup nor publish into a replaced session.
          closed
            ? Effect.void
            : SubscriptionRef.updateAndGet(projectionRef, (current) =>
                frozenProjection(current.revision + 1),
              ).pipe(
                Effect.flatMap((projection) =>
                  options.publish
                    ? Effect.try(() => options.publish?.(projection)).pipe(Effect.ignore)
                    : Effect.void,
                ),
              ),
        ),
      ),
    ),
  );
  const waitForRevision = (after: number): Effect.Effect<void, SubagentRuntimeClosedError> =>
    Effect.scoped(
      Effect.gen(function* () {
        // Subscribe to the same replay-one source as SubscriptionRef.changes, so a
        // revision published before subscription is not lost. The pinned Stream
        // PubSub adapter adds a failing Cause.Done finalizer on interruption;
        // taking directly keeps cancellation interruption-only and scopes cleanup.
        const subscription = yield* PubSub.subscribe(projectionRef.pubsub);
        while ((yield* PubSub.take(subscription)).revision <= after) {
          // Ignore the replayed revision until a newer projection arrives.
        }
      }),
    ).pipe(
      // PubSub shutdown must retain the service's typed closed-session failure.
      Effect.catchCauseIf(
        (cause) => closed && Cause.hasInterruptsOnly(cause),
        () => Effect.fail(new SubagentRuntimeClosedError({ message: "Parent session shut down." })),
      ),
    );
  const notifyRoot = (
    notification: SubagentNotification,
  ): SubagentNotificationDelivery | undefined => {
    try {
      const delivered = options.notify?.(notification);
      return hasObjectRuntimeType(delivered) && delivered !== null ? delivered : undefined;
    } catch {
      return notification.type === "completed"
        ? { deliveredCompletionKeys: [] }
        : { actionAccepted: false };
    }
  };
  const ancestorMessage = (notification: SubagentNotification): string => {
    if (notification.type === "question")
      return sanitizeOutputText(
        `Descendant ${notification.name} (${notification.id}) is waiting for a reply.\n\nQuestion: ${notification.message}\n\nUse subagent_reply for ${notification.id}.`,
        32 * 1024,
      );
    const run = notification.runs[0];
    if (!run) return "A descendant subagent finished.";
    const outcome =
      run.outcome === "failed"
        ? `failed: ${run.error ?? "No failure detail."}`
        : `reported: ${run.finalText ?? "No final report."}`;
    return sanitizeOutputText(
      `Descendant ${run.name} (${run.id}) ${outcome}\n\nUse subagent_status or subagent_await for the full run record.`,
      32 * 1024,
    );
  };
  const canAcceptNotification = (record: RunRecord): boolean =>
    isActiveRunState(record.view.state) &&
    record.view.state !== "paused" &&
    !record.pauseRequested &&
    record.process?.controls.deliverNotification !== undefined;
  const deliverToNearestAncestor = (
    sourceRunId: string,
    message: string,
  ): Effect.Effect<boolean | "uncertain"> =>
    Effect.suspend(() => {
      let parentRunId = records.get(sourceRunId)?.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
      const candidates: RunRecord[] = [];
      const visited = new Set<string>();
      while (parentRunId !== SUBAGENT_ROOT_RUN_ID && visited.add(parentRunId)) {
        const parent = records.get(parentRunId);
        if (!parent) break;
        if (parent.view.runtime === "pi" && canAcceptNotification(parent)) candidates.push(parent);
        parentRunId = parent.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
      }
      const attempt = (index: number): Effect.Effect<boolean | "uncertain"> => {
        const candidate = candidates[index];
        if (!candidate) return Effect.succeed(false);
        return Effect.acquireUseRelease(
          withLock(
            Effect.sync(() => {
              const current = records.get(candidate.view.id);
              const deliverNotification = current?.process?.controls.deliverNotification;
              if (current !== candidate || !deliverNotification || !canAcceptNotification(current))
                return undefined;
              admitTurnInput(current);
              return { record: current, deliverNotification };
            }),
          ),
          (admission) =>
            admission
              ? admission.deliverNotification(message).pipe(Effect.as(true))
              : Effect.succeed(false),
          (admission) => (admission ? releaseTurnInput(admission.record) : Effect.void),
        ).pipe(
          Effect.flatMap((delivered) => (delivered ? Effect.succeed(true) : attempt(index + 1))),
          Effect.catch((error) =>
            error._tag === "SubagentProcessError" && isOutcomeUncertain(error)
              ? Effect.succeed("uncertain" as const)
              : attempt(index + 1),
          ),
        );
      };
      return attempt(0);
    });
  const notify = (
    notification: SubagentNotification,
  ): Effect.Effect<SubagentNotificationDelivery | undefined> => {
    if (
      notification.type === "completed" &&
      notification.runs.every(
        (run) =>
          (records.get(run.id)?.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID) === SUBAGENT_ROOT_RUN_ID,
      )
    )
      return Effect.succeed(notifyRoot(notification));
    if (notification.type === "question")
      return deliverToNearestAncestor(notification.id, ancestorMessage(notification)).pipe(
        Effect.map((delivered) =>
          delivered === "uncertain"
            ? { actionAccepted: false }
            : delivered
              ? { actionAccepted: true }
              : notifyRoot(notification),
        ),
      );
    return Effect.forEach(
      notification.runs,
      (run) =>
        deliverToNearestAncestor(run.id, ancestorMessage({ type: "completed", runs: [run] })).pipe(
          Effect.map((delivered) => {
            // A completion sent to an ancestor may be outcome-uncertain; unlike an
            // unacknowledged question it must not replay the full report.
            if (delivered) return `${run.id}:${run.generation}`;
            const rootDelivery = notifyRoot({ type: "completed", runs: [run] });
            return rootDelivery?.deliveredCompletionKeys?.includes(`${run.id}:${run.generation}`)
              ? `${run.id}:${run.generation}`
              : undefined;
          }),
        ),
      { concurrency: 4 },
    ).pipe(
      Effect.map((keys) => ({
        deliveredCompletionKeys: keys.filter((key): key is string => key !== undefined),
      })),
    );
  };
  const requireRecord = (id: string): Effect.Effect<RunRecord, SubagentNotFoundError> =>
    Effect.suspend(() => {
      const record = records.get(id);
      return record ? Effect.succeed(record) : Effect.fail(notFound(id));
    });
  const runContext: RunContext = {
    ownerScope,
    withLock,
    publish,
    recheckAdmission,
    records,
    writerPools,
    writerLeases,
    requireRecord,
    sendPeerNotices: makeRunPeerNotifier(records),
    allocateAssignmentAttemptToken,
  };
  const workspaces = makeWorkspaceControl({
    ...runContext,
    engine: Option.getOrUndefined(workspaceEngine),
    initialMode: options.writerWorkspaceMode ?? initialProfiles.effectiveConfig.writerWorkspaceMode,
    ownerId: options.workspaceOwnerId ?? runtimeNamespace,
    ...(options.workspaceSourceCwd && { sourceCwd: options.workspaceSourceCwd }),
    isClosed: () => closed,
  });
  launchSlotHoldings = workspaces.launchSlotHoldings;

  const delivery = yield* makeRunNotificationDelivery({
    ...runContext,
    withCompletionGate,
    notify,
  });
  const observations = makeRunCompletionObservations({
    ...runContext,
    withCompletionGate,
    currentProjection: () => SubscriptionRef.getUnsafe(projectionRef),
    waitForRevision,
    allocateClaimToken,
    delivery,
  });

  const retry = makeRunRetry({ ...runContext, allocateClaimToken: allocateRetryClaimToken });

  const prepareWriterLeaseForSpawn = makeWriterPreparation(runContext);
  const {
    reclaimRecordRunState,
    markCleanupPending,
    retainCleanupQuarantine,
    closeRecordScope: closeOwnedRecordScope,
    closeExitedScope,
  } = makeRunRecordCleanup(runContext);

  const closeRecordScope: typeof closeOwnedRecordScope = (record, scope) =>
    questionnaires.drain(record).pipe(Effect.andThen(closeOwnedRecordScope(record, scope)));

  const settlement = makeRunSettlement({ ...runContext, delivery, closeRecordScope });

  const processControls = makeRunProcessControls(withLock);

  const assignment = makeRunAssignment({
    ...runContext,
    startPrompt: processControls.startPrompt,
    activateAssignmentLocked: settlement.activateAssignmentLocked,
    replayAssignmentActivation: settlement.replayAssignmentActivation,
  });

  const controls = makeRunControls({
    ...runContext,
    steerBackend: processControls.steer,
    submitPrompt: assignment.submitPrompt,
    retainUncertainAssignment: assignment.retainUncertainAssignment,
    interruptBackend: processControls.interrupt,
    admitTurnInput,
    releaseTurnInput,
    claimTurnInputDrain,
    renameBackend: processControls.renameDisplay,
    closeRecordScope,
    settle: settlement.settle,
  });

  const stop: SubagentServiceContract["stop"] = (id) =>
    runSessionOwned(
      ownerScope,
      withLock(
        Effect.gen(function* () {
          const root = yield* requireRecord(id);
          // Descendants are already leaf-first; the requested root closes last.
          const ordered = [...descendantRunIds(records, id), root.view.id];
          for (const targetId of ordered) {
            const target = records.get(targetId);
            if (target) target.stoppedByParent = true;
          }
          return ordered;
        }),
      ),
      (orderedIds) =>
        Effect.gen(function* () {
          // Every target is attempted in order; the first typed failure wins afterwards.
          const [stopped, failures] = yield* Effect.partition(orderedIds, (targetId) =>
            controls.stop(targetId),
          );
          if (failures[0]) return yield* failures[0];
          return stopped.at(-1) ?? snapshotView((yield* requireRecord(id)).view);
        }),
    );

  // Do not publish a pool pause without admitting its containment fiber to the service scope.
  const containWriteClaimViolation = (record: RunRecord, message: string) =>
    Effect.uninterruptible(
      withLock(
        Effect.gen(function* () {
          if (record.writeViolationContainmentStarted) return false;
          const pool = record.writerPool;
          if (!pool) return false;
          record.writeViolationContainmentStarted = true;
          pool.admissionPaused = true;
          pool.violationRunIds.add(record.view.id);
          pool.pauseReason = message;
          for (const memberId of pool.members.keys()) {
            const member = records.get(memberId);
            if (!member) continue;
            member.view = {
              ...member.view,
              writeAdmissionPaused: true,
              writeViolationOffender: pool.violationRunIds.has(memberId) ? true : undefined,
            };
          }
          yield* publish;
          const resumableInterrupt =
            hasSubagentCapability(record.view, "interrupt") &&
            hasSubagentCapability(record.view, "resume");
          if (
            resumableInterrupt &&
            (record.view.state === "running" || record.view.state === "waiting_for_parent")
          )
            return "interrupt" as const;
          return isActiveRunState(record.view.state) &&
            record.view.state !== "paused" &&
            record.view.state !== "stopping"
            ? ("stop" as const)
            : undefined;
        }),
      ).pipe(
        Effect.flatMap((containmentAction) => {
          if (!containmentAction) return Effect.void;
          const stopAfterFailure = (interruptError?: SubagentError) =>
            stop(record.view.id).pipe(
              Effect.asVoid,
              Effect.catch((stopError) =>
                Effect.logWarning(
                  interruptError
                    ? `Could not contain write-claim violation after interrupt and stop failed: ${stopError.message}`
                    : `Could not contain write-claim violation because stop failed: ${stopError.message}`,
                ).pipe(Effect.annotateLogs("runId", record.view.id)),
              ),
            );
          const containment =
            containmentAction === "interrupt"
              ? controls.interrupt(record.view.id).pipe(
                  Effect.asVoid,
                  Effect.catch((interruptError) => stopAfterFailure(interruptError)),
                )
              : stopAfterFailure();
          return containment.pipe(
            Effect.forkIn(ownerScope, { startImmediately: true }),
            Effect.asVoid,
          );
        }),
      ),
    );

  const handleProxyEvent = makeRunProxyExecution({
    ownerScope,
    executions: proxyRuns,
    ...(options.proxyHandler && {
      executeProxy: (callerRunId, request) =>
        options.proxyHandler!(service, callerRunId, request).pipe(
          Effect.provideService(SubagentProfileService, profileService),
          Effect.provideService(SubagentBackendRegistry, backendRegistry),
        ),
    }),
    ...(options.questionnaireHandler && {
      executeQuestionnaire: (record, requestId, request) =>
        questionnaires.own(record, requestId, (owner) =>
          options.questionnaireHandler!(request, owner),
        ),
    }),
  });

  const handleWireEvent = makeRunEventHandler({
    mutateView: settlement.mutateEventView,
    mergeLateUsage: settlement.mergeLateUsage,
    mergeProcessUsage: settlement.mergeProcessUsage,
    runStarted: settlement.runStartedFromBackend,
    runSettled: settlement.runSettledFromBackend,
    settle: settlement.settle,
    acceptReport: settlement.acceptBackendReport,
    queueQuestionLocked: delivery.queueActionNotificationLocked,
    failRun: settlement.failRun,
    onWriteClaimViolation: containWriteClaimViolation,
    onProxyEvent: handleProxyEvent,
    onStructuredResult: makeRunStructuredResults({ withLock }),
  });

  const initializeProcess = makeRunProcessInitializer({
    ...runContext,
    initialize: processControls.initialize,
    handleBackendEvent: handleWireEvent,
    prepareBackendSpawn: prepareWriterLeaseForSpawn,
    markCleanupPending,
    closeExitedScope,
    failRun: settlement.failRun,
  });

  const launch = makeRunLaunch({
    ...runContext,
    backendRegistry,
    records,
    delivery,
    isClosed: () => closed,
    allocateRunIdentity,
    reclaimRecordRunState,
    retainCleanupQuarantine,
    markCleanupPending,
    closeRecordScope,
    settle: settlement.settle,
    submitPrompt: assignment.submitPrompt,
    initializeProcess,
    bindWorkspace: workspaces.bind,
    heldLaunchSlots: workspaces.heldLaunchSlots,
  });

  const startWithWorkspace = (
    request: StartSubagentRequest,
    scriptedRoot = false,
    ownership?: RunOwnership,
  ) =>
    launch
      .validate(request, scriptedRoot)
      .pipe(
        Effect.andThen(
          workspaces.withLaunch(request, (prepared) =>
            launch.start(prepared, scriptedRoot, ownership),
          ),
        ),
      );
  const startWorkspaceSessionOwned = (request: StartSubagentRequest, scriptedRoot = false) =>
    runSessionOwned(ownerScope, Effect.void, () => startWithWorkspace(request, scriptedRoot)).pipe(
      Effect.map((view) => observations.redactCompletionReport(view)),
    );

  const resume = makeRunResume({
    ...runContext,
    delivery,
    initializeProcess,
    submitPrompt: assignment.submitPrompt,
    settle: settlement.settle,
    failRun: settlement.failRun,
    closeRecordScope,
    retainUncertainAssignment: assignment.retainUncertainAssignment,
    invalidateWorkspace: workspaces.invalidateForResume,
    heldLaunchSlots: workspaces.heldLaunchSlots,
    currentChildLimit: profileService.capture.pipe(
      Effect.map((snapshot) => snapshot.effectiveConfig.nesting.maxDirectChildren),
    ),
  });

  const writeClaims = makeRunWriteClaimControl(runContext);

  // Without a captured policy, launch would fall back to the default nesting limits.
  const withSessionNesting = (request: StartSubagentRequest) =>
    request.nestingPolicy
      ? Effect.succeed(request)
      : profileService.capture.pipe(
          Effect.map((snapshot) => ({
            ...request,
            nestingPolicy: snapshot.effectiveConfig.nesting,
            nestingPolicyRevision: snapshot.revision,
          })),
        );
  const ownedRuns = makeRunOwnedRuns({
    ...runContext,
    allocateClaimToken,
    isAllocatedRunId,
    currentRevision: () => SubscriptionRef.getUnsafe(projectionRef).revision,
    waitForRevision,
    delivery,
    start: (request, ownership) =>
      withSessionNesting(request).pipe(
        Effect.flatMap((complete) => startWithWorkspace(complete, false, ownership)),
      ),
    stop,
  });
  const queuedStartRefused = makeQueuedStartCheck({
    ...runContext,
    heldLaunchSlots: (caller) => workspaces.heldLaunchSlots(caller),
    withSessionNesting,
  });

  const startRetrySessionOwned: SubagentServiceContract["startRetrySessionOwned"] = (
    request,
    onOwned,
  ) =>
    runSessionOwned(
      ownerScope,
      Effect.void,
      () =>
        startWithWorkspace(request).pipe(
          Effect.ensuring(
            retry.releaseRetryClaim(request.supersedes.runId, request.supersedes.claimToken),
          ),
        ),
      onOwned,
    ).pipe(Effect.map((view) => observations.redactCompletionReport(view)));

  const list = SubscriptionRef.get(projectionRef).pipe(Effect.map((current) => current.runs));
  const visibleList: SubagentServiceContract["visibleList"] = (callerRunId) =>
    withLock(
      Effect.sync(() =>
        sortRuns(
          projectRunTree(records)
            .runs.filter((run) => isRunInSubtree(records, callerRunId, run.id))
            .map((run) => snapshotView(run)),
        ),
      ),
    );
  const authorizeTargets: SubagentServiceContract["authorizeTargets"] = (callerRunId, ids) =>
    withLock(
      Effect.gen(function* () {
        if (!records.has(callerRunId)) return yield* notFound(callerRunId);
        for (const id of ids)
          if (!isRunInSubtree(records, callerRunId, id)) return yield* notFound(id);
      }),
    );
  const startSessionOwnedFrom: SubagentServiceContract["startSessionOwnedFrom"] = (
    callerRunId,
    request,
  ) =>
    withLock(requireRecord(callerRunId).pipe(Effect.map((record) => record.view.cwd))).pipe(
      Effect.flatMap((cwd) =>
        startWorkspaceSessionOwned({ ...request, cwd, parentRunId: callerRunId }),
      ),
    );
  const status: SubagentServiceContract["status"] = (id) =>
    observations
      .withStatusObservations([id], ({ observations: selected }) => {
        const observation = selected[0];
        if (!observation) return Effect.fail(notFound(id));
        return (
          observation.completionReceipt
            ? observations.consumeCompletions([observation.completionReceipt])
            : Effect.void
        ).pipe(Effect.as(observation.run));
      })
      .pipe(Effect.catchTag("InvalidSubagentRequestError", () => Effect.fail(notFound(id))));

  const projection = SubscriptionRef.get(projectionRef);

  const service: SubagentServiceContract = {
    ...retry,
    ...observations,
    start: startWithWorkspace,
    startSessionOwned: startWorkspaceSessionOwned,
    startScriptSessionOwned: (request) => startWorkspaceSessionOwned(request, true),
    workspaceList: workspaces.workspaceList,
    workspaceReview: workspaces.workspaceReview,
    workspacePrepare: workspaces.workspacePrepare,
    workspaceIntegrate: workspaces.workspaceIntegrate,
    workspaceDiscard: workspaces.workspaceDiscard,
    // Bindings belong only to admitted writers, which can never have script origin.
    workspaceRevise: workspaces.revise((request, handle) =>
      runSessionOwned(ownerScope, Effect.void, () =>
        workspaces.withLaunch(request, launch.start, handle),
      ),
    ),
    inspectWriterWorkspace: workspaces.inspectWriterWorkspace,
    setWriterWorkspaceMode: workspaces.setWriterWorkspaceMode,
    startSessionOwnedFrom,
    visibleList,
    authorizeTargets,
    startRetrySessionOwned,
    list,
    status,
    send: controls.send,
    reply: controls.reply,
    interrupt: controls.interrupt,
    resume: resume.resume,
    rename: controls.rename,
    stop,
    grantWriteClaims: writeClaims.grant,
    revokeWriteClaims: writeClaims.revoke,
    resumeWriterAdmission: writeClaims.resumeAdmission,
    projection,
    ...ownedRuns,
    reserveRunId,
    waitForRevision,
    admissionRevision: admission.current,
    waitForAdmissionChange: admission.waitForChange,
    queuedStartRefused,
    workspaceBindingStatus: workspaces.workspaceBindingStatus,
  };

  yield* Effect.addFinalizer(() =>
    withLock(
      Effect.sync(() => {
        closed = true;
        admission.close();
      }),
    ).pipe(
      Effect.andThen(questionnaires.invalidate),
      Effect.andThen(
        Effect.forEach(
          leafFirst(records.values()),
          (record) => {
            record.stoppedByParent = true;
            record.process?.cancelPending(
              new SubagentRuntimeClosedError({ message: "Parent session shut down." }),
            );
            if (record.closingScope !== record.scope) record.cleanupPending = true;
            return closeRecordScope(record).pipe(
              Effect.andThen(
                withLock(Effect.sync(() => !record.cleanupPending && record.process === undefined)),
              ),
              Effect.flatMap((safeToReclaim) =>
                safeToReclaim
                  ? reclaimRecordRunState(record).pipe(
                      Effect.catch(() => retainCleanupQuarantine(record, record.scope)),
                    )
                  : Effect.void,
              ),
            );
          },
          { concurrency: 1, discard: true },
        ),
      ),
      Effect.asVoid,
      Effect.ensuring(PubSub.shutdown(projectionRef.pubsub)),
    ),
  );

  return service;
});

export class SubagentService extends Context.Service<SubagentService, SubagentServiceContract>()(
  "pi-subagents/run/service/SubagentService",
) {
  static readonly layer = (options: SubagentServiceOptions = {}) =>
    Layer.effect(this, makeService(options));
}
