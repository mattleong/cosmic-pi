import { closeOpenToolSessionEvents } from "./session-events.ts";
import type { SessionUsageLedger } from "./session-usage.ts";
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
  BackendStartupState,
} from "../backend/model.ts";
import type { CanonicalWriterCwd, WriterLeaseContract } from "../boundary/writer-lease.ts";
import {
  type SubagentError,
  type SubagentNotFoundError,
  UnsupportedSubagentCapabilityError,
} from "./errors.ts";
import {
  hasSubagentCapability,
  isTerminalRunState,
  type SubagentCapability,
  type SubagentParentContext,
  type SubagentReportArchive,
  type SubagentReportTruncation,
  type SubagentRunView,
} from "./model.ts";
import { freezeSnapshot } from "pi-cosmic-core";
import type { CapturedOutputText } from "./state.ts";
import { runWarningFields, type RunWarningSlots } from "./warnings.ts";
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
  readonly sessionUsage: SessionUsageLedger;
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
  readonly finalTextTruncation?: SubagentReportTruncation | undefined;
  readonly reportArchive?: SubagentReportArchive | undefined;
  readonly error?: string | undefined;
  readonly errorArchive?: SubagentReportArchive | undefined;
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

/** View fields a snapshot derives from the record, so each is written once. */
type DerivedViewField =
  | "name"
  | "assignmentEpoch"
  | "warning"
  | "warningSource"
  | "childWarning"
  | "systemWarning";

/** The view a record stores; `snapshotRun` adds the derived fields. */
export type StoredRunView = Omit<SubagentRunView, DerivedViewField>;

/**
 * Whether the run's cleanup has begun: `none` until a stop, settlement, failure, or shutdown
 * starts it, then `pending` while it runs or is reverified, and finally confirmed or quarantined.
 */
export type RunCleanupDisposition = "none" | "pending" | "confirmed" | "quarantined";

