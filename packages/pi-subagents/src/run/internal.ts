import { absurd } from "effect/Function";
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
  invalidRequest,
  type InvalidSubagentRequestError,
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
import type { WriterPoolEntry, WriterPools } from "./writer-pool.ts";

export type WithRunLock = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

export interface RunContext {
  readonly ownerScope: Scope.Scope;
  readonly withLock: WithRunLock;
  readonly publish: Effect.Effect<void>;
  readonly records: ReadonlyMap<string, RunRecord>;
  readonly writerPools: WriterPools;
  readonly writerLeases: WriterLeaseContract;
  readonly requireRecord: (id: string) => Effect.Effect<RunRecord, SubagentNotFoundError>;
  readonly sendPeerNotices: (changedId: string) => Effect.Effect<void>;
  readonly allocateAssignmentAttemptToken: () => string;
}

export interface PendingInitializationSettlement {
  readonly state: "completed" | "failed" | "stopped";
  readonly error?: string | undefined;
}

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
}

interface AssignmentState {
  readonly epoch: number;
  phase: "preparing" | "issuing" | "running" | "reported";
  readonly attemptToken: string;
  startedObserved: boolean;
  outcomeUncertain: boolean;
  pendingReport?: BackendReport | undefined;
  pendingRunSettled: false | { readonly terminal?: BackendAssistantTerminal | undefined };
}

interface BackendReportWatermark {
  readonly assignmentEpoch: number;
  readonly sequence: number;
  readonly deliveryId: string;
}

export interface RunOwnership {
  readonly runId?: string | undefined;
  readonly checkLocked: Effect.Effect<void, InvalidSubagentRequestError>;
  readonly admittedLocked: (record: RunRecord) => void;
}

interface RunOwnerClaim {
  readonly ownerId: string;
  readonly claimToken: string;
  readonly generation: number;
  live: boolean;
}

export interface RunRecord {
  readonly scriptOrigin: boolean;
  owner?: RunOwnerClaim | undefined;
  readonly releasedSystemPrompt?: string | undefined;
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
  readonly nativeAgents: Set<string>;
  cleanupSettlement: Deferred.Deferred<"confirmed" | "quarantined">;
  cleanupDisposition: "pending" | "confirmed" | "quarantined";
  readonly routeContinuation?: ProfileRouteContinuation | undefined;
  retryClaim?: { readonly token: string } | undefined;
  pauseOutcome?: Deferred.Deferred<SubagentRunView, SubagentError> | undefined;
  latestAssistantText?: string | undefined;
  structuredResult?: { readonly assignmentEpoch: number; readonly json: string } | undefined;
  pauseRequested: boolean;
  pausedAssignmentEpoch?: number | undefined;
  stoppedByParent: boolean;
  cleanupPending: boolean;
  runStateReclaimState: "pending" | "running" | "reclaimed";
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
  readonly completionClaims: Map<number, string>;
  assignment: AssignmentState;
  nextAssignmentEpoch: number;
  lastBackendReport?: BackendReportWatermark | undefined;
  steeringDeliveryOwner?: { readonly epoch: number; readonly sequence: number } | undefined;
  backendFailure?: SubagentError | undefined;
}

export const clearRunActivity = (record: RunRecord): void => {
  record.activeTools.clear();
  record.nativeAgents.clear();
  if (record.view.nativeActivity?.active)
    record.view = {
      ...record.view,
      nativeActivity: { ...record.view.nativeActivity, active: 0 },
    };
};

export const commitRunPauseLocked = (record: RunRecord, now: number): SubagentRunView => {
  record.pauseRequested = false;
  record.pausedAssignmentEpoch = record.assignment.epoch;
  clearRunActivity(record);
  record.view = {
    ...record.view,
    state: "paused",
    question: undefined,
    currentTool: undefined,
    lastActivityAt: now,
  };
  return snapshotView(record.view);
};

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

export const workflowOwnedRunError = (
  record: RunRecord,
  operation: string,
): InvalidSubagentRequestError | undefined => {
  const owner = record.owner;
  if (!owner?.live) return undefined;
  const workflow = record.view.workflow?.name
    ? `${record.view.workflow.name} (${owner.ownerId})`
    : owner.ownerId;
  return invalidRequest(
    "workflow_owned_run",
    `Subagent ${record.view.id} belongs to workflow ${workflow}, which receives its result, so it cannot ${operation}. The workflow's notification starts your next turn with its result, so end your turn rather than waiting on this subagent; stop the workflow with subagent_workflow only when the user asks or it is clearly broken. Stopping this subagent resolves its agent() call to null as stopped.`,
  );
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
    case "native-fork":
    case "peer-notice":
    case "rename-display":
    case "resume":
      return `${backend} subagents do not support ${capability}. Inspect supported operations with subagent_status({ runIds: ["${id}"] }).`;
  }
  return absurd(capability);
};

export const requireCapability = (
  record: RunRecord,
  capability: SubagentCapability,
): Effect.Effect<void, UnsupportedSubagentCapabilityError> => {
  if (hasSubagentCapability(record.view, capability)) return Effect.void;
  const backend = `${record.view.host}/${record.view.runtime}`;
  return Effect.fail(
    new UnsupportedSubagentCapabilityError({
      backend,
      capability,
      message: unsupportedCapabilityMessage(backend, capability, record.view.id),
    }),
  );
};
