import type { AskUserRequest, QuestionnaireOwner } from "pi-ask-user/protocol";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { questionnaireLifetimes } from "./questionnaire-lifetime.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
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
import type { ReportArchive } from "../boundary/report-archive.ts";
import { WriterLeaseService } from "../boundary/writer-lease.ts";
import {
  type InvalidSubagentRequestError,
  runNotFound,
  type SubagentError,
  type SubagentNotFoundError,
  SubagentRuntimeClosedError,
} from "./errors.ts";
import { agentMessageOperations } from "./agent-messages.ts";
import type {
  AgentCaller,
  AgentListResult,
  AgentMainCapabilities,
  AgentReadResult,
  AgentSendResult,
} from "./agent-messaging.ts";
import { assignmentOperations } from "./assignment.ts";
import { completionObservationOperations } from "./completion-observations.ts";
import { peerNotifier } from "./coordination.ts";
import { controlOperations } from "./control.ts";
import { backendEventHandler } from "./events.ts";
import { launchOperations } from "./launch.ts";
import type { RunContext, RunRecord, WithRunLock } from "./internal.ts";
import { notificationDelivery } from "./notification-delivery.ts";
import { processControlOperations, processInitializer } from "./process-lifecycle.ts";
import { recordCleanup, type RunRecordCleanup } from "./record-cleanup.ts";
import { resumeOperations } from "./resume.ts";
import { settlementOperations } from "./settlement.ts";
import {
  type StartSubagentRequest,
  type SubagentLaunchParent,
  type SubagentParentContext,
  type SubagentProjection,
  type SubagentRunView,
  type SubagentControlExpectation,
  type SubagentUsage,
} from "./model.ts";
import { sortRuns } from "./projection.ts";
import { closeRunsLeafFirst } from "./shutdown.ts";
import { projectRunTree } from "./tree.ts";
import { allocateRuntimeNamespace, identityAllocators } from "./identity.ts";
import { notificationRouter } from "./notification-routing.ts";
import { parentDrainAwaiter } from "./parent-drain.ts";
import {
  emptySessionUsageLedger,
  sessionUsageLocked,
  takeUnrecordedUsageLocked,
} from "./session-usage.ts";
import { sessionStartOperations } from "./session-starts.ts";
import { subtreeStopper } from "./subtree-stop.ts";
import { turnInputGates } from "./turn-input.ts";
import { visibilityOperations } from "./visibility.ts";
import { proxyExecutionHandler } from "./proxy-execution.ts";
import { writerSpawnPreparation } from "./writer-preparation.ts";
import { WriterPools } from "./writer-pool.ts";
import { workspaceControl, type WorkspaceCoordinatorContract } from "./workspace-control.ts";
import { WorkspaceService } from "../workspace/service.ts";
import type { WorktreeCreateSetup, WriterWorkspaceMode } from "../config/schema.ts";

