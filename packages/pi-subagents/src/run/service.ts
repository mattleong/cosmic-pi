import { hasObjectRuntimeType } from "pi-cosmic-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { BackendStartupState } from "../backend/model.ts";
import { SubagentBackendRegistry } from "../backend/service.ts";
import type {
  SubagentNotification,
  SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import { WriterLeaseService } from "../boundary/writer-lease.ts";
import {
  type InvalidSubagentRequestError,
  type SubagentError,
  SubagentNotFoundError,
  SubagentRuntimeClosedError,
  UnsupportedSubagentCapabilityError,
} from "./errors.ts";
import { makeRunAssignment } from "./assignment.ts";
import { makeRunCompletionObservations } from "./completion-observations.ts";
import { makeRunControls } from "./control.ts";
import { makeRunEventHandler } from "./events.ts";
import { makeRunLaunch } from "./launch.ts";
import type { RunRecord } from "./internal.ts";
import { makeRunNotificationDelivery } from "./notification-delivery.ts";
import { makeRunProcessLifecycle } from "./process-lifecycle.ts";
import { makeRunRecordCleanup } from "./record-cleanup.ts";
import { makeRunResume } from "./resume.ts";
import { makeRunRetry, type SubagentRetryClaim } from "./retry.ts";
import { makeRunReportLifecycle } from "./report-lifecycle.ts";
import { makeRunSettlement } from "./settlement.ts";
import {
  hasSubagentCapability,
  type StartSubagentRequest,
  type SubagentCapability,
  type SubagentRetrySupersession,
  type SubagentProjection,
  type SubagentRunView,
} from "./model.ts";
import { sortRuns } from "./projection.ts";
import { snapshotView } from "./state.ts";

let nextRuntimeNamespace = 1;
const allocateRuntimeNamespace = (): string => `r${(nextRuntimeNamespace++).toString(36)}`;

export type SubagentNotificationCallback =
  | ((notification: SubagentNotification) => SubagentNotificationDelivery | undefined)
  | ((notification: SubagentNotification) => void);

export interface SubagentServiceOptions {
  readonly publish?: (projection: SubagentProjection) => void;
  readonly notify?: SubagentNotificationCallback;
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
}

export interface SubagentStatusObservations {
  readonly observations: ReadonlyArray<SubagentRunObservation>;
  readonly missingIds: ReadonlyArray<string>;
}

export interface SubagentServiceContract {
  readonly start: (request: StartSubagentRequest) => Effect.Effect<SubagentRunView, SubagentError>;
  /** Submit one launch to the session owner; cancelling the waiter never abandons ownership. */
  readonly startSessionOwned: (
    request: StartSubagentRequest,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
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
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly awaitTerminal: (
    ids: ReadonlyArray<string>,
    until: SubagentAwaitUntil,
    onUpdate?: (runs: ReadonlyArray<SubagentRunView>) => void,
  ) => Effect.Effect<ReadonlyArray<SubagentRunView>, SubagentError>;
  readonly withAwaitTerminalObservations: <A, E, R>(
    ids: ReadonlyArray<string>,
    until: SubagentAwaitUntil,
    onUpdate: ((runs: ReadonlyArray<SubagentRunView>) => void) | undefined,
    use: (observations: ReadonlyArray<SubagentRunObservation>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, SubagentError | E, R>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentRunView>>;
  readonly status: (id: string) => Effect.Effect<SubagentRunView, SubagentNotFoundError>;
  readonly withStatusObservations: <A, E, R>(
    ids: ReadonlyArray<string>,
    use: (selection: SubagentStatusObservations) => Effect.Effect<A, E, R>,
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
  readonly projection: Effect.Effect<SubagentProjection>;
}

const notFound = (id: string) =>
  new SubagentNotFoundError({ id, message: `Subagent run not found: ${id}` });
const unsupportedCapabilityMessage = (
  backend: string,
  capability: SubagentCapability,
  id: string,
): string => {
  switch (capability) {
    case "steer":
      return `${backend} subagents do not support mid-turn guidance. Await with subagent_await({ runIds: ["${id}"], until: "all_finished" }), inspect with subagent_status({ runIds: ["${id}"] }), or stop with subagent_lifecycle({ action: "stop", runIds: ["${id}"] }).`;
    case "interrupt":
      return `${backend} subagents do not support interruption. Stop with subagent_lifecycle({ action: "stop", runIds: ["${id}"] }) or wait with subagent_await.`;
    case "parent-contact":
      return `${backend} subagents do not support parent questions or subagent_reply; use subagent_await or subagent_status instead.`;
    default:
      return `${backend} subagents do not support ${capability}. Inspect supported operations with subagent_status({ runIds: ["${id}"] }).`;
  }
};

const requireCapability = (
  record: RunRecord,
  capability: SubagentCapability,
): Effect.Effect<void, UnsupportedSubagentCapabilityError> =>
  hasSubagentCapability(record.view, capability)
    ? Effect.void
    : Effect.fail(
        new UnsupportedSubagentCapabilityError({
          backend: `${record.view.host}/${record.view.runtime}`,
          capability,
          message: unsupportedCapabilityMessage(
            `${record.view.host}/${record.view.runtime}`,
            capability,
            record.view.id,
          ),
        }),
      );

const makeService = Effect.fn("SubagentService.make")(function* (options: SubagentServiceOptions) {
  const backendRegistry = yield* SubagentBackendRegistry;
  const writerLeases = yield* WriterLeaseService;
  const ownerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const completionGate = yield* Semaphore.make(1);
  const records = new Map<string, RunRecord>();
  const initialProjection: SubagentProjection = Object.freeze({
    revision: 0,
    runs: Object.freeze([]),
  });
  const projectionRef = yield* SubscriptionRef.make(initialProjection);
  const runtimeNamespace = allocateRuntimeNamespace();
  let nextRunOrdinal = 1;
  let nextClaimOrdinal = 1;
  let nextRetryClaimOrdinal = 1;
  let nextAssignmentAttemptOrdinal = 1;
  let closed = false;

  const withLock = lock.withPermits(1);
  const withCompletionGate = completionGate.withPermits(1);
  const allocateClaimToken = (): string => `completion-${runtimeNamespace}-${nextClaimOrdinal++}`;
  const allocateRetryClaimToken = (): string =>
    `retry-${runtimeNamespace}-${nextRetryClaimOrdinal++}`;
  const allocateAssignmentAttemptToken = (): string =>
    `assignment-${runtimeNamespace}-${nextAssignmentAttemptOrdinal++}`;
  const allocateRunIdentity = (requestedName: string) => {
    const ordinal = nextRunOrdinal++;
    return {
      id: `agent-${runtimeNamespace}-${ordinal}`,
      name: requestedName || `subagent-${ordinal}`,
    };
  };
  // Each run view is already deeply frozen by snapshotView, so only the fresh
  // top-level container and array need freezing before publication.
  const frozenProjection = (revision: number): SubagentProjection =>
    Object.freeze({
      revision,
      runs: Object.freeze(
        sortRuns([...records.values()].map((record) => snapshotView(record.view))),
      ),
    });
  const publish = Effect.uninterruptible(
    Effect.suspend(() => {
      const projection = frozenProjection(SubscriptionRef.getUnsafe(projectionRef).revision + 1);
      return SubscriptionRef.set(projectionRef, projection).pipe(
        Effect.andThen(
          options.publish
            ? Effect.try(() => options.publish?.(projection)).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
    }),
  );
  const waitForRevision = (after: number): Effect.Effect<void, SubagentRuntimeClosedError> =>
    SubscriptionRef.changes(projectionRef).pipe(
      Stream.dropWhile((current) => current.revision <= after),
      Stream.runHead,
      Effect.flatMap((next) =>
        Option.isSome(next)
          ? Effect.void
          : Effect.fail(new SubagentRuntimeClosedError({ message: "Parent session shut down." })),
      ),
    );
  const notify = (notification: SubagentNotification): SubagentNotificationDelivery | undefined => {
    try {
      const delivery = options.notify?.(notification);
      return hasObjectRuntimeType(delivery) && delivery !== null ? delivery : undefined;
    } catch {
      // Host transcript delivery is acknowledged only when the boundary returned normally.
      return notification.type === "completed"
        ? { deliveredCompletionKeys: [] }
        : { actionAccepted: false };
    }
  };
  const requireRecord = (id: string): Effect.Effect<RunRecord, SubagentNotFoundError> =>
    Effect.suspend(() => {
      const record = records.get(id);
      return record ? Effect.succeed(record) : Effect.fail(notFound(id));
    });

  const delivery = yield* makeRunNotificationDelivery({
    ownerScope,
    records,
    withLock,
    withCompletionGate,
    notify,
  });
  const observations = makeRunCompletionObservations({
    records,
    withLock,
    withCompletionGate,
    currentProjection: () => SubscriptionRef.getUnsafe(projectionRef),
    waitForRevision,
    allocateClaimToken,
    delivery,
  });

  const retry = makeRunRetry({
    records,
    withLock,
    publish,
    allocateClaimToken: allocateRetryClaimToken,
  });

  const {
    prepareWriterLeaseForSpawn,
    reclaimRecordRunState,
    markCleanupPending,
    retainCleanupQuarantine,
    closeRecordScope,
    closeExitedScope,
  } = makeRunRecordCleanup({ withLock, publish, writerLeases });

  let sendPeerNotices: (changedId: string) => Effect.Effect<void>;
  let initializeProcess: (record: RunRecord) => Effect.Effect<BackendStartupState, SubagentError>;
  let startPrompt: (
    record: RunRecord,
    message: string,
    assignmentEpoch: number,
  ) => Effect.Effect<void, SubagentError>;
  let steerBackend: (record: RunRecord, message: string) => Effect.Effect<void, SubagentError>;
  let interruptBackend: (record: RunRecord) => Effect.Effect<void, SubagentError>;
  let renameBackend: (record: RunRecord, name: string) => Effect.Effect<void, SubagentError>;

  const { mutateEventView, mergeLateUsage, pauseFromEvent, failPendingResponses, settle, failRun } =
    makeRunSettlement({
      ownerScope,
      withLock,
      publish,
      delivery,
      closeRecordScope,
      sendPeerNotices: (changedId) => sendPeerNotices(changedId),
    });

  const {
    commitRetainedReportLocked,
    finishRetainedReport,
    acceptBackendReport,
    runStartedFromBackend,
    runSettledFromBackend,
  } = makeRunReportLifecycle({
    withLock,
    publish,
    delivery,
    settle,
    pauseFromEvent,
    sendPeerNotices: (changedId) => sendPeerNotices(changedId),
  });

  const handleWireEvent = makeRunEventHandler({
    mutateView: mutateEventView,
    mergeLateUsage,
    runStarted: runStartedFromBackend,
    runSettled: runSettledFromBackend,
    settle,
    acceptReport: acceptBackendReport,
    notify: delivery.queueActionNotification,
    failRun,
  });

  ({
    sendPeerNotices,
    initializeProcess,
    startPrompt,
    steer: steerBackend,
    interrupt: interruptBackend,
    renameDisplay: renameBackend,
  } = makeRunProcessLifecycle({
    ownerScope,
    records,
    withLock,
    publish,
    handleBackendEvent: handleWireEvent,
    prepareBackendSpawn: prepareWriterLeaseForSpawn,
    markCleanupPending,
    closeExitedScope,
    failRun,
  }));

  const { submitPrompt, retainUncertainAssignment } = makeRunAssignment({
    withLock,
    publish,
    startPrompt: (record, message, assignmentEpoch) =>
      startPrompt(record, message, assignmentEpoch),
    settle,
    commitRetainedReportLocked,
    finishRetainedReport,
    acceptBackendReport,
  });

  const { start, startSessionOwned } = makeRunLaunch({
    ownerScope,
    backendRegistry,
    writerLeases,
    records,
    withLock,
    publish,
    delivery,
    redactCompletionReport: observations.redactCompletionReport,
    isClosed: () => closed,
    allocateRunIdentity,
    allocateAssignmentAttemptToken,
    reclaimRecordRunState,
    quarantineReclaimFailure: (record) => retainCleanupQuarantine(record, record.scope),
    markCleanupPending,
    closeRecordScope,
    settle,
    failRun,
    submitPrompt,
    initializeProcess: (record) => initializeProcess(record),
    sendPeerNotices: (changedId) => sendPeerNotices(changedId),
  });

  const startRetrySessionOwned: SubagentServiceContract["startRetrySessionOwned"] = (request) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const fiber = yield* start(request).pipe(
          Effect.ensuring(
            retry.releaseRetryClaim(request.supersedes.runId, request.supersedes.claimToken),
          ),
          Effect.forkIn(ownerScope, { startImmediately: true }),
        );
        return observations.redactCompletionReport(yield* restore(Fiber.join(fiber)));
      }),
    );

  const list = SubscriptionRef.get(projectionRef).pipe(Effect.map((current) => current.runs));
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

  const { resume } = makeRunResume({
    ownerScope,
    records,
    withLock,
    publish,
    writerLeases,
    delivery,
    requireRecord,
    requireCapability,
    allocateAssignmentAttemptToken,
    initializeProcess: (record) => initializeProcess(record),
    submitPrompt,
    settle,
    failRun,
    closeRecordScope,
    retainUncertainAssignment,
    sendPeerNotices: (changedId) => sendPeerNotices(changedId),
  });

  const { send, reply, interrupt, rename, stop } = makeRunControls({
    ownerScope,
    withLock,
    requireRecord,
    requireCapability,
    steerBackend,
    beginAssignmentBackend: (record, message, attemptToken) =>
      submitPrompt(record, message, "resume", attemptToken),
    allocateAssignmentAttemptToken,
    retainUncertainAssignment,
    interruptBackend,
    renameBackend,
    publish,
    sendPeerNotices,
    failPendingResponses,
    closeRecordScope,
    settle,
  });

  const projection = SubscriptionRef.get(projectionRef);

  const service: SubagentServiceContract = {
    start,
    startSessionOwned,
    claimRetryContinuation: retry.claimRetryContinuation,
    releaseRetryClaim: retry.releaseRetryClaim,
    exhaustRetryClaim: retry.exhaustRetryClaim,
    blockRetryClaim: retry.blockRetryClaim,
    startRetrySessionOwned,
    awaitTerminal: observations.awaitTerminal,
    withAwaitTerminalObservations: observations.withAwaitTerminalObservations,
    list,
    status,
    withStatusObservations: observations.withStatusObservations,
    consumeCompletions: observations.consumeCompletions,
    send,
    reply,
    interrupt,
    resume,
    rename,
    stop,
    projection,
  };

  yield* Effect.addFinalizer(() =>
    withLock(
      Effect.sync(() => {
        closed = true;
      }),
    ).pipe(
      Effect.andThen(
        Effect.forEach(
          [...records.values()],
          (record) => {
            record.stoppedByParent = true;
            failPendingResponses(
              record,
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
          { concurrency: 8, discard: true },
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
