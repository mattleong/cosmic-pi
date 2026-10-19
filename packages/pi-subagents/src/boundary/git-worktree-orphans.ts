import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { CrossProcessLockContract, SafeFile } from "pi-cosmic-core";
import { workspaceCheckoutRoot } from "../workspace/model.ts";
import type {
  WorkspaceAdoptTarget,
  WorkspaceError,
  WorkspaceHandle,
  WorkspaceOrphanDiscardTarget,
  WorkspaceOrphanTarget,
  WorkspaceRecord,
  WorkspaceSweepTarget,
  WorkspaceSwept,
} from "../workspace/model.ts";
import { nodePath as path } from "./node-builtins.ts";
import { canonicalizeWriterDirectory } from "./writer-lease.ts";
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
  MAX_WORKSPACE_NESTING,
  removeWorkspaceTrees,
  unresolvedChildWorkspaces,
} from "./git-worktree-recovery.ts";
import { rollbackPublication } from "./git-worktree-integration.ts";

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
  readonly refuseWithChildren: (
    record: WorkspaceRecord,
  ) => Effect.Effect<undefined, WorkspaceError, SafeFile>;
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

// Statuses whose worker tree an adopting session or the orphan sweep can take over as they are.
const openStatuses: ReadonlySet<WorkspaceRecord["status"]> = new Set([
  "active",
  "frozen",
  "prepared",
]);

// Rechecked at the worker path itself while the caller holds the original writer lease.
const requireOriginalWorker = (record: WorkspaceRecord, operation: string) =>
  Effect.gen(function* () {
    const refusal = () =>
      workspaceRefusal(operation, "The original worker directory changed; takeover is unsafe.", {
        path: record.handle.cwd,
        rule: "an orphan's worker path must still name its original writer-directory identity",
        remedy:
          "Preserve both trees and the recovery record. Independently confirm every writer and descendant has stopped, then recover the artifact manually.",
      });
    const original = record.handle.writerCwd;
    if (!original) return yield* refusal();
    const current = yield* canonicalizeWriterDirectory(record.handle.cwd).pipe(
      Effect.mapError(refusal),
    );
    if (current.filesystemIdentity !== original.filesystemIdentity) return yield* refusal();
    return undefined;
  });

const oldEnough = (record: WorkspaceRecord, now: number, minimumAgeMillis: number) =>
  now - record.lastChangedAt >= minimumAgeMillis;

// How many source-workspace links separate a record from its real checkout.
const sourceDepth = (record: WorkspaceRecord, listed: ReadonlyMap<string, WorkspaceRecord>) => {
  let depth = 0;
  for (
    let link = record.handle.sourceWorkspaceId;
    link !== undefined && depth <= MAX_WORKSPACE_NESTING;
    link = listed.get(link)?.handle.sourceWorkspaceId
  )
    depth += 1;
  return depth;
};

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
    target: WorkspaceOrphanDiscardTarget,
  ) {
    const record = yield* managedRecord(target.workspaceId);
    // Rolling back needs fresh writer leases on the publication's directories, which only the
    // caller can take: the integrating session's leases ended with it.
    if (record.status === "integrating" && target.sourceLeasesHeld !== true)
      return yield* workspaceRefusal(
        "discard",
        "The workspace was left mid-integration by a session that has ended.",
        {
          path: path.join(workspaceArtifact(registry, record), "record.json"),
          rule: "rolling back another session's integration needs fresh writer leases on the parent checkout's directories it published into",
          remedy:
            "Discard it from the root session of its checkout, which takes those leases, or compare the journal's paths with the parent checkout, restore each file from its backup (paths relative to the source root) or keep the published content, delete the backup and temporary files, then remove the private workspace directory.",
        },
      );
    yield* engine.refuseWithChildren(record);
    yield* whileOwnerEnded(
      record,
      Effect.gen(function* () {
        // Until the rollback succeeds the record stays mid-integration.
        if (record.status === "integrating") yield* rollbackPublication(registry, record);
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
    if (record.handle.sourceWorkspaceId !== undefined)
      return yield* workspaceRefusal("adopt", "A nested orphan can only be discarded.", {
        path: record.handle.cwd,
        rule: "a nested workspace integrates into its source workspace's worker tree, which only the writer that started it could resolve",
        remedy: "Discard it, children before their parent, then adopt the source workspace.",
      });
    if (!openStatuses.has(record.status))
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
    yield* engine.refuseWithChildren(record);
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
   * Records the orphan sweep may discard, children before their source workspaces so a pass can
   * resolve a whole chain. A plain candidate scan: `sweepOrphan` rechecks each one under its
   * checkout's lock and owner lease.
   */
  const sweepCandidates = (input: { readonly minimumAgeMillis: number }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const { records } = yield* listWorkspaceRecords(registry);
      const listed = new Map(records.map((record) => [record.handle.workspaceId, record]));
      const candidates: WorkspaceRecord[] = [];
      for (const record of records)
        if (
          !owned.has(record.handle.workspaceId) &&
          openStatuses.has(record.status) &&
          record.hookCleanupPending === undefined &&
          oldEnough(record, now, input.minimumAgeMillis)
        )
          candidates.push(record);
      return candidates.toSorted(
        (left, right) => sourceDepth(right, listed) - sourceDepth(left, listed),
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
      !openStatuses.has(record.status) ||
      !oldEnough(record, now, target.minimumAgeMillis) ||
      (yield* unresolvedChildWorkspaces(registry, target.workspaceId)).length > 0
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
          sourceRoot: workspaceCheckoutRoot(record.handle),
          changedPathCount: kept.revision?.changedPaths.length ?? 0,
          patchPath: revisionDiffFile(registry, target.workspaceId),
        } satisfies WorkspaceSwept;
      }),
    );
    return Option.getOrUndefined(swept);
  }, locked);
  return { discardOrphan, adopt, endedOwners, sweepCandidates, sweepOrphan };
};
