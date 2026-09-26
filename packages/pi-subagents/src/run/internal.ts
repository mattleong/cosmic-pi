import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type {
  BackendAssistantTerminal,
  BackendDriver,
  BackendHandle,
  BackendLaunchRequest,
  BackendReport,
  BackendResumeToken,
  BackendStartupState,
} from "../backend/model.ts";
import type { CanonicalWriterCwd, WriterLeaseContract } from "../boundary/writer-lease.ts";
import type { ProfileRouteContinuation } from "../profiles/model.ts";
import {
  type SubagentError,
  type SubagentNotFoundError,
  UnsupportedSubagentCapabilityError,
} from "./errors.ts";
import {
  hasSubagentCapability,
  isTerminalRunState,
  type SubagentCapability,
  type SubagentRunView,
} from "./model.ts";
import { snapshotView } from "./state.ts";
import type { RunWarningSlots } from "./warnings.ts";
import type { WriterPoolEntry } from "./writer-pool.ts";

/** Runs an effect while holding a service semaphore, such as the run lock or completion gate. */
export type WithRunLock = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

/**
 * Service-owned primitives shared by run modules. Cross-module operations are wired by
 * explicit name and typed from their producer; only launch receives the registry mutably.
 */
export interface RunContext {
  /** Service scope for owner-scoped commits and background workers. */
  readonly ownerScope: Scope.Scope;
  /** The shared lock guarding every RunRecord mutation; `*Locked` operations require it. */
  readonly withLock: WithRunLock;
  readonly publish: Effect.Effect<void>;
  readonly records: ReadonlyMap<string, RunRecord>;
  /** One session-owned cross-process writer pool per canonical cwd digest. */
  readonly writerPools: Map<string, WriterPoolEntry>;
  readonly writerLeases: WriterLeaseContract;
  readonly requireRecord: (id: string) => Effect.Effect<RunRecord, SubagentNotFoundError>;
  readonly sendPeerNotices: (changedId: string) => Effect.Effect<void>;
  /** Service-owned assignment-attempt token allocation, invoked under the service lock. */
  readonly allocateAssignmentAttemptToken: () => string;
}

export interface PendingInitializationSettlement {
  readonly state: "completed" | "failed" | "stopped";
  readonly error?: string | undefined;
}

/** Stopped-by-parent, stopping, or terminal records ignore further child events. */
export const isInactiveRunRecord = (record: RunRecord): boolean =>
  record.stoppedByParent ||
  record.view.state === "stopping" ||
  isTerminalRunState(record.view.state);

export interface CompletionGenerationRecord {
  readonly generation: number;
  readonly outcome: "completed" | "failed";
  readonly finalText?: string | undefined;
  readonly error?: string | undefined;
  readonly warning?: string | undefined;
  readonly retained: boolean;
}

export type AssignmentPhase = "preparing" | "issuing" | "running" | "reported";

export interface AssignmentState {
  readonly epoch: number;
  phase: AssignmentPhase;
  readonly attemptToken: string;
  startedObserved: boolean;
  outcomeUncertain: boolean;
  pendingReport?: BackendReport | undefined;
  pendingRunSettled: false | { readonly terminal?: BackendAssistantTerminal | undefined };
}

export interface BackendReportWatermark {
  readonly assignmentEpoch: number;
  readonly sequence: number;
  readonly deliveryId: string;
}

