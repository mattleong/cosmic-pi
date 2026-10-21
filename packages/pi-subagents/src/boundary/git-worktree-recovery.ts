import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SafeFile } from "pi-cosmic-core";
import {
  isOriginalWorker,
  type UnavailableWorkspaceArtifact,
  type WorkspaceError,
  type WorkspaceRecord,
} from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import { deleteWorkspaceRefs } from "./git-capture.ts";
import { listedWorkspaceTrees, removeWorkspaceTree } from "./git-worktree-trees.ts";
import type { BeforeTreeRemoval } from "./git-worktree-hooks.ts";
import {
  checkDirectory,
  isSharedOrForeign,
  workspaceFailure,
  workspaceIO,
  workspaceIOIfPresent,
  workspaceRefusal,
} from "./git-worktree-process.ts";
import { canonicalizeWriterDirectory } from "./writer-lease.ts";
import {
  readWorkspaceRecord,
  saveWorkspaceRecord,
  syncWorkspaceDirectory,
  validWorkspaceId,
  workspaceDirectory,
} from "./git-worktree-store.ts";

/**
 * Refuses unless the worker path still names its original writer-directory identity. The caller
 * holds the original writer lease, so a matching identity proves no writer is left there.
 */
export const requireOriginalWorker = (record: WorkspaceRecord, operation: string) =>
  Effect.gen(function* () {
    const refusal = () =>
      workspaceRefusal(
        operation,
        `The original worker directory changed; ${operation} is unsafe.`,
        {
          path: record.handle.cwd,
          rule: "an orphan's worker path must still name its original writer-directory identity",
          remedy:
            "Preserve both trees and the recovery record. Independently confirm every writer and descendant has stopped, then recover the artifact manually.",
        },
      );
    if (record.handle.writerCwd === undefined) return yield* refusal();
    const current = yield* canonicalizeWriterDirectory(record.handle.cwd).pipe(
      Effect.mapError(refusal),
    );
    if (!isOriginalWorker(record.handle, current)) return yield* refusal();
    return undefined;
  });

const editableTreeName = (name: string) =>
  name === "worker" || /^prepare-[a-f0-9-]{36}$/u.test(name);

/**
 * Removes the workspace's linked worktrees (prepared trees first, then the worker), Git's entries
 * for them, and its refs. Proves the removal complete. `beforeRemove` runs before each removal and
 * keeps the tree when it fails.
 */
export const removeWorkspaceTrees = (
  registry: string,
  record: WorkspaceRecord,
  options: {
    readonly requireOriginalWorker?: boolean;
    readonly beforeRemove?: BeforeTreeRemoval | undefined;
  } = {},
) =>
  Effect.gen(function* () {
    const directory = workspaceDirectory(registry, record.handle.workspaceId);
    const worker = path.join(directory, "worker");
    const remaining = Effect.gen(function* () {
      const listed = yield* listedWorkspaceTrees(registry, record);
      const names = yield* workspaceIO("discard", () => fs.readdir(directory));
      const trees = [
        ...new Set([
          ...listed.map((tree) => tree.path),
          ...names.filter(editableTreeName).map((name) => path.join(directory, name)),
        ]),
      ];
      return { listed, trees };
    });
    const { listed, trees } = yield* remaining;
    // Keep the worker available for identity checks until every preparation is gone.
    for (const tree of trees.toSorted(
      (left, right) => Number(left === worker) - Number(right === worker),
    )) {
      // Service, source-lock, and owner-lease checks can all wait. Revalidate at removal,
      // not merely before entering the engine, while the original writer lease is held.
      if (options.requireOriginalWorker) yield* requireOriginalWorker(record, "discard");
      if (options.beforeRemove) yield* options.beforeRemove(record, tree);
      yield* removeWorkspaceTree(registry, record, tree, listed);
    }
    if ((yield* remaining).trees.length > 0)
      return yield* workspaceFailure(
        "recovery",
        "Editable workspace trees remain; discard is incomplete.",
      );
    yield* deleteWorkspaceRefs(record.repository, record.handle.workspaceId);
    return undefined;
  });