export interface RunRecord {
  readonly scriptOrigin: boolean;
  view: StoredRunView;
  scope: Scope.Closeable;
  readonly driver: BackendDriver;
  /** The next spawn's request, with the current session's resume token once it started. */
  launch: BackendLaunchRequest;
  /** Latest native parent facts admitted through this run's authenticated Pi channel. */
  parentContext?: SubagentParentContext | undefined;
  process?: BackendHandle | undefined;
  backendSpawnAttempt?:
    | { readonly scope: Scope.Closeable; readonly settled: Deferred.Deferred<void> }
    | undefined;
  readonly activeTools: Map<string, string>;
  readonly nativeAgents: Set<string>;
  cleanupSettlement: Deferred.Deferred<"confirmed" | "quarantined">;
  /** The view's `cleanup` publishes this, with its evidence, once closing starts. */
  cleanupDisposition: RunCleanupDisposition;
  cleanupRecovery?:
    | { readonly scope: Scope.Closeable; readonly process: BackendHandle }
    | undefined;
  cleanupVerification?:
    | {
        readonly scope: Scope.Closeable;
        readonly process: BackendHandle;
        readonly settled: Deferred.Deferred<void>;
      }
    | undefined;
  pauseOutcome?: Deferred.Deferred<SubagentRunView, SubagentError> | undefined;
  latestAssistantText?: string | undefined;
  latestAssistantTruncation?: SubagentReportTruncation | undefined;
  /** The latest assistant text up to the archive cap while the retained text is cut; released at settlement. */
  latestAssistantFullText?: string | undefined;
  pauseRequested: boolean;
  pausedAssignmentEpoch?: number | undefined;
  stoppedByParent: boolean;
  runStateReclaimState: "pending" | "running" | "reclaimed";
  evictionClaim?: { readonly parentRunId?: string | undefined } | undefined;
  readonly canonicalWriterCwd?: CanonicalWriterCwd | undefined;
  writerPool?: WriterPoolEntry | undefined;
  closingScope?: Scope.Closeable | undefined;
  closingScopeSettled?: Deferred.Deferred<void> | undefined;
  initializationPending: boolean;
  initializationSettled?: Deferred.Deferred<void> | undefined;
  pendingInitializationSettlement?: PendingInitializationSettlement | undefined;
  replyPendingRequestId?: string | undefined;
  notificationGeneration: number;
  /** Counts failures too; view.reportGeneration is the latest accepted report's generation. */
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

/** Replaces the run's latest assistant text, releasing a superseded message's full copy. */
export const recordLatestAssistantText = (
  record: RunRecord,
  captured: CapturedOutputText | undefined,
): void => {
  record.latestAssistantText = captured?.text;
  record.latestAssistantTruncation = captured?.truncation;
  record.latestAssistantFullText = captured?.fullText;
};

export const clearRunActivity = (record: RunRecord): void => {
  record.activeTools.clear();
  record.nativeAgents.clear();
  const sessionEvents = closeOpenToolSessionEvents(record.view.sessionEvents);
  if (record.view.nativeActivity?.active || sessionEvents !== record.view.sessionEvents)
    record.view = {
      ...record.view,
      sessionEvents,
      ...(record.view.nativeActivity?.active && {
        nativeActivity: { ...record.view.nativeActivity, active: 0 },
      }),
    };
};

/** Cleanup has begun and isn't confirmed: it is running, being reverified, or quarantined. */
export const isCleanupOwed = (record: RunRecord): boolean =>
  record.cleanupDisposition === "pending" || record.cleanupDisposition === "quarantined";

/** Marks a run whose cleanup hasn't begun as owing it; later dispositions stand. */
export const beginCleanup = (record: RunRecord): void => {
  if (record.cleanupDisposition === "none") record.cleanupDisposition = "pending";
};

interface RunSnapshot {
  readonly name: string;
  readonly epoch: number;
  readonly warnings: RunWarningSlots;
  readonly view: SubagentRunView;
}

const runSnapshots = new WeakMap<StoredRunView, RunSnapshot>();

/**
 * The run's frozen public view: its stored view plus the name from its launch, the epoch from its
 * assignment, and its retained warnings. Each stored view freezes once per change of those sources.
 */
export const snapshotRun = (record: RunRecord): SubagentRunView => {
  const { view, launch, assignment, warningSlots } = record;
  const cached = runSnapshots.get(view);
  if (
    cached?.name === launch.name &&
    cached.epoch === assignment.epoch &&
    cached.warnings === warningSlots
  )
    return cached.view;
  const snapshot = freezeSnapshot({
    ...view,
    name: launch.name,
    assignmentEpoch: assignment.epoch,
    ...runWarningFields(warningSlots),
  });
  runSnapshots.set(view, {
    name: launch.name,
    epoch: assignment.epoch,
    warnings: warningSlots,
    view: snapshot,
  });
  return snapshot;
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
  return snapshotRun(record);
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
  record.launch = { ...record.launch, resumeToken: state.resumeToken };
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
      return `${backend} subagents do not support mid-turn guidance. Await with agent_await({ runIds: ["${id}"], until: "all_finished" }), inspect with agent_read({ agentIds: ["${id}"] }), or stop with agent_lifecycle({ action: "stop", runIds: ["${id}"] }).`;
    case "interrupt":
      return `${backend} subagents do not support interruption. Stop with agent_lifecycle({ action: "stop", runIds: ["${id}"] }) or wait with agent_await.`;
    case "parent-contact":
      return `${backend} subagents do not support parent questions; use agent_await or agent_read instead.`;
    case "native-fork":
    case "peer-notice":
    case "resume":
      return `${backend} subagents do not support ${capability}. Inspect supported operations with agent_read({ agentIds: ["${id}"] }).`;
  }
  return absurd(capability);
};

export const requireCapability = (
  record: RunRecord,
  capability: SubagentCapability,
): Effect.Effect<void, UnsupportedSubagentCapabilityError> => {
  if (hasSubagentCapability(record.view, capability)) return Effect.void;
  const backend = `local/${record.view.runtime}`;
  return Effect.fail(
    new UnsupportedSubagentCapabilityError({
      backend,
      capability,
      message: unsupportedCapabilityMessage(backend, capability, record.view.id),
    }),
  );
};
