import { hasObjectRuntimeType } from "pi-cosmic-core";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
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
  isOutcomeUncertain,
  type SubagentError,
  SubagentNotFoundError,
  SubagentRuntimeClosedError,
  UnsupportedSubagentCapabilityError,
  subagentErrorCode,
} from "./errors.ts";
import { makeRunAssignment } from "./assignment.ts";
import { makeRunCompletionObservations } from "./completion-observations.ts";
import { makeRunPeerNotifier } from "./coordination.ts";
import { makeRunControls } from "./control.ts";
import { makeRunEventHandler } from "./events.ts";
import { makeRunLaunch } from "./launch.ts";
import type { RunRecord } from "./internal.ts";
import { makeRunNotificationDelivery } from "./notification-delivery.ts";
import { makeRunProcessControls, makeRunProcessInitializer } from "./process-lifecycle.ts";
import { makeRunRecordCleanup } from "./record-cleanup.ts";
import { makeRunResume } from "./resume.ts";
import { makeRunRetry, type SubagentRetryClaim } from "./retry.ts";
import { makeRunSettlement } from "./settlement.ts";
import {
  hasSubagentCapability,
  isActiveRunState,
  SUBAGENT_ROOT_RUN_ID,
  type StartSubagentRequest,
  type SubagentCapability,
  type SubagentRetrySupersession,
  type SubagentProjection,
  type SubagentRunView,
} from "./model.ts";
import { emptyProjection, sortRuns } from "./projection.ts";
import { sanitizeOutputText, snapshotView } from "./state.ts";
import { runSessionOwned } from "./session-owned.ts";
import { descendantRunIds, isRunInSubtree, leafFirst, projectRunTree } from "./tree.ts";
import { encodeSubagentProxyPayload } from "../tools/proxy-protocol.ts";
import type { WriterPoolEntry } from "./writer-pool.ts";
import { makeRunWriteClaimControl } from "./write-claim-control.ts";

let nextRuntimeNamespace = 1;
const allocateRuntimeNamespace = (): string => `r${(nextRuntimeNamespace++).toString(36)}`;

export type SubagentNotificationCallback =
  | ((notification: SubagentNotification) => SubagentNotificationDelivery | undefined)
  | ((notification: SubagentNotification) => void);