const inspectRegistry = (registry: string) =>
  Effect.gen(function* () {
    yield* checkDirectory(registry, true);
    const stat = yield* workspaceIOIfPresent("registry", () => fs.lstat(registry));
    if (!stat) return undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink() || isSharedOrForeign(stat))
      return yield* workspaceFailure(
        "registry",
        "Workspace registry path or permissions are invalid.",
      );
    return stat;
  });

export const listWorkspaceRecords = (registry: string) =>
  Effect.gen(function* () {
    const records: WorkspaceRecord[] = [];
    const unavailable: UnavailableWorkspaceArtifact[] = [];
    const before = yield* inspectRegistry(registry);
    if (!before) return { records, unavailable };
    const names = yield* workspaceIO("registry", () => fs.readdir(registry));
    for (const workspaceId of names.filter(validWorkspaceId).toSorted()) {
      const record = yield* readWorkspaceRecord(registry, workspaceId).pipe(
        Effect.catchTag("WorkspaceError", () => Effect.void),
      );
      if (record) records.push(record);
      else
        unavailable.push({
          workspaceId,
          status: "unavailable",
          reason: "recovery-record-unavailable",
        });
    }
    const after = yield* inspectRegistry(registry);
    if (!after || before.dev !== after.dev || before.ino !== after.ino)
      return yield* workspaceFailure("registry", "Workspace registry changed during listing.");
    return { records, unavailable };
  });

const finished = (record: WorkspaceRecord) =>
  record.status === "discarded" || record.status === "integrated";

/** Discarded and integrated records stay this long for inspection, like delivered reports. */
const WORKSPACE_RECORD_RETENTION = Duration.days(7);

const COLLECTED_PREFIX = ".collected-";

// Renaming first keeps a half-removed directory out of every listing.
const removeCollected = (registry: string, workspaceId: string) =>
  Effect.gen(function* () {
    const retired = path.join(registry, `${COLLECTED_PREFIX}${workspaceId}`);
    yield* Effect.gen(function* () {
      yield* workspaceIO("collect", () =>
        fs.rename(workspaceDirectory(registry, workspaceId), retired),
      );
      yield* syncWorkspaceDirectory(registry);
    }).pipe(Effect.uninterruptible);
    yield* workspaceIO("collect", () => fs.rm(retired, { recursive: true, force: true }));
  });

const collectRecord = (registry: string, workspaceId: string, now: number) =>
  Effect.gen(function* () {
    const record = yield* readWorkspaceRecord(registry, workspaceId);
    if (!finished(record)) return false;
    const directory = workspaceDirectory(registry, workspaceId);
    yield* checkDirectory(directory);
    const saved = yield* workspaceIO("collect", () => fs.stat(path.join(directory, "record.json")));
    if (now - saved.mtimeMs < Duration.toMillis(WORKSPACE_RECORD_RETENTION)) return false;
    const names = yield* workspaceIO("collect", () => fs.readdir(directory));
    if (names.some(editableTreeName)) return false;
    // Discard already deleted them; a repository that is gone has none left to delete.
    yield* deleteWorkspaceRefs(record.repository, workspaceId).pipe(Effect.ignore);
    yield* removeCollected(registry, workspaceId);
    return true;
  });

interface WorkspaceCollection {
  readonly now: number;
  /** Records this session still owns are never collected. */
  readonly owned: (workspaceId: string) => boolean;
  /** Runs under the source checkout's lock, or returns none while another session holds it. */
  readonly whenSourceFree: (
    sourceRoot: string,
    effect: Effect.Effect<boolean, WorkspaceError, SafeFile>,
  ) => Effect.Effect<Option.Option<boolean>, WorkspaceError, SafeFile>;
  /** Runs while holding the free owner lease, or returns none while its session still runs. */
  readonly whenOwnerEnded: (
    ownerLease: string,
    effect: Effect.Effect<boolean, WorkspaceError, SafeFile>,
  ) => Effect.Effect<Option.Option<boolean>, WorkspaceError, SafeFile>;
  /** Runs before each retained tree's removal (the WorktreeRemove hooks). */
  readonly beforeRemove?: BeforeTreeRemoval | undefined;
}

