import * as Effect from "effect/Effect";
import type { WorkspacePreparation, WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import { nodeErrorCode } from "./harness-shared.ts";
import {
  checkDirectory,
  isSharedOrForeign,
  workspaceFailure,
  workspaceIO,
  workspaceIOIfPresent,
} from "./git-worktree-process.ts";
import {
  createWorkspaceDirectory,
  publishWorkspaceFile,
  removeEmptyWorkspaceDirectory,
  removeWorkspaceBackups,
  type WorkspaceBackupRemovalRequest,
  type WorkspaceDirectoryRemovalRequest,
} from "./git-worktree-publish.ts";
import {
  publicationBackupPrefix,
  publicationTemporaryPrefix,
} from "./git-worktree-publish-helper.ts";
import {
  readWorkspaceFile,
  type SnapshotEntry,
  type WorkspaceSnapshot,
} from "./git-worktree-snapshot.ts";
import { newWorkspaceId, saveWorkspaceRecord } from "./git-worktree-store.ts";

const directoryIdentity = (directory: string) =>
  Effect.gen(function* () {
    yield* checkDirectory(directory);
    const stat = yield* workspaceIO("integrate", () => fs.lstat(directory));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return yield* workspaceFailure("integrate", "Publication directory changed.");
    return { directoryDev: stat.dev, directoryIno: stat.ino };
  });
const checkPreimage = (root: string, name: string, expected: SnapshotEntry | undefined) =>
  Effect.gen(function* () {
    const visible = yield* readWorkspaceFile(root, name);
    if (
      (visible === undefined) !== (expected === undefined) ||
      (visible &&
        expected &&
        (visible.mode !== expected.mode ||
          visible.permissions !== expected.permissions ||
          Buffer.compare(visible.bytes, expected.bytes) !== 0))
    )
      return yield* workspaceFailure(
        "integrate",
        "Source preimage changed; publication stopped and recovery artifacts retained.",
      );
    return undefined;
  });

export const requiredLeaseDirectories = (
  record: WorkspaceRecord,
  changedPaths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const directories = new Set([record.handle.sourceRoot, record.handle.sourceCwd]);
    for (const name of changedPaths) {
      let directory = record.handle.sourceRoot;
      for (const part of path
        .dirname(name)
        .split(path.sep)
        .filter((segment) => segment !== ".")) {
        directory = path.join(directory, part);
        const stat = yield* workspaceIOIfPresent("prepare", () => fs.lstat(directory));
        if (!stat) break;
        if (!stat.isDirectory() || stat.isSymbolicLink())
          return yield* workspaceFailure(
            "prepare",
            "Changed-file ancestor is not a real directory.",
          );
        yield* checkDirectory(directory);
        directories.add(directory);
      }
    }
    return [...directories].toSorted();
  });

type SnapshotEntries = ReadonlyMap<string, SnapshotEntry>;
type DirectoryIdentity = Effect.Success<ReturnType<typeof directoryIdentity>>;

// The helper starts once per file, directory and backup group. Its transpile cache lives in the
// private registry rather than jiti's shared tmpdir default, and is only an optimization.
const publicationHelperCache = (registry: string) =>
  Effect.gen(function* () {
    const cache = path.join(registry, "publication-cache");
    yield* workspaceIO("integrate", () =>
      fs.mkdir(cache, { mode: 0o700 }).catch((cause: unknown) => {
        if (nodeErrorCode(cause) !== "EEXIST") throw cause;
      }),
    );
    const stat = yield* workspaceIO("integrate", () => fs.lstat(cache));
    return stat.isDirectory() && !isSharedOrForeign(stat) ? cache : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));

// Ancestors of deleted files, deepest first, that publication may remove once they are empty, as
// `git apply` would. The source root and the session's cwd and its ancestors always stay.
const emptiedDirectoryCandidates = (
  record: WorkspaceRecord,
  deleted: ReadonlyArray<string>,
  directories: ReadonlyMap<string, DirectoryIdentity>,
  helperCache: string | undefined,
) => {
  const { sourceRoot, sourceCwd } = record.handle;
  const candidates = new Map<string, WorkspaceDirectoryRemovalRequest>();
  for (const name of deleted)
    for (let parent = path.dirname(name); parent !== "."; parent = path.dirname(parent)) {
      const full = path.join(sourceRoot, parent);
      if (full === sourceCwd || sourceCwd.startsWith(`${full}${path.sep}`)) break;
      const target = directories.get(full);
      const anchor = directories.get(path.dirname(full));
      if (!target || !anchor) break;
      candidates.set(full, {
        directory: path.dirname(full),
        ...anchor,
        helperCache,
        name: path.basename(full),
        targetDev: target.directoryDev,
        targetIno: target.directoryIno,
      });
    }
  return [...candidates.entries()]
    .toSorted(([left], [right]) => right.split(path.sep).length - left.split(path.sep).length)
    .map(([, candidate]) => candidate);
};

