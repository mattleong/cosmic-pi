import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { CrossProcessLockContract, SafeFile } from "pi-cosmic-core";
import { OPEN_WORKSPACE_STATUSES } from "../workspace/model.ts";
import type {
  WorkspaceAdoptTarget,
  WorkspaceError,
  WorkspaceHandle,
  WorkspaceOrphanTarget,
  WorkspaceRecord,
  WorkspaceSweepTarget,
  WorkspaceSwept,
} from "../workspace/model.ts";
import { nodePath as path } from "./node-builtins.ts";
import { workspaceFailure, workspaceRefusal } from "./git-worktree-process.ts";
import { treeOf } from "./git-capture.ts";
import type { BeforeTreeRemoval } from "./git-worktree-hooks.ts";
import { workspaceArtifact } from "./git-worktree-trees.ts";
import {
  ownerLockNamespace,
  revisionDiffFile,
  saveWorkspaceRecord,
  withFreeLock,
} from "./git-worktree-store.ts";
import {
  listWorkspaceRecords,
  removeWorkspaceTrees,
  requireOriginalWorker,
} from "./git-worktree-recovery.ts";
import { rollbackIntegration } from "./git-worktree-integration.ts";

/** The engine state and operations orphan takeover and the sweep share with the engine. */
export interface OrphanEngine {
  readonly registry: string;
  readonly locks: CrossProcessLockContract;
  readonly lockDirectory: string;
  /** Workspaces this engine's session owns; adopt adds the ones it takes over. */
  readonly owned: Set<string>;
  /** This engine's owner lease token, acquired on first use. */
  readonly ownerPresence: Effect.Effect<string, WorkspaceError>;
  readonly managedRecord: (
    workspaceId: string,
  ) => Effect.Effect<WorkspaceRecord, WorkspaceError, SafeFile>;
  /** The worker tree's current capture. */
  readonly workerTree: (record: WorkspaceRecord) => Effect.Effect<string, WorkspaceError, SafeFile>;
  /** Freezes the worker tree as a new revision, dropping any preparation. */
  readonly freezeAnew: (
    record: WorkspaceRecord,
  ) => Effect.Effect<WorkspaceRecord, WorkspaceError, SafeFile>;
  readonly beforeRemove: BeforeTreeRemoval | undefined;
  /** Runs an operation under the store lock of the target's checkout. */
  readonly locked: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    target: WorkspaceOrphanTarget,
  ) => Effect.Effect<A, E | WorkspaceError, R | SafeFile>;
}

const oldEnough = (record: WorkspaceRecord, now: number, minimumAgeMillis: number) =>
  now - record.lastChangedAt >= minimumAgeMillis;

