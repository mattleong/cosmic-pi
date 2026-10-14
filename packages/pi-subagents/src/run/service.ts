import type { AskUserRequest, QuestionnaireOwner } from "pi-ask-user/protocol";
import { makeQuestionnaireLifetimes } from "./questionnaire-lifetime.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
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
  type InvalidSubagentRequestError,
  runNotFound,
  type SubagentError,
  type SubagentNotFoundError,
  SubagentRuntimeClosedError,
} from "./errors.ts";
import { makeRunAssignment } from "./assignment.ts";
import { makeRunCompletionObservations } from "./completion-observations.ts";
import { makeRunPeerNotifier } from "./coordination.ts";
import { makeRunControls } from "./control.ts";
import { makeRunEventHandler } from "./events.ts";
import { makeRunLaunch } from "./launch.ts";
import type { RunContext, RunRecord, WithRunLock } from "./internal.ts";
import {
  makeRunNotificationDelivery,
  type QuestionNotificationReceipt,
} from "./notification-delivery.ts";
import { makeRunProcessControls, makeRunProcessInitializer } from "./process-lifecycle.ts";
import { makeRunRecordCleanup, type RunRecordCleanup } from "./record-cleanup.ts";
import { makeRunResume } from "./resume.ts";
import { makeRunRetry, type SubagentRetryClaim } from "./retry.ts";
import { makeRunSettlement } from "./settlement.ts";
import {
  type FailedStartRecovery,
  type StartSubagentRequest,
  type SubagentRetrySupersession,
  type SubagentProjection,
  type SubagentRunView,
  type SubagentControlExpectation,
} from "./model.ts";
import { sortRuns } from "./projection.ts";
import { closeRunsLeafFirst } from "./shutdown.ts";
import { projectRunTree } from "./tree.ts";
import { allocateRuntimeNamespace, makeRunIdentities } from "./identity.ts";
import { makeRunNotificationRouting } from "./notification-routing.ts";
import { makeParentDrain } from "./parent-drain.ts";
import { makeRunSessionStarts } from "./session-starts.ts";
import { makeRunSubtreeStop } from "./subtree-stop.ts";
import { makeRunTurnInputs } from "./turn-input.ts";
import { makeRunVisibility } from "./visibility.ts";
import { makeRunWriteClaimContainment } from "./write-claim-containment.ts";
import { makeRunProxyExecution } from "./proxy-execution.ts";
import { makeWriterPreparation } from "./writer-preparation.ts";
import { WriterPools } from "./writer-pool.ts";
import { makeRunWriteClaimControl } from "./write-claim-control.ts";
import { makeWorkspaceControl, type WorkspaceCoordinatorContract } from "./workspace-control.ts";
import { WorkspaceService } from "../workspace/service.ts";
import type { WriterWorkspaceMode } from "../config/schema.ts";

export interface SubagentServiceOptions {
  readonly writerWorkspaceMode?: WriterWorkspaceMode;
  readonly workspaceOwnerId?: string;
  readonly workspaceSourceCwd?: string;
  readonly publish?: (projection: SubagentProjection) => void;
  readonly notify?: (
    notification: SubagentNotification,
  ) => SubagentNotificationDelivery | undefined | void;
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
  readonly claimToken: string;
}

export interface SubagentRunObservation {
  readonly run: SubagentRunView;
  readonly completionReceipt?: SubagentCompletionReceipt | undefined;
  readonly questionReceipt?: QuestionNotificationReceipt | undefined;
  readonly recovery?: FailedStartRecovery | undefined;
}

export interface SubagentStatusObservations {
  readonly observations: ReadonlyArray<SubagentRunObservation>;
  readonly missingIds: ReadonlyArray<string>;
}