const changedPaths = (previous: SnapshotEntries, next: SnapshotEntries) =>
  [...new Set([...previous.keys(), ...next.keys()])]
    .filter((name) => {
      const a = previous.get(name),
        b = next.get(name);
      return a?.oid !== b?.oid || a?.mode !== b?.mode;
    })
    .toSorted();

const publishedPermissions = (
  expected: SnapshotEntry | undefined,
  content: SnapshotEntry | undefined,
) => {
  if (!expected) return content?.mode === "100755" ? 0o755 : 0o644;
  if (expected.mode === content?.mode) return expected.permissions;
  return (expected.permissions & ~0o111) | (content?.mode === "100755" ? 0o111 : 0);
};

const checkAncestors = (
  root: string,
  name: string,
  leaseDirectories: ReadonlyArray<string>,
  directories: Map<string, DirectoryIdentity>,
  missingDirectories: Set<string>,
) =>
  Effect.gen(function* () {
    let parent = path.dirname(name);
    while (parent !== ".") {
      const full = path.join(root, parent);
      if (!(yield* workspaceIOIfPresent("integrate", () => fs.lstat(full))))
        missingDirectories.add(parent);
      else {
        if (!leaseDirectories.includes(full))
          return yield* workspaceFailure(
            "integrate",
            "Changed-file ancestors changed; prepare and test again before integration.",
          );
        if (!directories.has(full)) directories.set(full, yield* directoryIdentity(full));
      }
      parent = path.dirname(parent);
    }
    return undefined;
  });

const journalEntry = (
  name: string,
  expected: SnapshotEntry | undefined,
  content: SnapshotEntry | undefined,
) =>
  Effect.gen(function* () {
    const token = yield* newWorkspaceId;
    return {
      path: name,
      temporaryPath: path.join(path.dirname(name), `${publicationTemporaryPrefix}${token}`),
      backupPath: path.join(path.dirname(name), `${publicationBackupPrefix}${token}`),
      before: expected && {
        oid: expected.oid,
        mode: expected.mode,
        permissions: expected.permissions,
      },
      after: content && {
        oid: content.oid,
        mode: content.mode,
        permissions: publishedPermissions(expected, content),
      },
    };
  });

const createPlannedDirectories = (
  registry: string,
  journal: WorkspaceRecord,
  root: string,
  directories: Map<string, DirectoryIdentity>,
  helperCache: string | undefined,
) =>
  Effect.gen(function* () {
    let createdDirectoryCount = journal.createdDirectoryCount ?? 0;
    for (const name of journal.plannedDirectories ?? []) {
      const target = path.join(root, name),
        parent = path.dirname(target);
      const identity = directories.get(parent);
      if (!identity)
        return yield* workspaceFailure("integrate", "Missing parent directory ownership.");
      const created = yield* createWorkspaceDirectory({
        directory: parent,
        ...identity,
        helperCache,
        name: path.basename(target),
      });
      directories.set(target, created);
      createdDirectoryCount += 1;
      yield* saveWorkspaceRecord(registry, { ...journal, createdDirectoryCount });
    }
    return { ...journal, createdDirectoryCount };
  });