/** Discard, takeover, and the sweep of workspaces whose creating session has ended. */
export const orphanWorkspaceOperations = (engine: OrphanEngine) => {
  const { registry, locks, lockDirectory, owned, managedRecord, locked, beforeRemove } = engine;
  const ownerEnded = <A, E, R>(ownerLease: string, effect: Effect.Effect<A, E, R>) =>
    withFreeLock(locks, lockDirectory, ownerLockNamespace(ownerLease), effect);
  // Runs `effect` holding the orphan's free owner lease, which proves its creating session ended.
  const whileOwnerEnded = <A>(
    record: WorkspaceRecord,
    effect: Effect.Effect<A, WorkspaceError, SafeFile>,
  ) =>
    Effect.gen(function* () {
      if (owned.has(record.handle.workspaceId))
        return yield* workspaceFailure(
          "authorization",
          "This session owns the workspace; discard it as its parent.",
        );
      const result = yield* ownerEnded(record.ownerLease, effect);
      if (Option.isNone(result))
        return yield* workspaceFailure(
          "authorization",
          "The session that created this workspace is still running.",
        );
      return result.value;
    });
  // An orphan's creating session has ended (its owner lease is free); the caller separately
  // proves no writer still holds the worker tree.
  const discardOrphan = Effect.fn("GitWorkspaceEngine.discardOrphan")(function* (
    target: WorkspaceOrphanTarget,
  ) {
    const record = yield* managedRecord(target.workspaceId);
    yield* whileOwnerEnded(
      record,
      Effect.gen(function* () {
        // Until the rollback succeeds the record stays mid-integration.
        if (record.status === "integrating")
          yield* rollbackIntegration(record, workspaceArtifact(registry, record));
        yield* removeWorkspaceTrees(registry, record, {
          requireOriginalWorker: true,
          beforeRemove,
        });
        yield* saveWorkspaceRecord(registry, { ...record, status: "discarded" });
      }),
    );
    return undefined;
  }, locked);
  // Hands an orphan's ownership to this session: the record names the new owner and this
  // engine's owner lease, so a later session can again prove this one ended. Adopting a
  // workspace this session already adopted for the same owner returns it again.
  const adopt = Effect.fn("GitWorkspaceEngine.adopt")(function* (target: WorkspaceAdoptTarget) {
    const record = yield* managedRecord(target.workspaceId);
    if (owned.has(target.workspaceId)) {
      if (record.handle.ownerId === target.ownerId) return record.handle;
      return yield* workspaceFailure(
        "authorization",
        "This session already owns the workspace under another parent.",
      );
    }
    if (!OPEN_WORKSPACE_STATUSES.has(record.status))
      return yield* workspaceRefusal(
        "adopt",
        record.status === "integrating"
          ? "The orphan was left mid-integration; it can only be discarded."
          : "The orphan has no open worker tree to take over.",
        {
          path: path.join(workspaceArtifact(registry, record), "record.json"),
          rule: "only an active, frozen, or prepared orphan can be adopted",
          remedy:
            record.status === "integrating"
              ? "Discard it to roll the published files back."
              : "Start a new writer instead.",
        },
      );
    const ownerLease = yield* engine.ownerPresence;
    return yield* whileOwnerEnded(
      record,
      Effect.gen(function* () {
        yield* requireOriginalWorker(record, "takeover");
        const handle: WorkspaceHandle = { ...record.handle, ownerId: target.ownerId };
        yield* saveWorkspaceRecord(registry, { ...record, handle, ownerLease }, () => {
          owned.add(target.workspaceId);
        });
        return handle;
      }),
    );
  }, locked);
  // Unfinished records another session created whose owner lease is free right now.
  const endedOwners = (records: ReadonlyArray<WorkspaceRecord>) =>
    Effect.forEach(records, (record) =>
      owned.has(record.handle.workspaceId) ||
      record.status === "integrated" ||
      record.status === "discarded"
        ? Effect.succeed([])
        : ownerEnded(record.ownerLease, Effect.void).pipe(
            Effect.map((free) => (Option.isSome(free) ? [record.handle.workspaceId] : [])),
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
          ),
    ).pipe(Effect.map((ids) => ids.flat()));
  /**
   * Records the orphan sweep may discard. A plain candidate scan: `sweepOrphan` rechecks each one
   * under its checkout's lock and owner lease.
   */
  const sweepCandidates = (input: { readonly minimumAgeMillis: number }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const { records } = yield* listWorkspaceRecords(registry);
      return records.filter(
        (record) =>
          !owned.has(record.handle.workspaceId) &&
          OPEN_WORKSPACE_STATUSES.has(record.status) &&
          oldEnough(record, now, input.minimumAgeMillis),
      );
    });
  /**
   * Discards an orphan unchanged for `minimumAgeMillis`, keeping its worker's changes as the
   * revision patch beside the record until collection removes both. Returns undefined, changing
   * nothing, for a record takeover would refuse or one that changed meanwhile. The caller holds
   * the original writer lease.
   */
  const sweepOrphan = Effect.fn("GitWorkspaceEngine.sweepOrphan")(function* (
    target: WorkspaceSweepTarget,
  ) {
    const record = yield* managedRecord(target.workspaceId);
    const now = yield* Clock.currentTimeMillis;
    if (
      owned.has(target.workspaceId) ||
      !OPEN_WORKSPACE_STATUSES.has(record.status) ||
      !oldEnough(record, now, target.minimumAgeMillis)
    )
      return undefined;
    const swept = yield* ownerEnded(
      record.ownerLease,
      Effect.gen(function* () {
        yield* requireOriginalWorker(record, "sweep");
        const frozen = record.revision;
        const current =
          frozen !== undefined &&
          (yield* engine.workerTree(record)) ===
            (yield* treeOf(record.repository, frozen.revisionId));
        // A frozen revision the worker still matches keeps its patch; otherwise the worker's
        // changes are frozen anew.
        const kept = current ? record : yield* engine.freezeAnew(record);
        yield* removeWorkspaceTrees(registry, kept, {
          requireOriginalWorker: true,
          beforeRemove,
        });
        yield* saveWorkspaceRecord(registry, {
          ...kept,
          status: "discarded",
          disposition: "orphan-swept",
        });
        return {
          workspaceId: target.workspaceId,
          sourceRoot: record.handle.sourceRoot,
          changedPathCount: kept.revision?.changedPaths.length ?? 0,
          patchPath: revisionDiffFile(registry, target.workspaceId),
        } satisfies WorkspaceSwept;
      }),
    );
    return Option.getOrUndefined(swept);
  }, locked);
  return { discardOrphan, adopt, endedOwners, sweepCandidates, sweepOrphan };
};