export interface SubagentServiceOptions {
  readonly publish?: (projection: SubagentProjection) => void;
  readonly notify?: SubagentNotificationCallback;
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
  const profileService = yield* SubagentProfileService;
  const writerLeases = yield* WriterLeaseService;
  const ownerScope = yield* Effect.scope;
  // Keyed parent-proxy executions for the `${runId}:${requestId}` identity. Effect rc.111
  // FiberMap.make registers one acquireRelease finalizer on the service scope that marks the
  // map Closed and then interrupts every managed fiber; because it is acquired before the
  // leaf-first shutdown finalizer below, LIFO finalizer order runs that shutdown first and
  // interrupts surviving proxy executions only afterwards.
  const proxyRuns = yield* FiberMap.make<string, void, never>();
  const lock = yield* Semaphore.make(1);
  const completionGate = yield* Semaphore.make(1);
  const records = new Map<string, RunRecord>();
  const writerPools = new Map<string, WriterPoolEntry>();
  const initial = emptyProjection();
  const initialProjection: SubagentProjection = Object.freeze({
    revision: initial.revision,
    root: Object.freeze(initial.root),
    runs: Object.freeze(initial.runs),
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
  const allocateRunIdentity = (requestedName: string) => {
    const ordinal = nextRunOrdinal++;
    return {
      id: `agent-${runtimeNamespace}-${ordinal}`,
      name: requestedName || `subagent-${ordinal}`,
    };
  };
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
  const publish = Effect.uninterruptible(
    SubscriptionRef.updateAndGet(projectionRef, (current) =>
      frozenProjection(current.revision + 1),
    ).pipe(
      Effect.flatMap((projection) =>
        options.publish
          ? Effect.try(() => options.publish?.(projection)).pipe(Effect.ignore)
          : Effect.void,
      ),
    ),
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
  const deliverToNearestAncestor = (sourceRunId: string, message: string): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      let parentRunId = records.get(sourceRunId)?.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
      const candidates: RunRecord[] = [];
      const visited = new Set<string>();
      while (parentRunId !== SUBAGENT_ROOT_RUN_ID && visited.add(parentRunId)) {
        const parent = records.get(parentRunId);
        if (!parent) break;
        if (
          parent.view.runtime === "pi" &&
          isActiveRunState(parent.view.state) &&
          parent.view.state !== "paused" &&
          !parent.pauseRequested &&
          parent.process?.controls.deliverNotification
        )
          candidates.push(parent);
        parentRunId = parent.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
      }
      const attempt = (index: number): Effect.Effect<boolean> => {
        const candidate = candidates[index];
        if (!candidate) return Effect.succeed(false);
        return Effect.acquireUseRelease(
          withLock(
            Effect.sync(() => {
              const current = records.get(candidate.view.id);
              const deliverNotification = current?.process?.controls.deliverNotification;
              if (
                current !== candidate ||
                !deliverNotification ||
                !isActiveRunState(current.view.state) ||
                current.view.state === "paused" ||
                current.pauseRequested
              )
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
              ? Effect.succeed(true)
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
          delivered ? { actionAccepted: true } : notifyRoot(notification),
        ),
      );
    return Effect.forEach(
      notification.runs,
      (run) =>
        deliverToNearestAncestor(run.id, ancestorMessage({ type: "completed", runs: [run] })).pipe(
          Effect.map((delivered) => {
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
  } = makeRunRecordCleanup({ withLock, publish, writerLeases, writerPools });

  const sendPeerNotices = makeRunPeerNotifier(records);

  const settlement = makeRunSettlement({
    ownerScope,
    withLock,
    publish,
    delivery,
    closeRecordScope,
    sendPeerNotices,
  });

  const processControls = makeRunProcessControls(withLock);

  const assignment = makeRunAssignment({
    withLock,
    publish,
    startPrompt: processControls.startPrompt,
    activateAssignmentLocked: settlement.activateAssignmentLocked,
    replayAssignmentActivation: settlement.replayAssignmentActivation,
  });

  const controls = makeRunControls({
    ownerScope,
    withLock,
    requireRecord,
    requireCapability,
    steerBackend: processControls.steer,
    beginAssignmentBackend: (record, message, attemptToken) =>
      assignment.submitPrompt(record, message, "resume", attemptToken),
    allocateAssignmentAttemptToken,
    retainUncertainAssignment: assignment.retainUncertainAssignment,
    interruptBackend: processControls.interrupt,
    admitTurnInput,
    releaseTurnInput,
    claimTurnInputDrain,
    renameBackend: processControls.renameDisplay,
    publish,
    sendPeerNotices,
    failPendingResponses: settlement.failPendingResponses,
    closeRecordScope,
    settle: settlement.settle,
  });

  const stop: SubagentServiceContract["stop"] = (id) =>
    Effect.gen(function* () {
      const orderedIds = yield* withLock(
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
      );
      // Every target is attempted in order; the first typed failure wins afterwards.
      const [failures, stopped] = yield* Effect.partition(orderedIds, (targetId) =>
        controls.stop(targetId),
      );
      if (failures[0]) return yield* failures[0];
      return stopped.at(-1) ?? snapshotView((yield* requireRecord(id)).view);
    });

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

  const handleProxyEvent = (
    record: RunRecord,
    event: Extract<
      import("../backend/model.ts").BackendEvent,
      { readonly type: "proxy_request" | "proxy_cancel" }
    >,
  ): Effect.Effect<void> => {
    const key = `${record.view.id}:${event.requestId}`;
    if (event.type === "proxy_cancel")
      // Nonblocking: the interrupt of the keyed execution is forked into the owner scope with
      // immediate start so cancel events never wait on the interrupted fiber's finalizers.
      return FiberMap.remove(proxyRuns, key).pipe(
        Effect.forkIn(ownerScope, { startImmediately: true }),
        Effect.asVoid,
      );
    if (
      !options.proxyHandler ||
      record.view.runtime !== "pi" ||
      record.stoppedByParent ||
      !isActiveRunState(record.view.state)
    )
      return event
        .respond(
          false,
          encodeSubagentProxyPayload({
            code: "proxy_caller_disconnected",
            message: "Nested Pi coordinator access is unavailable for this run.",
          }) ?? "{}",
        )
        .pipe(Effect.ignore);
    const runKeyPrefix = `${record.view.id}:`;
    let concurrent = 0;
    for (const [candidateKey] of proxyRuns)
      if (candidateKey.startsWith(runKeyPrefix)) concurrent += 1;
    if (concurrent >= 16)
      return event
        .respond(
          false,
          encodeSubagentProxyPayload({
            code: "proxy_capacity",
            message: "Nested Pi has too many concurrent coordinator calls.",
          }) ?? "{}",
        )
        .pipe(Effect.ignore);
    if (FiberMap.hasUnsafe(proxyRuns, key))
      return event
        .respond(
          false,
          encodeSubagentProxyPayload({
            code: "proxy_request_conflict",
            message: "Nested Pi reused an active coordinator request identity.",
          }) ?? "{}",
        )
        .pipe(Effect.ignore);
    const execute = options.proxyHandler(service, record.view.id, event).pipe(
      Effect.provideService(SubagentProfileService, profileService),
      Effect.provideService(SubagentBackendRegistry, backendRegistry),
      Effect.matchEffect({
        onFailure: (error) =>
          event.respond(
            false,
            encodeSubagentProxyPayload({
              code: subagentErrorCode(error),
              message: error.message,
            }) ?? "{}",
          ),
        onSuccess: (result) =>
          Effect.suspend(() => {
            const payloadJson = encodeSubagentProxyPayload(result);
            return payloadJson
              ? event.respond(true, payloadJson)
              : event.respond(
                  false,
                  encodeSubagentProxyPayload({
                    code: "proxy_response_oversized",
                    message: "Nested Pi coordinator response exceeded its bound.",
                  }) ?? "{}",
                );
          }),
      }),
      Effect.ignore,
    );
    // onlyIfMissing defensively keeps the explicit conflict response authoritative if a
    // completing same-key execution races this registration. rc.111 runImpl forks immediately
    // with the current context, so the execution starts at once and leaves the map on exit.
    return FiberMap.run(proxyRuns, key, execute, { onlyIfMissing: true }).pipe(Effect.asVoid);
  };

  const handleWireEvent = makeRunEventHandler({
    mutateView: settlement.mutateEventView,
    mergeLateUsage: settlement.mergeLateUsage,
    runStarted: settlement.runStartedFromBackend,
    runSettled: settlement.runSettledFromBackend,
    settle: settlement.settle,
    acceptReport: settlement.acceptBackendReport,
    notify: delivery.queueActionNotification,
    failRun: settlement.failRun,
    onWriteClaimViolation: containWriteClaimViolation,
    onProxyEvent: handleProxyEvent,
  });

  const initializeProcess = makeRunProcessInitializer({
    ownerScope,
    withLock,
    publish,
    initialize: processControls.initialize,
    handleBackendEvent: handleWireEvent,
    prepareBackendSpawn: prepareWriterLeaseForSpawn,
    markCleanupPending,
    closeExitedScope,
    failRun: settlement.failRun,
  });

  const launch = makeRunLaunch({
    ownerScope,
    backendRegistry,
    writerLeases,
    records,
    writerPools,
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
    settle: settlement.settle,
    submitPrompt: assignment.submitPrompt,
    initializeProcess,
    sendPeerNotices,
  });

  const resume = makeRunResume({
    ownerScope,
    records,
    writerPools,
    withLock,
    publish,
    writerLeases,
    delivery,
    requireRecord,
    requireCapability,
    allocateAssignmentAttemptToken,
    initializeProcess,
    submitPrompt: assignment.submitPrompt,
    settle: settlement.settle,
    failRun: settlement.failRun,
    closeRecordScope,
    retainUncertainAssignment: assignment.retainUncertainAssignment,
    sendPeerNotices,
  });

  const writeClaims = makeRunWriteClaimControl({
    records,
    writerPools,
    withLock,
    publish,
    requireRecord,
    sendPeerNotices,
  });

  const startRetrySessionOwned: SubagentServiceContract["startRetrySessionOwned"] = (request) =>
    runSessionOwned(ownerScope, Effect.void, () =>
      launch
        .start(request)
        .pipe(
          Effect.ensuring(
            retry.releaseRetryClaim(request.supersedes.runId, request.supersedes.claimToken),
          ),
        ),
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
    authorizeTargets(callerRunId, [callerRunId]).pipe(
      Effect.andThen(launch.startSessionOwned({ ...request, parentRunId: callerRunId })),
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
    start: launch.start,
    startSessionOwned: launch.startSessionOwned,
    startSessionOwnedFrom,
    visibleList,
    authorizeTargets,
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
  };

  yield* Effect.addFinalizer(() =>
    withLock(
      Effect.sync(() => {
        closed = true;
      }),
    ).pipe(
      Effect.andThen(
        Effect.forEach(
          leafFirst(records.values()),
          (record) => {
            record.stoppedByParent = true;
            settlement.failPendingResponses(
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