const publishEntries = (
  registry: string,
  journal: WorkspaceRecord,
  root: string,
  directories: ReadonlyMap<string, DirectoryIdentity>,
  previous: SnapshotEntries,
  next: SnapshotEntries,
  helperCache: string | undefined,
) =>
  Effect.gen(function* () {
    let publishedCount = journal.publishedCount ?? 0;
    const backups = new Map<string, WorkspaceBackupRemovalRequest>();
    for (const entry of journal.journal ?? []) {
      const directory = path.dirname(path.join(root, entry.path));
      const identity = directories.get(directory);
      if (!identity)
        return yield* workspaceFailure("integrate", "Missing publication directory ownership.");
      const expected = previous.get(entry.path),
        content = next.get(entry.path);
      const result = yield* publishWorkspaceFile({
        directory,
        ...identity,
        helperCache,
        name: path.basename(entry.path),
        temporaryName: path.basename(entry.temporaryPath),
        backupName: path.basename(entry.backupPath),
        ...(expected && { before: { bytes: expected.bytes, mode: expected.permissions } }),
        ...(content && {
          after: { bytes: content.bytes, mode: publishedPermissions(expected, content) },
        }),
      });
      if (result.status !== "success")
        return yield* workspaceFailure(
          "integrate",
          "Publication conflict or uncertainty; inspect the retained journal, backups and any temporary file. No automatic rollback occurred.",
        );
      if (expected)
        backups.set(directory, {
          directory,
          ...identity,
          helperCache,
          names: [...(backups.get(directory)?.names ?? []), path.basename(entry.backupPath)],
        });
      publishedCount += 1;
      yield* saveWorkspaceRecord(registry, { ...journal, publishedCount });
    }
    return { record: { ...journal, publishedCount }, backups: [...backups.values()] };
  });

/**
 * Deletes the preimage backups a publication left beside the files it replaced or deleted. Call it
 * only once the integration has committed: until then the backups are the manual recovery copy.
 * Returns the backup paths that remain.
 */
export const removePublicationBackups = (backups: ReadonlyArray<WorkspaceBackupRemovalRequest>) =>
  Effect.forEach(backups, (group) =>
    removeWorkspaceBackups(group).pipe(
      Effect.map((result) => result.retained),
      Effect.orElseSucceed(() => group.names),
      Effect.map((names) => names.map((name) => path.join(group.directory, name))),
    ),
  ).pipe(Effect.map((paths) => paths.flat()));

/**
 * Removes directories that deleting their last file left empty. Call it only once the integration
 * has committed and its backups are gone; a directory that isn't empty or can't be removed stays.
 */
export const removeEmptiedDirectories = (
  candidates: ReadonlyArray<WorkspaceDirectoryRemovalRequest>,
) =>
  Effect.forEach(
    candidates,
    (candidate) =>
      workspaceIOIfPresent("integrate", () =>
        fs.readdir(path.join(candidate.directory, candidate.name)),
      ).pipe(
        Effect.flatMap((names) =>
          names?.length === 0 ? removeEmptyWorkspaceDirectory(candidate) : Effect.void,
        ),
        Effect.ignore,
      ),
    { discard: true },
  );

export const publishWorkspace = (
  registry: string,
  record: WorkspaceRecord,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  preparation: Pick<WorkspacePreparation, "leaseDirectories">,
) =>
  Effect.gen(function* () {
    const previous = new Map(before.entries.map((entry) => [entry.path, entry]));
    const next = new Map(after.entries.map((entry) => [entry.path, entry]));
    const changed = changedPaths(previous, next);
    if (
      changed.some(
        (name) => previous.get(name)?.mode === "120000" || next.get(name)?.mode === "120000",
      )
    )
      return yield* workspaceFailure(
        "integrate",
        "Symlink changes cannot be published; source files were not modified.",
      );
    const root = record.handle.sourceRoot;
    const helperCache = yield* publicationHelperCache(registry);
    const directories = new Map([[root, yield* directoryIdentity(root)]]);
    const missingDirectories = new Set<string>();
    for (const name of changed) {
      yield* checkDirectory(path.dirname(path.join(root, name)), true);
      yield* checkAncestors(
        root,
        name,
        preparation.leaseDirectories,
        directories,
        missingDirectories,
      );
      yield* checkPreimage(root, name, previous.get(name));
    }
    const plannedDirectories = [...missingDirectories].toSorted(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    );
    const entries = yield* Effect.forEach(changed, (name) =>
      journalEntry(name, previous.get(name), next.get(name)),
    );
    const journal: WorkspaceRecord = {
      ...record,
      status: "integrating",
      publishedCount: 0,
      plannedDirectories,
      createdDirectoryCount: 0,
      journal: entries,
    };
    yield* saveWorkspaceRecord(registry, journal);
    const emptiedDirectories = emptiedDirectoryCandidates(
      record,
      changed.filter((name) => !next.has(name)),
      directories,
      helperCache,
    );
    const created = yield* createPlannedDirectories(
      registry,
      journal,
      root,
      directories,
      helperCache,
    );
    const published = yield* publishEntries(
      registry,
      created,
      root,
      directories,
      previous,
      next,
      helperCache,
    );
    return { ...published, emptiedDirectories };
  });
