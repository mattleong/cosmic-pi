import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import { claimCompletion, completionClaimOwner, releaseCompletionClaim } from "./completion.ts";
import {
  invalidRequest,
  type InvalidSubagentRequestError,
  type SubagentError,
  type SubagentRuntimeClosedError,
  type SubagentWriterConflictError,
} from "./errors.ts";
import type { RunContext, RunOwnership, RunRecord } from "./internal.ts";
import {
  isTerminalRunState,
  type StartSubagentRequest,
  type SubagentRunView,
  type SubagentUsage,
} from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import type { WorkspaceBindingStatus } from "./workspace-binding.ts";

/** Exclusive capability for one owned run's first completion generation. */
export interface OwnedRunHandle {
  readonly runId: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly claimToken: string;
}

/** What an owned run used by the time it settled: its usage and the tool calls it started. */
interface OwnedRunSpend {
  readonly usage: SubagentUsage;
  readonly toolUses: number;
}

export type OwnedRunOutcome = OwnedRunSpend &
  (
    | {
        readonly kind: "completed";
        readonly text: string;
        readonly warning?: string | undefined;
      }
    | {
        readonly kind: "failed" | "stopped";
        readonly reason: string;
      }
  );

export interface OwnedRunStart {
  readonly ownerId: string;
  /** An id from `reserveRunId`, so a queued placeholder keeps its identity once admitted. */
  readonly runId?: string | undefined;
}

/**
 * In-process owners, such as workflow runs, whose subagents report to the owner instead of the
 * root conversation. Every method is trusted and never reachable from tool or proxy schemas.
 */
export interface OwnedRunCoordinatorContract {
  /** Allocates a run id before admission; an unused reservation holds no state. */
  readonly reserveRunId: Effect.Effect<string>;
  readonly openOwner: (ownerId: string) => Effect.Effect<void>;
  /**
   * Admits a root-visible run whose first report belongs to the owner. A failed or interrupted
   * start never leaves an admitted run running or its report claimed. The claim is bound to the
   * caller's scope: closing it before the outcome is consumed or handed back stops a live run
   * and releases its report as `closeOwner` does.
   */
  readonly startOwned: (
    request: StartSubagentRequest,
    owner: OwnedRunStart,
  ) => Effect.Effect<OwnedRunHandle, SubagentError, Scope.Scope>;
  /**
   * Waits through parent questions and pauses until the owned generation settles, then consumes
   * it in the same locked step. Interruption stops the run and releases its report.
   */
  readonly awaitOwned: (
    handle: OwnedRunHandle,
  ) => Effect.Effect<OwnedRunOutcome, InvalidSubagentRequestError | SubagentRuntimeClosedError>;
  /**
   * Revokes admission, stops the owner's live runs, and releases their reports: an unread
   * completed writer report goes to the root, everything else is consumed.
   */
  readonly closeOwner: (ownerId: string) => Effect.Effect<void>;
  /** Waits for a projection revision newer than `after`. */
  readonly waitForRevision: (after: number) => Effect.Effect<void, SubagentRuntimeClosedError>;
  /**
   * Advances only when a process slot, writer slot, cleanup or claim that can refuse a start is
   * released. Read it before a start that may be refused for capacity or a transient conflict.
   */
  readonly admissionRevision: Effect.Effect<number>;
  /** Waits until the admission revision passes `after`. */
  readonly waitForAdmissionChange: (
    after: number,
  ) => Effect.Effect<void, SubagentRuntimeClosedError>;
  /**
   * How many of these queued workflow starts, from the front, the root could admit now, checked
   * under the run lock without validation, backend resolution or preflight. It counts the slots
   * worktree launches hold while they acquire workspaces and the root slots workflow agents
   * leave free for the main agent. `letThrough` names the run ids of owned starts already let
   * through; each one that holds no slot of its own yet counts as a workflow agent. A count only
   * means those starts may now be admitted. Read the admission revision before checking.
   */
  readonly queuedStartsAdmissible: (
    requests: ReadonlyArray<StartSubagentRequest>,
    letThrough: ReadonlyArray<string>,
  ) => Effect.Effect<number>;
  /**
   * The writer a queued shared-checkout writer still conflicts with in a way that clears by
   * itself, checked the same way; undefined when none does.
   */
  readonly queuedWriterConflict: (
    request: StartSubagentRequest,
  ) => Effect.Effect<SubagentWriterConflictError | undefined>;
  /** The direct-child limit the session's current nesting policy sets for the root. */
  readonly rootChildLimit: Effect.Effect<number>;
  /** What this session's coordinator knows of a writer workspace, read under the run lock. */
  readonly workspaceBindingStatus: (workspaceId: string) => Effect.Effect<WorkspaceBindingStatus>;
}