export interface SubagentServiceOptions {
  readonly writerWorkspaceMode?: WriterWorkspaceMode;
  /** Run in order in every new worker and prepared tree before it is used. */
  readonly worktreeCreate?: WorktreeCreateSetup | undefined;
  readonly workspaceOwnerId?: string;
  readonly workspaceSourceCwd?: string;
  readonly publish?: (projection: SubagentProjection) => void;
  /** Subagent usage that earlier runtimes recorded in this session. */
  readonly restoredSessionUsage?: SubagentUsage | undefined;
  /** Records usage in the session once a run's assignment settles, and at shutdown. */
  readonly recordSessionUsage?: ((usage: SubagentUsage) => void) | undefined;
  readonly notify?: (
    notification: SubagentNotification,
  ) => SubagentNotificationDelivery | undefined | void;
  /** Saves each completed report in full at settlement; the session's private report archive. */
  readonly archiveReport?: ReportArchive | undefined;
  /** Reaches the root session's main agent for `agent_*` messages; without it `main` is unavailable. */
  readonly agentMain?: AgentMainCapabilities | undefined;
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

interface SubagentCompletionReceipt {
  readonly id: string;
  readonly generation: number;
  readonly claimToken: string;
}

export interface SubagentRunObservation {
  readonly run: SubagentRunView;
  readonly completionReceipt?: SubagentCompletionReceipt | undefined;
}

export interface SubagentServiceContract extends WorkspaceCoordinatorContract {
  readonly start: (request: StartSubagentRequest) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly startSessionOwned: (
    request: StartSubagentRequest,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly startScriptSessionOwned: (
    request: StartSubagentRequest,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly startSessionOwnedFrom: (
    callerRunId: string,
    request: StartSubagentRequest,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly captureLaunchParent: (
    runId: string,
    nativeContext?: SubagentParentContext,
  ) => Effect.Effect<SubagentLaunchParent, SubagentError>;
  readonly visibleList: (callerRunId: string) => Effect.Effect<ReadonlyArray<SubagentRunView>>;
  readonly authorizeTargets: (
    callerRunId: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, InvalidSubagentRequestError | SubagentNotFoundError>;
  readonly withAwaitTerminalObservations: <A, E, R>(
    ids: ReadonlyArray<string>,
    until: SubagentAwaitUntil,
    onUpdate:
      | ((
          runs: ReadonlyArray<SubagentRunView>,
          projection?: ReadonlyArray<SubagentRunView>,
        ) => void)
      | undefined,
    /**
     * Receives the target observations and any other run whose question reaches this caller,
     * which ends the wait as well.
     */
    use: (
      observations: ReadonlyArray<SubagentRunObservation>,
      questions?: ReadonlyArray<SubagentRunView>,
    ) => Effect.Effect<A, E, R>,
    /** The awaiting run, or undefined for the root session. */
    callerRunId?: string,
  ) => Effect.Effect<A, SubagentError | E, R>;
  readonly consumeCompletions: (
    receipts: ReadonlyArray<SubagentCompletionReceipt>,
  ) => Effect.Effect<void>;
  /**
   * The user's message from Activity or the fleet, through the agent-message delivery: it answers
   * the target's pending question or steers its running turn as bare text, and never resumes it.
   */
  readonly send: (
    id: string,
    message: string,
    expected?: SubagentControlExpectation,
  ) => Effect.Effect<AgentSendResult, SubagentError>;
  readonly interrupt: (
    id: string,
    expected?: SubagentControlExpectation,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly resume: (
    id: string,
    message?: string,
    expected?: SubagentControlExpectation,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly rename: (
    id: string,
    name: string,
    expected?: SubagentControlExpectation,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly stop: (
    id: string,
    expected?: SubagentControlExpectation,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  /** Lists `main` and every run in the root tree; `ids` selects up to 12 of them. */
  readonly agentList: (
    caller: AgentCaller,
    ids?: ReadonlyArray<string>,
  ) => Effect.Effect<AgentListResult, SubagentError>;
  /**
   * Delivers one message to another agent in the root tree now: it wakes an idle main agent, and
   * resumes a paused or finished run when the sender is its ancestor or main.
   */
  readonly agentSend: (
    caller: AgentCaller,
    to: string,
    message: string,
  ) => Effect.Effect<AgentSendResult, SubagentError>;
  /** Reads agents' last messages without claiming or consuming any report. */
  readonly agentRead: (
    caller: AgentCaller,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<AgentReadResult, SubagentError>;
  readonly projection: Effect.Effect<SubagentProjection>;
  /** Hands every eligible completion to its notifier now, as a session ends. */
  readonly deliverPendingCompletions: Effect.Effect<void>;
  /** Resolves when headless parent work has drained; see `parentDrainAwaiter`. */
  readonly awaitParentDrain: Effect.Effect<void, SubagentRuntimeClosedError>;
}

const makeService = Effect.fn("SubagentService.make")(function* (options: SubagentServiceOptions) {
  const backendRegistry = yield* SubagentBackendRegistry;
  const profileService = yield* SubagentProfileService;
  const writerLeases = yield* WriterLeaseService;
  const workspaceEngine = yield* Effect.serviceOption(WorkspaceService);
  const initialProfiles = yield* profileService.capture;
  // Register operation ownership before shutdown, so retirement revokes publication before joins.
  const ownerScope = yield* Scope.fork(yield* Effect.scope, "sequential");
  const proxyRuns = yield* FiberMap.make<string, void, never>();
  const lock = yield* Semaphore.make(1);
  const completionGate = yield* Semaphore.make(1);
  const records = new Map<string, RunRecord>();
  const sessionUsage = emptySessionUsageLedger(options.restoredSessionUsage);
  const recordSessionUsage = (includeActive: boolean) =>
    Effect.sync(() =>
      takeUnrecordedUsageLocked(sessionUsage, records.values(), includeActive),
    ).pipe(
      Effect.flatMap((usage) =>
        Effect.forEach(
          usage,
          (settled) =>
            Effect.sync(() =>
              invokeHostCallback(() => options.recordSessionUsage?.(settled), undefined),
            ),
          { discard: true },
        ),
      ),
    );
  const writerPools = new WriterPools();
  const frozenProjection = (revision: number): SubagentProjection =>
    Object.freeze({
      revision,
      runs: Object.freeze(sortRuns(projectRunTree(records))),
      sessionUsage: sessionUsageLocked(sessionUsage, records),
    });
  const projectionRef = yield* SubscriptionRef.make(frozenProjection(0));
  const runtimeNamespace = allocateRuntimeNamespace();
  let closed = false;
  const questionnaires = questionnaireLifetimes(() => closed);
  const withLock: WithRunLock = lock.withPermits(1);
  const withCompletionGate = completionGate.withPermits(1);
  const { admitTurnInput, releaseTurnInput, claimTurnInputDrain } = turnInputGates(withLock);
  const {
    allocateClaimToken,
    allocateAssignmentAttemptToken,
    allocateMessageId,
    allocateRunIdentity,
  } = identityAllocators(runtimeNamespace);
  const publish = Effect.uninterruptible(
    Effect.sync(() => {
      for (const record of records.values()) {
        const quarantined = record.writerPool?.cleanupQuarantined ? true : undefined;
        if (record.view.writerCleanupQuarantined !== quarantined)
          record.view = { ...record.view, writerCleanupQuarantined: quarantined };
      }
    }).pipe(
      Effect.andThen(questionnaires.invalidate),
      Effect.andThen(
        Effect.suspend(() =>
          closed
            ? Effect.void
            : SubscriptionRef.updateAndGet(projectionRef, (current) =>
                frozenProjection(current.revision + 1),
              ).pipe(
                Effect.flatMap((projection) =>
                  Effect.sync(() =>
                    invokeHostCallback(() => options.publish?.(projection), undefined),
                  ),
                ),
                Effect.andThen(recordSessionUsage(false)),
              ),
        ),
      ),
    ),
  );
  // A direct subscription, not `SubscriptionRef.changes`: that stream turns an interrupted pull into
  // its end, so a cancelled await would surface a stream completion instead of its interruption.
  const waitForRevision = (after: number): Effect.Effect<void, SubagentRuntimeClosedError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(projectionRef.pubsub);
        while ((yield* PubSub.take(subscription)).revision <= after) {}
      }),
    ).pipe(
      Effect.catchCauseIf(
        (cause) => closed && Cause.hasInterruptsOnly(cause),
        () =>
          Effect.fail(SubagentRuntimeClosedError.make({ message: "Parent session shut down." })),
      ),
    );
  const requireRecord = (id: string): Effect.Effect<RunRecord, SubagentNotFoundError> =>
    Effect.suspend(() => {
      const record = records.get(id);
      return record ? Effect.succeed(record) : Effect.fail(runNotFound(id));
    });
  const runContext: RunContext = {
    ownerScope,
    withLock,
    publish,
    records,
    writerPools,
    writerLeases,
    requireRecord,
    sendPeerNotices: peerNotifier(records),
    allocateAssignmentAttemptToken,
    sessionUsage,
  };
  const workspaces = yield* workspaceControl({
    ...runContext,
    engine: Option.getOrUndefined(workspaceEngine),
    initialMode: options.writerWorkspaceMode ?? initialProfiles.effectiveConfig.writerWorkspaceMode,
    worktreeCreate: options.worktreeCreate ?? [],
    ownerId: options.workspaceOwnerId ?? runtimeNamespace,
    ...(options.workspaceSourceCwd && { sourceCwd: options.workspaceSourceCwd }),
    isClosed: () => closed,
  });

  const delivery = yield* notificationDelivery({
    ...runContext,
    withCompletionGate,
    notify: notificationRouter({
      ...runContext,
      admitTurnInput,
      releaseTurnInput,
      notifyHost: (notification) => options.notify?.(notification),
    }),
  });
  const observations = completionObservationOperations({
    ...runContext,
    withCompletionGate,
    currentProjection: () => SubscriptionRef.getUnsafe(projectionRef),
    waitForRevision,
    allocateClaimToken,
    delivery,
  });

  const prepareWriterLeaseForSpawn = writerSpawnPreparation(runContext);
  const ownedCleanup = recordCleanup(runContext);
  const cleanup: RunRecordCleanup = {
    ...ownedCleanup,
    closeRecordScope: (record, scope) =>
      questionnaires
        .drain(record)
        .pipe(Effect.andThen(ownedCleanup.closeRecordScope(record, scope))),
  };
  const { closeRecordScope } = cleanup;

  const settlement = settlementOperations({
    ...runContext,
    delivery,
    closeRecordScope,
    claimTurnInputDrain,
    settleCompletedWorkspace: workspaces.settleCompletedWorkspace,
    archiveReport: options.archiveReport,
  });

  const processControls = processControlOperations(withLock);

  const assignment = assignmentOperations({
    ...runContext,
    startPrompt: processControls.startPrompt,
    activateAssignmentLocked: settlement.activateAssignmentLocked,
    replayAssignmentActivation: settlement.replayAssignmentActivation,
  });

  const controls = controlOperations({
    ...runContext,
    processControls,
    admitTurnInput,
    releaseTurnInput,
    claimTurnInputDrain,
    closeRecordScope,
    verifyCleanup: cleanup.verifyCleanup,
    settle: settlement.settle,
  });

  const stop = subtreeStopper({ ...runContext, stopRun: controls.stop });

  const { proxyHandler, questionnaireHandler } = options;
  const handleProxyEvent = proxyExecutionHandler({
    ownerScope,
    executions: proxyRuns,
    ...(proxyHandler && {
      executeProxy: (callerRunId, request) =>
        proxyHandler(service, callerRunId, request).pipe(
          Effect.provideService(SubagentProfileService, profileService),
          Effect.provideService(SubagentBackendRegistry, backendRegistry),
        ),
    }),
    ...(questionnaireHandler && {
      executeQuestionnaire: (record, requestId, request) =>
        questionnaires.own(record, requestId, (owner) => questionnaireHandler(request, owner)),
    }),
  });

  const handleWireEvent = backendEventHandler({
    settlement,
    queueQuestionLocked: delivery.queueActionNotificationLocked,
    onProxyEvent: handleProxyEvent,
  });

  const initializeProcess = processInitializer({
    ...runContext,
    initialize: processControls.initialize,
    handleBackendEvent: handleWireEvent,
    prepareBackendSpawn: prepareWriterLeaseForSpawn,
    markCleanupPending: cleanup.markCleanupPending,
    closeExitedScope: cleanup.closeExitedScope,
    failRun: settlement.failRun,
    // Bound to the spawned run, so a child's channel can never name another caller.
    agentMessagingFor: (runId, cwd) => {
      const caller = { kind: "run", runId } as const;
      return {
        caller,
        cwd,
        list: (ids) => Effect.suspend(() => agentMessages.list(caller, ids)),
        send: (to, message) => Effect.suspend(() => agentMessages.send(caller, to, message)),
        read: (ids) => Effect.suspend(() => agentMessages.read(caller, ids)),
      };
    },
  });

  const currentSpendLimit = profileService.capture.pipe(
    Effect.map((snapshot) => snapshot.effectiveConfig.sessionSpendLimit),
  );
  const launch = launchOperations({
    ...runContext,
    backendRegistry,
    records,
    delivery,
    isClosed: () => closed,
    allocateRunIdentity,
    cleanup,
    settle: settlement.settle,
    submitPrompt: assignment.submitPrompt,
    initializeProcess,
    workspaces,
    currentSpendLimit,
  });

  const rootNesting = profileService.capture.pipe(
    Effect.map((snapshot) => snapshot.effectiveConfig.nesting),
  );
  const resume = resumeOperations({
    ...runContext,
    delivery,
    initializeProcess,
    assignment,
    settlement,
    closeRecordScope,
    workspaces,
    currentNesting: rootNesting,
    currentSpendLimit,
  });

  const projection = SubscriptionRef.get(projectionRef);
  const revision = projection.pipe(Effect.map((current) => current.revision));

  const agentMessages = agentMessageOperations({
    ...runContext,
    main: options.agentMain,
    deliverToRun: controls.deliver,
    resume: (id, agentMessage) => resume.resume(id, undefined, undefined, agentMessage),
    allocateMessageId,
    revision,
    waitForRevision,
  });

  const starts = sessionStartOperations({
    ...runContext,
    launch,
    workspaces,
    redactCompletionReport: observations.redactCompletionReport,
  });

  const service: SubagentServiceContract = {
    ...observations,
    start: Effect.fn("SubagentService.start")(starts.start),
    startSessionOwned: Effect.fn("SubagentService.startSessionOwned")(starts.startSessionOwned),
    startScriptSessionOwned: Effect.fn("SubagentService.startScriptSessionOwned")(
      starts.startScriptSessionOwned,
    ),
    workspaceList: Effect.fn("SubagentService.workspaceList")(workspaces.workspaceList),
    workspaceReview: Effect.fn("SubagentService.workspaceReview")(workspaces.workspaceReview),
    workspacePrepare: Effect.fn("SubagentService.workspacePrepare")(workspaces.workspacePrepare),
    workspaceDiscard: Effect.fn("SubagentService.workspaceDiscard")(workspaces.workspaceDiscard),
    workspaceApply: Effect.fn("SubagentService.workspaceApply")(workspaces.workspaceApply),
    workspaceRevise: Effect.fn("SubagentService.workspaceRevise")(workspaces.revise(launch.start)),
    inspectWriterWorkspace: workspaces.inspectWriterWorkspace,
    sweepOrphanedWorkspaces: workspaces.sweepOrphanedWorkspaces,
    setWriterWorkspaceMode: workspaces.setWriterWorkspaceMode,
    startSessionOwnedFrom: Effect.fn("SubagentService.startSessionOwnedFrom")(
      starts.startSessionOwnedFrom,
    ),
    captureLaunchParent: starts.captureLaunchParent,
    ...visibilityOperations(runContext),
    send: Effect.fn("SubagentService.send")(agentMessages.sendFromUser),
    interrupt: Effect.fn("SubagentService.interrupt")(controls.interrupt),
    resume: Effect.fn("SubagentService.resume")(resume.resume),
    rename: Effect.fn("SubagentService.rename")(controls.rename),
    stop: Effect.fn("SubagentService.stop")(stop),
    agentList: Effect.fn("SubagentService.agentList")(agentMessages.list),
    agentSend: Effect.fn("SubagentService.agentSend")(agentMessages.send),
    agentRead: Effect.fn("SubagentService.agentRead")(agentMessages.read),
    projection,
    deliverPendingCompletions: delivery.deliverPendingCompletions,
    awaitParentDrain: parentDrainAwaiter({
      records,
      withLock,
      revision,
      waitForRevision,
      outboxChangedLocked: delivery.outboxChangedLocked,
    }),
  };

  yield* Effect.addFinalizer(() =>
    withLock(
      Effect.sync(() => {
        closed = true;
      }),
    ).pipe(
      Effect.andThen(questionnaires.invalidate),
      Effect.andThen(Scope.close(ownerScope, Exit.void)),
      Effect.andThen(closeRunsLeafFirst({ records, withLock, cleanup })),
      Effect.andThen(withLock(recordSessionUsage(true))),
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
