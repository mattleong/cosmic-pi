import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SafeFile } from "pi-cosmic-core";
import {
  workspaceCheckoutRoot,
  type UnavailableWorkspaceArtifact,
  type WorkspaceError,
  type WorkspaceRecord,
} from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import { deleteWorkspaceRefs } from "./git-capture.ts";
import { listedWorkspaceTrees, removeWorkspaceTree } from "./git-worktree-trees.ts";
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

const editableTreeName = (name: string) =>
  name === "worker" || /^prepare-[a-f0-9-]{36}$/u.test(name);

/**
 * Removes the workspace's linked worktrees (prepared trees first, then the worker unless kept)
 * and Git's entries for them; with the worker gone, its refs go too. Proves the removal complete.
 */
export const removeWorkspaceTrees = (
  registry: string,
  record: WorkspaceRecord,
  options: { readonly keepWorker?: boolean; readonly requireOriginalWorker?: boolean } = {},
) =>
  Effect.gen(function* () {
    const directory = workspaceDirectory(registry, record.handle.workspaceId);
    const worker = path.join(directory, "worker");
    const kept = (tree: string) => tree === worker && options.keepWorker === true;
    const remaining = Effect.gen(function* () {
      const listed = yield* listedWorkspaceTrees(registry, record);
      const names = yield* workspaceIO("discard", () => fs.readdir(directory));
      const trees = [
        ...new Set([
          ...listed.map((tree) => tree.path),
          ...names.filter(editableTreeName).map((name) => path.join(directory, name)),
        ]),
      ].filter((tree) => !kept(tree));
      return { listed, trees };
    });
    const { listed, trees } = yield* remaining;
    // Keep the worker available for identity checks until every preparation is gone.
    for (const tree of trees.toSorted(
      (left, right) => Number(left === worker) - Number(right === worker),
    )) {
      if (options.requireOriginalWorker) {
        const refusal = () =>
          workspaceRefusal("discard", "The original worker directory changed; discard is unsafe.", {
            path: record.handle.cwd,
            rule: "orphan cleanup must still name the original writer-directory identity",
            remedy:
              "Preserve both trees and the recovery record. Independently confirm every writer and descendant has stopped, then recover the artifact manually.",
          });
        const original = record.handle.writerCwd;
        if (!original) return yield* refusal();
        // Service, source-lock, and owner-lease checks can all wait. Revalidate at removal,
        // not merely before entering the engine, while the original writer lease is held.
        const current = yield* canonicalizeWriterDirectory(record.handle.cwd).pipe(
          Effect.mapError(refusal),
        );
        if (current.filesystemIdentity !== original.filesystemIdentity) return yield* refusal();
      }
      yield* removeWorkspaceTree(registry, record, tree, listed);
    }
    if ((yield* remaining).trees.length > 0)
      return yield* workspaceFailure(
        "recovery",
        "Editable workspace trees remain; discard is incomplete.",
      );
    if (!options.keepWorker)
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

/** The most source-workspace links between a nested workspace and its real checkout. */
export const MAX_WORKSPACE_NESTING = 8;

export const workerTree = (registry: string, workspaceId: string) =>
  path.join(workspaceDirectory(registry, workspaceId), "worker");

// Each link must name a listed record whose worker tree is the child's source, and the chain must
// end at the real checkout the record names, so a nested record is attributed to its checkout.
const sourceChainResolves = (
  registry: string,
  record: WorkspaceRecord,
  listed: ReadonlyMap<string, WorkspaceRecord>,
) => {
  let current = record;
  for (let links = 0; links <= MAX_WORKSPACE_NESTING; links += 1) {
    const sourceId = current.handle.sourceWorkspaceId;
    if (sourceId === undefined)
      return links === 0 || current.handle.sourceRoot === record.handle.checkoutRoot;
    const source = listed.get(sourceId);
    if (!source || current.handle.sourceRoot !== workerTree(registry, sourceId)) return false;
    current = source;
  }
  return false;
};

export const listWorkspaceRecords = (registry: string) =>
  Effect.gen(function* () {
    const read: WorkspaceRecord[] = [];
    const unavailable: UnavailableWorkspaceArtifact[] = [];
    const before = yield* inspectRegistry(registry);
    if (!before) return { records: read, unavailable };
    const names = yield* workspaceIO("registry", () => fs.readdir(registry));
    for (const workspaceId of names.filter(validWorkspaceId).toSorted()) {
      const record = yield* readWorkspaceRecord(registry, workspaceId).pipe(
        Effect.catchTag("WorkspaceError", () => Effect.void),
      );
      if (record) read.push(record);
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
    const listed = new Map(read.map((record) => [record.handle.workspaceId, record]));
    const records: WorkspaceRecord[] = [];
    for (const record of read)
      if (sourceChainResolves(registry, record, listed)) records.push(record);
      else
        unavailable.push({
          workspaceId: record.handle.workspaceId,
          status: "unavailable",
          reason: "source-workspace-unavailable",
        });
    return { records, unavailable };
  });

const finished = (record: WorkspaceRecord) =>
  record.status === "discarded" || record.status === "integrated";

/**
 * Workspaces created from `workspaceId`'s worker tree that are neither integrated nor discarded.
 * A plain scan of the small records, without listing's registry revalidation or source-chain
 * resolution, because the coordinator runs it under its run lock. Unreadable records grant nothing
 * and block nothing here; listing reports them separately.
 */
export const unresolvedChildWorkspaces = (registry: string, workspaceId: string) =>
  Effect.gen(function* () {
    const names = yield* workspaceIOIfPresent("registry", () => fs.readdir(registry));
    const children: string[] = [];
    for (const name of (names ?? []).filter(validWorkspaceId).toSorted()) {
      if (name === workspaceId) continue;
      const record = yield* readWorkspaceRecord(registry, name).pipe(
        Effect.catchTag("WorkspaceError", () => Effect.void),
      );
      if (record?.handle.sourceWorkspaceId === workspaceId && !finished(record))
        children.push(name);
    }
    return children;
  });

/** Discarded and integrated records stay this long for inspection, like delivered reports. */
const WORKSPACE_RECORD_RETENTION = Duration.days(7);

const COLLECTED_PREFIX = ".collected-";

// A nested workspace names its source workspace, whose record its listing attribution needs until
// the nested record is collected too.
const references = (record: WorkspaceRecord) =>
  record.handle.sourceWorkspaceId === undefined ? [] : [record.handle.sourceWorkspaceId];

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
    // Nested creation holds this checkout's lock too. The pre-lock listing is only a candidate
    // scan: a nested writer may have persisted a new reference meanwhile.
    const current = yield* listWorkspaceRecords(registry);
    if (
      current.unavailable.length > 0 ||
      current.records.some((entry) => references(entry).includes(workspaceId))
    )
      return false;
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

export interface WorkspaceCollection {
  readonly now: number;
  /** Records this session still owns are never collected. */
  readonly owned: (workspaceId: string) => boolean;
  /** Runs under the real checkout's lock, or returns none while another session holds it. */
  readonly whenSourceFree: (
    checkoutRoot: string,
    effect: Effect.Effect<boolean, WorkspaceError, SafeFile>,
  ) => Effect.Effect<Option.Option<boolean>, WorkspaceError, SafeFile>;
  /** Runs while holding the free owner lease, or returns none while its session still runs. */
  readonly whenOwnerEnded: (
    ownerLease: string,
    effect: Effect.Effect<boolean, WorkspaceError, SafeFile>,
  ) => Effect.Effect<Option.Option<boolean>, WorkspaceError, SafeFile>;
}

// A create that crashed after adding its worker left a locked worktree in the user's repository
// that no run was ever given; once its session has provably ended, its trees and refs go.
const abandonCreate = (registry: string, workspaceId: string, collection: WorkspaceCollection) =>
  Effect.gen(function* () {
    const record = yield* readWorkspaceRecord(registry, workspaceId);
    if (record.status !== "creating" || record.ownerLease === undefined) return false;
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

// Integration keeps trees a run still uses and a worker its unresolved children were created from.
// Once every workspace created from it is resolved and its session has provably ended, so no run
// can still use them, its trees and refs go; the record stays for collection.
const removeRetainedTrees = (
  registry: string,
  workspaceId: string,
  collection: WorkspaceCollection,
) =>
  Effect.gen(function* () {
    const record = yield* readWorkspaceRecord(registry, workspaceId);
    if (!finished(record) || record.ownerLease === undefined) return false;
    yield* checkDirectory(workspaceDirectory(registry, workspaceId));
    if (!(yield* hasEditableTree(registry, workspaceId))) return false;
    // Rechecked under the checkout's lock; an unreadable record might be an unresolved child.
    const current = yield* listWorkspaceRecords(registry);
    if (
      current.unavailable.length > 0 ||
      current.records.some(
        (entry) => entry.handle.sourceWorkspaceId === workspaceId && !finished(entry),
      )
    )
      return false;
    const removed = yield* collection.whenOwnerEnded(
      record.ownerLease,
      removeWorkspaceTrees(registry, record).pipe(Effect.as(true)),
    );
    return Option.getOrElse(removed, () => false);
  });

/**
 * Deletes discarded and integrated records once they are a week old, unless an editable tree
 * remains or a nested workspace names it as its source, and discards creates whose session ended
 * before they finished. Trees integration kept go first, once nothing can still use them.
 * Unreadable artifacts are never touched.
 */
export const collectWorkspaceRecords = (registry: string, collection: WorkspaceCollection) =>
  Effect.gen(function* () {
    const { records } = yield* listWorkspaceRecords(registry);
    const referenced = new Set(records.flatMap(references));
    const collected: string[] = [];
    for (const record of records) {
      const workspaceId = record.handle.workspaceId;
      if (record.status === "creating" && !collection.owned(workspaceId))
        yield* collection
          .whenSourceFree(
            workspaceCheckoutRoot(record.handle),
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
            workspaceCheckoutRoot(record.handle),
            removeRetainedTrees(registry, workspaceId, collection),
          )
          .pipe(
            Effect.catchTag("WorkspaceError", (error) =>
              Effect.logWarning(`Retained workspace trees were not removed: ${error.message}`).pipe(
                Effect.annotateLogs("workspaceId", workspaceId),
              ),
            ),
          );
      if (referenced.has(workspaceId)) continue;
      const removed = yield* collection
        .whenSourceFree(
          workspaceCheckoutRoot(record.handle),
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
