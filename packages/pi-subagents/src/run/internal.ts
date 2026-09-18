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
} from "../backend/model.ts";
import type { CanonicalWriterCwd } from "../boundary/writer-lease.ts";
import type { ProfileRouteContinuation } from "../profiles/model.ts";
import type { SubagentError } from "./errors.ts";
import { isTerminalRunState, type SubagentRunView } from "./model.ts";
import type { RunWarningSlots } from "./warnings.ts";
import type { WriterPoolEntry } from "./writer-pool.ts";

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
}

export const clearRunNativeActivity = (record: RunRecord): void => {
  record.nativeAgents.clear();
  if (record.view.nativeActivity?.active)
    record.view = {
      ...record.view,
      nativeActivity: { ...record.view.nativeActivity, active: 0 },
    };
};

export const completeRunInitialization = (record: RunRecord): void => {
  record.initializationPending = false;
  const settled = record.initializationSettled;
  record.initializationSettled = undefined;
  if (settled) Deferred.doneUnsafe(settled, Effect.void);
};