export interface RunRecord {
  view: SubagentRunView;
  scope: Scope.Closeable;
  readonly driver: BackendDriver;
  launch: BackendLaunchRequest;
  resumeToken?: BackendResumeToken | undefined;
  process?: BackendHandle | undefined;
  backendSpawnAttempt?:
    | { readonly scope: Scope.Closeable; readonly settled: Deferred.Deferred<void> }
    | undefined;
  readonly activeTools: Map<string, string>;
  /** Runtime-native activity remains internal to this Pi run node. */
  readonly nativeAgents: Map<string, { readonly kind: string }>;
  nativeAgentTotal: number;
  /** Resolves only after backend/process/writer cleanup is confirmed or quarantined. */
  cleanupSettlement: Deferred.Deferred<"confirmed" | "quarantined">;
  /** Authoritative cleanup fact used by failed-start recovery and retry admission. */
  cleanupDisposition: "pending" | "confirmed" | "quarantined";
  readonly routeContinuation?: ProfileRouteContinuation | undefined;
  retryClaim?: { readonly token: string } | undefined;
  retryExhausted: boolean;
  pauseOutcome?: Deferred.Deferred<SubagentRunView, SubagentError> | undefined;
  latestAssistantText?: string | undefined;
  pauseRequested: boolean;
  pausedAssignmentEpoch?: number | undefined;
  stoppedByParent: boolean;
  cleanupPending: boolean;
  runStateReclaimState: "pending" | "running" | "reclaimed";
  /**
   * Exclusive start-admission eviction claim. Set under the service lock while
   * one start reclaims this terminal record's private state; the record stays
   * registered until the claiming start revalidates and deletes it atomically.
   * The claim also reserves the prospective process slot (and writer digest,
   * when present) while reclamation runs outside the lock.
   */
  evictionClaim?:
    | {
        readonly parentRunId?: string | undefined;
        readonly writerCwdDigest?: string | undefined;
        readonly writeClaims?: ReadonlyArray<string> | undefined;
      }
    | undefined;
  readonly canonicalWriterCwd?: CanonicalWriterCwd | undefined;
  writerPool?: WriterPoolEntry | undefined;
  writeViolationContainmentStarted: boolean;
  closingScope?: Scope.Closeable | undefined;
  closingScopeSettled?: Deferred.Deferred<void> | undefined;
  initializationPending: boolean;
  initializationSettled?: Deferred.Deferred<void> | undefined;
  pendingInitializationSettlement?: PendingInitializationSettlement | undefined;
  replyPendingRequestId?: string | undefined;
  notificationGeneration: number;
  completionGeneration: number;
  warningSlots: RunWarningSlots;
  readonly completionGenerations: Map<number, CompletionGenerationRecord>;
  /** One exclusive capability token may own a generation at a time. */
  readonly completionClaims: Map<number, string>;
  assignment: AssignmentState;
  /** Monotonic allocator; rolled-back attempts are never reused. */
  nextAssignmentEpoch: number;
  lastBackendReport?: BackendReportWatermark | undefined;
  steeringDeliveryOwner?: { readonly epoch: number; readonly sequence: number } | undefined;
  /** Primary failure survives later generic process-exit evidence. */
  backendFailure?: SubagentError | undefined;
}

export const clearRunNativeActivity = (record: RunRecord): void => {
  record.nativeAgents.clear();
  if (record.view.nativeActivity?.active)
    record.view = {
      ...record.view,
      nativeActivity: { ...record.view.nativeActivity, active: 0 },
    };
};

/** Commits a pause of the current assignment and returns its snapshot; caller holds the lock. */
export const commitRunPauseLocked = (record: RunRecord, now: number): SubagentRunView => {
  record.pauseRequested = false;
  record.pausedAssignmentEpoch = record.assignment.epoch;
  record.activeTools.clear();
  clearRunNativeActivity(record);
  record.view = {
    ...record.view,
    state: "paused",
    question: undefined,
    currentTool: undefined,
    lastActivityAt: now,
  };
  return snapshotView(record.view);
};

/** Wakes initialization waiters and takes the settlement deferred until startup committed. */
export const completeRunInitialization = (
  record: RunRecord,
): PendingInitializationSettlement | undefined => {
  record.initializationPending = false;
  const settled = record.initializationSettled;
  record.initializationSettled = undefined;
  if (settled) Deferred.doneUnsafe(settled, Effect.void);
  const pending = record.pendingInitializationSettlement;
  record.pendingInitializationSettlement = undefined;
  return pending;
};

/** Commits backend startup state for launch and resume; caller holds the service lock. */
export const commitRunInitialization = (record: RunRecord, state: BackendStartupState) => {
  const pending = completeRunInitialization(record);
  record.resumeToken = state.resumeToken;
  record.view = {
    ...record.view,
    model: state.model ?? record.view.model,
    effort: state.effort,
    sessionId: state.sessionId,
    ...(state.sessionFile && { sessionFile: state.sessionFile }),
  };
  return pending;
};

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

export const requireCapability = (
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