export interface RunOwnedRunsDependencies extends RunContext {
  readonly allocateClaimToken: () => string;
  /** Whether `id` came from this service's run-id allocator; caller holds the lock. */
  readonly isAllocatedRunId: (id: string) => boolean;
  /** Current projection revision; read under the lock so no publication is missed. */
  readonly currentRevision: () => number;
  readonly waitForRevision: OwnedRunCoordinatorContract["waitForRevision"];
  readonly delivery: Pick<RunNotificationDelivery, "wakeCompletionLocked">;
  readonly start: (
    request: StartSubagentRequest,
    ownership: RunOwnership,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly stop: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
}

interface OwnerEntry {
  open: boolean;
  readonly runIds: Set<string>;
}

type AwaitStep = { readonly outcome: OwnedRunOutcome } | { readonly revision: number };

const STOPPED_REASON = "Stopped before reporting.";

/**
 * Owns the owner registry and owned-generation claims. Admission claims generation 1 before
 * the record is registered, so root delivery never selects it; release decides whether the
 * report is consumed or handed back to root delivery.
 */
export function makeRunOwnedRuns(dependencies: RunOwnedRunsDependencies) {
  const {
    records,
    withLock,
    allocateClaimToken,
    isAllocatedRunId,
    currentRevision,
    waitForRevision,
    delivery,
    start,
    stop,
  } = dependencies;
  const owners = new Map<string, OwnerEntry>();

  const checkOwnerLocked = (owner: OwnedRunStart) =>
    Effect.suspend(() => {
      if (owners.get(owner.ownerId)?.open !== true)
        return Effect.fail(
          invalidRequest(
            "workflow_owner_closed",
            `Workflow ${owner.ownerId} no longer admits subagents.`,
          ),
        );
      if (owner.runId !== undefined && (records.has(owner.runId) || !isAllocatedRunId(owner.runId)))
        return Effect.fail(
          invalidRequest(
            "owned_run_id_unavailable",
            `Run id ${owner.runId} was not reserved by this session or is already in use.`,
          ),
        );
      return Effect.void;
    });

  /** The record whose exact generation this handle still owns; caller holds the lock. */
  const ownedRecordLocked = (handle: OwnedRunHandle): RunRecord | undefined => {
    const record = records.get(handle.runId);
    return record?.owner?.claimToken === handle.claimToken &&
      completionClaimOwner(record, handle.generation) === handle.claimToken
      ? record
      : undefined;
  };

  const consumeLocked = (record: RunRecord, handle: OwnedRunHandle): void => {
    record.completionGenerations.delete(handle.generation);
    record.completionClaims.delete(handle.generation);
  };

  /**
   * The root owns the run from now on: root guards lift, and a later resume runs it as an
   * ordinary root child, without the owner's workflow step or result contract.
   */
  const relinquishLocked = (record: RunRecord): void => {
    if (!record.owner?.live) return;
    record.owner.live = false;
    const { resultContract: _contract, ...launch } = record.launch;
    record.launch = {
      ...launch,
      ...(record.releasedSystemPrompt !== undefined && {
        systemPrompt: record.releasedSystemPrompt,
      }),
    };
  };

  const handBackLocked = (record: RunRecord, handle: OwnedRunHandle): void => {
    if (releaseCompletionClaim(record, handle.generation, handle.claimToken))
      delivery.wakeCompletionLocked();
    relinquishLocked(record);
  };

  /** Whether someone stopped the owned run; caller holds the lock. */
  const stoppedLocked = (handle: OwnedRunHandle): boolean => {
    const record = ownedRecordLocked(handle);
    return (
      record !== undefined &&
      (record.stoppedByParent ||
        record.view.state === "stopping" ||
        record.view.state === "stopped")
    );
  };

  /** A run that can still settle; dropping its claim would send that report to the root. */
  const isLive = (record: RunRecord): boolean =>
    !record.stoppedByParent && !isTerminalRunState(record.view.state);

  /**
   * Caller holds the lock. A live run, or a completed writer's unread report, goes back to the
   * root, never silently dropped; anything else is consumed.
   */
  const releaseLocked = (handle: OwnedRunHandle): void => {
    const record = ownedRecordLocked(handle);
    if (!record) return;
    const payload = record.completionGenerations.get(handle.generation);
    const unreadWriterReport =
      payload?.outcome === "completed" && record.view.writeIntent === "writer";
    if (isLive(record) || unreadWriterReport) handBackLocked(record, handle);
    else consumeLocked(record, handle);
  };

  const stopLive = (handle: OwnedRunHandle) =>
    withLock(
      Effect.sync(() => {
        const record = ownedRecordLocked(handle);
        return record !== undefined && isLive(record);
      }),
    ).pipe(
      Effect.flatMap((live) =>
        live
          ? stop(handle.runId).pipe(
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.logWarning(`Could not stop owned subagent: ${error.message}`).pipe(
                  Effect.annotateLogs("runId", handle.runId),
                ),
              ),
            )
          : Effect.void,
      ),
    );

  /** Stops a live run, then releases its report; an unread writer report goes to the root. */
  const retire = (handle: OwnedRunHandle) =>
    stopLive(handle).pipe(Effect.andThen(withLock(Effect.sync(() => releaseLocked(handle)))));

  const openOwner: OwnedRunCoordinatorContract["openOwner"] = (ownerId) =>
    withLock(
      Effect.sync(() => {
        if (!owners.has(ownerId)) owners.set(ownerId, { open: true, runIds: new Set() });
      }),
    );