export interface SubagentStatusObservationOptions {
  readonly includeDeliveredReports?: boolean | undefined;
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
  readonly startRetrySessionOwned: (
    request: StartSubagentRequest & { readonly supersedes: SubagentRetrySupersession },
    onOwned?: () => void,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
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
  readonly send: (
    id: string,
    message: string,
    expected?: SubagentControlExpectation,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly reply: (
    id: string,
    message: string,
    expected?: SubagentControlExpectation,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
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
  /** Resolves when headless parent work has drained; see `makeParentDrain`. */
  readonly awaitParentDrain: Effect.Effect<void, SubagentRuntimeClosedError>;
}

const makeService = Effect.fn("SubagentService.make")(function* (options: SubagentServiceOptions) {
  const backendRegistry = yield* SubagentBackendRegistry;
  const profileService = yield* SubagentProfileService;
  const writerLeases = yield* WriterLeaseService;
  const workspaceEngine = yield* Effect.serviceOption(WorkspaceService);
  const initialProfiles = yield* profileService.capture;
  const ownerScope = yield* Effect.scope;
  const proxyRuns = yield* FiberMap.make<string, void, never>();
  const lock = yield* Semaphore.make(1);
  const completionGate = yield* Semaphore.make(1);
  const records = new Map<string, RunRecord>();
  const writerPools = new WriterPools();
  const frozenProjection = (revision: number): SubagentProjection =>
    Object.freeze({ revision, runs: Object.freeze(sortRuns(projectRunTree(records))) });
  const projectionRef = yield* SubscriptionRef.make(frozenProjection(0));
  const runtimeNamespace = allocateRuntimeNamespace();
  let closed = false;
  const questionnaires = makeQuestionnaireLifetimes(() => closed);
  const withLock: WithRunLock = lock.withPermits(1);
  const withCompletionGate = completionGate.withPermits(1);
  const { admitTurnInput, releaseTurnInput, claimTurnInputDrain } = makeRunTurnInputs(withLock);
  const {
    allocateClaimToken,
    allocateRetryClaimToken,
    allocateAssignmentAttemptToken,
    allocateRunIdentity,
  } = makeRunIdentities(runtimeNamespace);
  const publish = Effect.uninterruptible(
    questionnaires.invalidate.pipe(
      Effect.andThen(
        Effect.suspend(() =>
          closed
            ? Effect.void
            : SubscriptionRef.updateAndGet(projectionRef, (current) =>
                frozenProjection(current.revision + 1),
              ).pipe(
                Effect.flatMap((projection) =>
                  Effect.try(() => options.publish?.(projection)).pipe(Effect.ignore),
                ),
              ),
        ),
      ),
    ),
  );
  const waitForRevision = (after: number): Effect.Effect<void, SubagentRuntimeClosedError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(projectionRef.pubsub);
        while ((yield* PubSub.take(subscription)).revision <= after) {}
      }),
    ).pipe(
      Effect.catchCauseIf(
        (cause) => closed && Cause.hasInterruptsOnly(cause),
        () => Effect.fail(new SubagentRuntimeClosedError({ message: "Parent session shut down." })),
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

  const delivery = yield* makeRunNotificationDelivery({
    ...runContext,
    withCompletionGate,
    notify: makeRunNotificationRouting({
      ...runContext,
      admitTurnInput,
      releaseTurnInput,
      notifyHost: (notification) => options.notify?.(notification),
    }),
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
  const ownedCleanup = makeRunRecordCleanup(runContext);
  const cleanup: RunRecordCleanup = {
    ...ownedCleanup,
    closeRecordScope: (record, scope) =>
      questionnaires
        .drain(record)
        .pipe(Effect.andThen(ownedCleanup.closeRecordScope(record, scope))),
  };
  const { closeRecordScope } = cleanup;

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
    processControls,
    admitTurnInput,
    releaseTurnInput,
    claimTurnInputDrain,
    closeRecordScope,
    settle: settlement.settle,
  });

  const stop = makeRunSubtreeStop({ ...runContext, stopRun: controls.stop });
  const containWriteClaimViolation = makeRunWriteClaimContainment({
    ...runContext,
    stop,
    interrupt: controls.interrupt,
  });

  const { proxyHandler, questionnaireHandler } = options;
  const handleProxyEvent = makeRunProxyExecution({
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

  const handleWireEvent = makeRunEventHandler({
    settlement,
    queueQuestionLocked: delivery.queueActionNotificationLocked,
    onWriteClaimViolation: containWriteClaimViolation,
    onProxyEvent: handleProxyEvent,
  });

  const initializeProcess = makeRunProcessInitializer({
    ...runContext,
    initialize: processControls.initialize,
    handleBackendEvent: handleWireEvent,
    prepareBackendSpawn: prepareWriterLeaseForSpawn,
    markCleanupPending: cleanup.markCleanupPending,
    closeExitedScope: cleanup.closeExitedScope,
    failRun: settlement.failRun,
  });

  const launch = makeRunLaunch({
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
  });

  const rootChildLimit = profileService.capture.pipe(
    Effect.map((snapshot) => snapshot.effectiveConfig.nesting.maxDirectChildren),
  );
  const resume = makeRunResume({
    ...runContext,
    delivery,
    initializeProcess,
    assignment,
    settlement,
    closeRecordScope,
    workspaces,
    currentChildLimit: rootChildLimit,
  });

  const writeClaims = makeRunWriteClaimControl(runContext);

  const starts = makeRunSessionStarts({
    ...runContext,
    launch,
    workspaces,
    redactCompletionReport: observations.redactCompletionReport,
    releaseRetryClaim: retry.releaseRetryClaim,
  });
  const list = SubscriptionRef.get(projectionRef).pipe(Effect.map((current) => current.runs));
  const status: SubagentServiceContract["status"] = (id) =>
    observations
      .withStatusObservations([id], ({ observations: selected }) => {
        const observation = selected[0];
        if (!observation) return Effect.fail(runNotFound(id));
        return (
          observation.completionReceipt
            ? observations.consumeCompletions([observation.completionReceipt])
            : Effect.void
        ).pipe(Effect.as(observation.run));
      })
      .pipe(Effect.catchTag("InvalidSubagentRequestError", () => Effect.fail(runNotFound(id))));

  const projection = SubscriptionRef.get(projectionRef);

  const service: SubagentServiceContract = {
    ...retry,
    ...observations,
    start: starts.start,
    startSessionOwned: starts.startSessionOwned,
    startScriptSessionOwned: starts.startScriptSessionOwned,
    workspaceList: workspaces.workspaceList,
    workspaceReview: workspaces.workspaceReview,
    workspacePrepare: workspaces.workspacePrepare,
    workspaceIntegrate: workspaces.workspaceIntegrate,
    workspaceDiscard: workspaces.workspaceDiscard,
    workspaceRevise: workspaces.revise(launch.start),
    inspectWriterWorkspace: workspaces.inspectWriterWorkspace,
    setWriterWorkspaceMode: workspaces.setWriterWorkspaceMode,
    startSessionOwnedFrom: starts.startSessionOwnedFrom,
    ...makeRunVisibility(runContext),
    startRetrySessionOwned: starts.startRetrySessionOwned,
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
    awaitParentDrain: makeParentDrain({
      records,
      withLock,
      revision: projection.pipe(Effect.map(({ revision }) => revision)),
      waitForRevision,
    }),
  };

  yield* Effect.addFinalizer(() =>
    withLock(
      Effect.sync(() => {
        closed = true;
      }),
    ).pipe(
      Effect.andThen(questionnaires.invalidate),
      Effect.andThen(closeRunsLeafFirst({ records, withLock, cleanup })),
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