// A create that crashed after adding its worker left a locked worktree in the user's repository
// that no run was ever given; once its session has provably ended, its trees and refs go.
const abandonCreate = (registry: string, workspaceId: string, collection: WorkspaceCollection) =>
  Effect.gen(function* () {
    const record = yield* readWorkspaceRecord(registry, workspaceId);
    if (record.status !== "creating") return false;
    const removed = yield* collection.whenOwnerEnded(
      record.ownerLease,
      Effect.gen(function* () {
        yield* removeWorkspaceTrees(registry, record);
        yield* saveWorkspaceRecord(registry, { ...record, status: "discarded" });
        return false;
      }),
    );
    return Option.getOrElse(removed, () => false);
  });

const hasEditableTree = (registry: string, workspaceId: string) =>
  workspaceIOIfPresent("collect", () => fs.readdir(workspaceDirectory(registry, workspaceId))).pipe(
    Effect.map((names) => (names ?? []).some(editableTreeName)),
  );

// Integration keeps trees a run still uses. Once its session has provably ended, so no run can
// still use them, its trees and refs go; the record stays for collection.
const removeRetainedTrees = (
  registry: string,
  workspaceId: string,
  collection: WorkspaceCollection,
) =>
  Effect.gen(function* () {
    const record = yield* readWorkspaceRecord(registry, workspaceId);
    // A hook whose cleanup is unconfirmed quarantines the trees until manual recovery.
    if (!finished(record) || record.hookCleanupPending !== undefined) return false;
    yield* checkDirectory(workspaceDirectory(registry, workspaceId));
    if (!(yield* hasEditableTree(registry, workspaceId))) return false;
    const removed = yield* collection.whenOwnerEnded(
      record.ownerLease,
      removeWorkspaceTrees(registry, record, { beforeRemove: collection.beforeRemove }).pipe(
        Effect.as(true),
      ),
    );
    return Option.getOrElse(removed, () => false);
  });

/**
 * Deletes discarded and integrated records once they are a week old, unless an editable tree
 * remains, and discards creates whose session ended before they finished. Trees integration kept
 * go first, once nothing can still use them. Unreadable artifacts are never touched.
 */
export const collectWorkspaceRecords = (registry: string, collection: WorkspaceCollection) =>
  Effect.gen(function* () {
    const { records } = yield* listWorkspaceRecords(registry);
    const collected: string[] = [];
    for (const record of records) {
      const workspaceId = record.handle.workspaceId;
      if (record.status === "creating" && !collection.owned(workspaceId))
        yield* collection
          .whenSourceFree(
            record.handle.sourceRoot,
            abandonCreate(registry, workspaceId, collection),
          )
          .pipe(
            Effect.catchTag("WorkspaceError", (error) =>
              Effect.logWarning(`Abandoned workspace was not removed: ${error.message}`).pipe(
                Effect.annotateLogs("workspaceId", workspaceId),
              ),
            ),
          );
      if (!finished(record) || collection.owned(workspaceId)) continue;
      if (yield* hasEditableTree(registry, workspaceId).pipe(Effect.orElseSucceed(() => false)))
        yield* collection
          .whenSourceFree(
            record.handle.sourceRoot,
            removeRetainedTrees(registry, workspaceId, collection),
          )
          .pipe(
            Effect.catchTag("WorkspaceError", (error) =>
              Effect.logWarning(`Retained workspace trees were not removed: ${error.message}`).pipe(
                Effect.annotateLogs("workspaceId", workspaceId),
              ),
            ),
          );
      const removed = yield* collection
        .whenSourceFree(
          record.handle.sourceRoot,
          collectRecord(registry, workspaceId, collection.now),
        )
        .pipe(
          Effect.catchTag("WorkspaceError", (error) =>
            Effect.logWarning(`Workspace record was not collected: ${error.message}`).pipe(
              Effect.annotateLogs("workspaceId", workspaceId),
              Effect.as(Option.none<boolean>()),
            ),
          ),
        );
      if (Option.getOrElse(removed, () => false)) collected.push(workspaceId);
    }
    const names = yield* workspaceIOIfPresent("collect", () => fs.readdir(registry));
    for (const name of names ?? [])
      if (name.startsWith(COLLECTED_PREFIX))
        yield* workspaceIO("collect", () =>
          fs.rm(path.join(registry, name), { recursive: true, force: true }),
        );
    return collected;
  });