  const startOwned: OwnedRunCoordinatorContract["startOwned"] = (request, owner) => {
    let admitted: OwnedRunHandle | undefined;
    const ownership: RunOwnership = {
      runId: owner.runId,
      checkLocked: checkOwnerLocked(owner),
      admittedLocked: (record) => {
        const claimToken = allocateClaimToken();
        const generation = record.completionGeneration + 1;
        claimCompletion(record, generation, claimToken);
        record.owner = { ownerId: owner.ownerId, claimToken, generation, live: true };
        owners.get(owner.ownerId)?.runIds.add(record.view.id);
        admitted = { runId: record.view.id, ownerId: owner.ownerId, generation, claimToken };
      },
    };
    // Only the launch is interruptible; the scope finalizer is installed before the handle
    // returns, so no interruption point separates admission from cleanup ownership.
    return Effect.uninterruptibleMask((restore) =>
      restore(start(request, ownership)).pipe(
        // A run stopped while it started still settles as stopped, so its owner awaits it.
        Effect.catchIf(
          () => admitted !== undefined,
          (error) =>
            withLock(Effect.sync(() => admitted !== undefined && stoppedLocked(admitted))).pipe(
              Effect.flatMap((stopped) => (stopped ? Effect.void : Effect.fail(error))),
            ),
        ),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && admitted ? retire(admitted) : Effect.void,
        ),
        Effect.flatMap(() => {
          const handle = admitted;
          return handle
            ? Effect.addFinalizer(() => retire(handle)).pipe(Effect.as(handle))
            : Effect.fail(
                invalidRequest("owned_run_not_admitted", "The owned subagent was not admitted."),
              );
        }),
      ),
    );
  };

  /** Caller holds the lock; consumes a settled generation and returns its outcome. */
  const awaitStepLocked = (handle: OwnedRunHandle) =>
    Effect.suspend((): Effect.Effect<AwaitStep, InvalidSubagentRequestError> => {
      const record = ownedRecordLocked(handle);
      if (!record)
        return Effect.fail(
          invalidRequest(
            "owned_run_released",
            `Subagent ${handle.runId} is no longer owned by ${handle.ownerId}.`,
          ),
        );
      const spend: OwnedRunSpend = {
        usage: record.view.usage,
        toolUses: record.view.toolUses ?? 0,
      };
      const payload = record.completionGenerations.get(handle.generation);
      if (payload) {
        consumeLocked(record, handle);
        return Effect.succeed({
          outcome:
            payload.outcome === "completed"
              ? {
                  kind: "completed",
                  text: payload.finalText ?? "",
                  ...(payload.warning && { warning: payload.warning }),
                  ...spend,
                }
              : { kind: "failed", reason: payload.error ?? "Run failed.", ...spend },
        });
      }
      if (!isTerminalRunState(record.view.state))
        return Effect.succeed({ revision: currentRevision() });
      consumeLocked(record, handle);
      return Effect.succeed({
        outcome:
          record.view.state === "stopped"
            ? { kind: "stopped", reason: STOPPED_REASON, ...spend }
            : {
                kind: "failed",
                reason: record.view.error ?? "Run ended without a report.",
                ...spend,
              },
      });
    });

  const awaitOwned: OwnedRunCoordinatorContract["awaitOwned"] = (handle) =>
    Effect.uninterruptibleMask((restore) => {
      // Only the revision wait is interruptible, so a consumed outcome is always returned.
      const loop = (): Effect.Effect<
        OwnedRunOutcome,
        InvalidSubagentRequestError | SubagentRuntimeClosedError
      > =>
        withLock(awaitStepLocked(handle)).pipe(
          Effect.flatMap((step) =>
            "outcome" in step
              ? Effect.succeed(step.outcome)
              : restore(waitForRevision(step.revision)).pipe(Effect.andThen(Effect.suspend(loop))),
          ),
        );
      return loop().pipe(Effect.onInterrupt(() => retire(handle)));
    });

  const closeOwner: OwnedRunCoordinatorContract["closeOwner"] = (ownerId) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const handles = yield* withLock(
          Effect.sync(() => {
            const entry = owners.get(ownerId);
            if (!entry) return [];
            entry.open = false;
            return [...entry.runIds].flatMap((runId): OwnedRunHandle[] => {
              const claim = records.get(runId)?.owner;
              return claim?.ownerId === ownerId
                ? [{ runId, ownerId, generation: claim.generation, claimToken: claim.claimToken }]
                : [];
            });
          }),
        );
        // Owned runs are disjoint root-child subtrees; each stop closes its own subtree leaf-first.
        yield* Effect.forEach(handles, retire, { concurrency: "unbounded", discard: true });
        yield* withLock(
          Effect.sync(() => {
            for (const runId of owners.get(ownerId)?.runIds ?? []) {
              const record = records.get(runId);
              if (record?.owner?.ownerId === ownerId) relinquishLocked(record);
            }
            owners.delete(ownerId);
          }),
        );
      }),
    );

  return { openOwner, startOwned, awaitOwned, closeOwner };
}
