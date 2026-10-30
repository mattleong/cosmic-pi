import { closeOpenToolSessionEvents } from "./session-events.ts";
import type { SessionUsageLedger } from "./session-usage.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type {
  BackendAssistantTerminal,
  BackendDriver,
  BackendHandle,
  BackendLaunchRequest,
  BackendStartupState,
} from "../backend/model.ts";
import type { CanonicalWriterCwd, WriterLeaseContract } from "../boundary/writer-lease.ts";
import type { GuidedText, SubagentError, SubagentNotFoundError } from "./errors.ts";
import {
  isTerminalRunState,
  type SubagentParentContext,
  type SubagentReportArchive,
  type SubagentReportTruncation,
  type SubagentRunView,
} from "./model.ts";
import { freezeSnapshot } from "pi-cosmic-core/projection";
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
  readonly error?: string | GuidedText | undefined;
}

/** A backend initialization in progress; settlements that arrive meanwhile wait for it. */
export interface RunInitialization {
  readonly settled: Deferred.Deferred<void>;
  pendingSettlement?: PendingInitializationSettlement | undefined;
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
  /** `error` and `warning` without the agent procedures they carry; absent when they match. */
  readonly userError?: string | undefined;
  readonly errorArchive?: SubagentReportArchive | undefined;
  readonly warning?: string | undefined;
  readonly userWarning?: string | undefined;
  /** Times an ancestor run took this report and then failed, paused, or stopped. */
  readonly handOns?: number | undefined;
}

interface AssignmentState {
  readonly epoch: number;
  phase: "preparing" | "issuing" | "running" | "reported";
  readonly attemptToken: string;
  startedObserved: boolean;
  outcomeUncertain: boolean;
  pendingRunSettled: false | { readonly terminal?: BackendAssistantTerminal | undefined };
}

/** View fields a snapshot derives from the record, so each is written once. */
type DerivedViewField =
  | "name"
  | "assignmentEpoch"
  | "warning"
  | "warningSource"
  | "childWarning"
  | "systemWarning"
  | "userSystemWarning";

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
  /** The candidate's backend; a start that falls back before its task is issued replaces it. */
  driver: BackendDriver;
  /** The next spawn's request, with the current session's resume token once it started. */
  launch: BackendLaunchRequest;
  /** Latest native parent facts admitted through this run's authenticated Pi channel. */
  parentContext?: SubagentParentContext | undefined;
  process?: BackendHandle | undefined;
  backendSpawnAttempt?:
    | { readonly scope: Scope.Closeable; readonly settled: Deferred.Deferred<void> }
    | undefined;
  readonly activeTools: Map<string, string>;
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
  /**
   * A failed startup candidate's closed scope whose processes are gone but whose writer-pool
   * membership, and so the cross-process lease, waits for the next candidate. Its cleanup stays
   * pending until that candidate takes the run or a later close of the scope detaches the pool.
   */
  writerPoolHandover?: Scope.Closeable | undefined;
  closingScope?: Scope.Closeable | undefined;
  closingScopeSettled?: Deferred.Deferred<void> | undefined;
  initialization?: RunInitialization | undefined;
  replyPendingRequestId?: string | undefined;
  notificationGeneration: number;
  /** Counts failures too; view.reportGeneration is the latest accepted report's generation. */
  completionGeneration: number;
  warningSlots: RunWarningSlots;
  readonly completionGenerations: Map<number, CompletionGenerationRecord>;
  readonly completionClaims: Map<number, string>;
  assignment: AssignmentState;
  nextAssignmentEpoch: number;
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
  const sessionEvents = closeOpenToolSessionEvents(record.view.sessionEvents);
  if (sessionEvents !== record.view.sessionEvents) record.view = { ...record.view, sessionEvents };
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
  const initialization = record.initialization;
  record.initialization = undefined;
  if (!initialization) return undefined;
  Deferred.doneUnsafe(initialization.settled, Effect.void);
  return initialization.pendingSettlement;
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
