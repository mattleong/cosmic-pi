import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SafeFile } from "pi-cosmic-core";
import { WorkspaceError } from "../workspace/model.ts";
import type { WorkspacePreparation, WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import { nodeErrorCode } from "./harness-shared.ts";
import {
  checkDirectory,
  listedPaths,
  workspaceFailure,
  workspaceIO,
  workspaceIOIfPresent,
  workspaceRefusal,
} from "./git-worktree-process.ts";
import {
  contentDigest,
  createWorkspaceDirectory,
  MAX_PUBLISHED_FILE_BYTES,
  inspectPublishedFile,
  publicationBackupPrefix,
  publicationTemporaryPrefix,
  publishWorkspaceFile,
  removeEmptyWorkspaceDirectory,
  removeWorkspaceBackups,
  restoreBackup,
  syncDirectory,
  unlinkIdentified,
  type DirectoryIdentity,
  type WorkspaceBackupRemovalRequest,
  type WorkspaceDirectoryRemovalRequest,
} from "./git-worktree-publish.ts";
import {
  newWorkspaceId,
  readPublicationProgress,
  readWorkspaceRecord,
  removePublicationProgress,
  savePublicationProgress,
  saveWorkspaceRecord,
  workspaceDirectory,
} from "./git-worktree-store.ts";

type JournalEntry = NonNullable<WorkspaceRecord["journal"]>[number];
const EMPTY_DIGEST = contentDigest(new Uint8Array());

/** A regular file's content as publication reads, installs, and backs it up. */
export interface PublishedFile {
  readonly digest: string;
  readonly mode: "100644" | "100755";
  readonly permissions: number;
  readonly bytes: Uint8Array;
}
/** Files by path relative to their tree's root; a missing path is absent there. */
export type PublishedFiles = ReadonlyMap<string, PublishedFile>;

const unpublishable = (relative: string, message: string, rule: string) =>
  workspaceRefusal("integrate", message, {
    path: relative,
    rule,
    remedy:
      "Replace it with a regular file, or revise the workspace so the writer leaves that path alone.",
  });

/**
 * The regular file at `relative` in `root`, or undefined when nothing is there. Publication
 * moves files aside and installs regular files only, so anything else at a changed path refuses.
 */
const readPublishedFile = (root: string, relative: string) =>
  Effect.gen(function* () {
    const full = path.join(root, relative);
    yield* checkDirectory(path.dirname(full), true);
    const before = yield* workspaceIOIfPresent("integrate", () => fs.lstat(full));
    if (!before) return undefined;
    if (!before.isFile())
      return yield* unpublishable(
        relative,
        "A changed path isn't a regular file.",
        "integration publishes and backs up regular files only, never symlinks, directories, or special files",
      );
    if (before.nlink !== 1)
      return yield* unpublishable(
        relative,
        "A changed file is hard-linked.",
        "integration replaces a file only while it has exactly one link, so its backup stays the only copy",
      );
    const unstable = () =>
      workspaceRefusal("integrate", "A changed file changed while it was being read.", {
        path: relative,
        rule: `files must stay unchanged while integration reads them, and be at most ${MAX_PUBLISHED_FILE_BYTES / 1024 / 1024} MiB`,
        remedy: "Try again once tools stop writing to the file.",
      });
    const safe = yield* SafeFile;
    const { bytes } = yield* safe
      .readContainedRegularFile(full, root, MAX_PUBLISHED_FILE_BYTES)
      .pipe(Effect.mapError(unstable));
    const after = yield* workspaceIO("integrate", () => fs.lstat(full));
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.mode !== before.mode
    )
      return yield* unstable();
    return {
      digest: contentDigest(bytes),
      mode: (before.mode & 0o111) !== 0 ? "100755" : "100644",
      permissions: before.mode & 0o777,
      bytes,
    } satisfies PublishedFile;
  });

/** The files at `paths` in `root`, absent ones left out. */
export const readPublishedFiles = (root: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const files = new Map<string, PublishedFile>();
    for (const name of paths) {
      const file = yield* readPublishedFile(root, name);
      if (file) files.set(name, file);
    }
    return files satisfies PublishedFiles;
  });

const directoryIdentity = (directory: string) =>
  Effect.gen(function* () {
    yield* checkDirectory(directory);
    const stat = yield* workspaceIO("integrate", () => fs.lstat(directory));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return yield* workspaceFailure("integrate", "Publication directory changed.");
    return { directoryDev: stat.dev, directoryIno: stat.ino } satisfies DirectoryIdentity;
  });

/** Whether the parent file still holds exactly the content the integration captured. */
const preimageHolds = (root: string, name: string, expected: PublishedFile | undefined) =>
  readPublishedFile(root, name).pipe(
    Effect.map(
      (visible) =>
        (visible === undefined) === (expected === undefined) &&
        (visible === undefined ||
          expected === undefined ||
          (visible.permissions === expected.permissions && visible.digest === expected.digest)),
    ),
    Effect.orElseSucceed(() => false),
  );

/** Parent files the proposal changes moved on since they were tested; nothing was published. */
export const touchedParentDrift = (paths: ReadonlyArray<string>) =>
  new WorkspaceError({
    operation: "integrate",
    code: "workspace_parent_changed",
    message:
      paths.length === 1
        ? "A parent file the proposal changes no longer matches the tested one."
        : `${paths.length} parent files the proposal changes no longer match the tested ones.`,
    detail: [
      `Changed: ${listedPaths(paths)}`,
      "Nothing was published.",
      "Remedy: prepare again so the proposal is tested against the current files, then integrate the new preparation. A parent file captures skip, such as an ignored or untracked credential file, never matches: move it aside, or revise the workspace so the writer leaves that path alone.",
    ].join("\n"),
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

// Ancestors of deleted files, deepest first, that publication may remove once they are empty, as
// `git apply` would. The source root and the session's cwd and its ancestors always stay.
const emptiedDirectoryCandidates = (
  record: WorkspaceRecord,
  deleted: ReadonlyArray<string>,
  directories: ReadonlyMap<string, DirectoryIdentity>,
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
        name: path.basename(full),
        targetDev: target.directoryDev,
        targetIno: target.directoryIno,
      });
    }
  return [...candidates.entries()]
    .toSorted(([left], [right]) => right.split(path.sep).length - left.split(path.sep).length)
    .map(([, candidate]) => candidate);
};

const publishedPermissions = (
  expected: PublishedFile | undefined,
  content: PublishedFile | undefined,
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
  expected: PublishedFile | undefined,
  content: PublishedFile | undefined,
) =>
  Effect.gen(function* () {
    const token = yield* newWorkspaceId;
    return {
      path: name,
      temporaryPath: path.join(path.dirname(name), `${publicationTemporaryPrefix}${token}`),
      backupPath: path.join(path.dirname(name), `${publicationBackupPrefix}${token}`),
      before: expected && {
        digest: expected.digest,
        mode: expected.mode,
        permissions: expected.permissions,
      },
      after: content && {
        digest: content.digest,
        mode: content.mode,
        permissions: publishedPermissions(expected, content),
      },
    } satisfies JournalEntry;
  });

const journalFile = (registry: string, record: WorkspaceRecord) =>
  path.join(workspaceDirectory(registry, record.handle.workspaceId), "record.json");

// Every artifact a stopped publication may have left, for the error and manual recovery.
const stoppedPublication = (
  registry: string,
  record: WorkspaceRecord,
  message: string,
  stoppedAt?: string,
) =>
  new WorkspaceError({
    operation: "integrate",
    message,
    detail: [
      ...(stoppedAt === undefined ? [] : [`Stopped at: ${JSON.stringify(stoppedAt)}`]),
      `Journal: ${journalFile(registry, record)}`,
      "Remedy: discard the workspace to roll back the files it published, or inspect the journal's backup and temporary paths (relative to the source root) and recover manually.",
    ].join("\n"),
  });

const createPlannedDirectories = (
  registry: string,
  journal: WorkspaceRecord,
  directories: Map<string, DirectoryIdentity>,
) =>
  Effect.gen(function* () {
    const root = journal.handle.sourceRoot;
    const planned = journal.plannedDirectories ?? [];
    for (const [index, name] of planned.entries()) {
      const target = path.join(root, name),
        parent = path.dirname(target);
      const identity = directories.get(parent);
      if (!identity)
        return yield* workspaceFailure("integrate", "Missing parent directory ownership.");
      yield* savePublicationProgress(registry, journal.handle.workspaceId, {
        directories: index + 1,
        files: 0,
      });
      const created = yield* createWorkspaceDirectory({
        directory: parent,
        ...identity,
        name: path.basename(target),
      }).pipe(
        Effect.mapError(() =>
          stoppedPublication(
            registry,
            journal,
            "A directory the proposal needs couldn't be created; the workspace is mid-integration.",
            name,
          ),
        ),
      );
      directories.set(target, created);
    }
    return planned.length;
  });

const publishEntries = (
  registry: string,
  journal: WorkspaceRecord,
  createdDirectories: number,
  directories: ReadonlyMap<string, DirectoryIdentity>,
  previous: PublishedFiles,
  next: PublishedFiles,
) =>
  Effect.gen(function* () {
    const root = journal.handle.sourceRoot;
    const backups = new Map<string, WorkspaceBackupRemovalRequest>();
    for (const [index, entry] of (journal.journal ?? []).entries()) {
      const directory = path.dirname(path.join(root, entry.path));
      const identity = directories.get(directory);
      if (!identity)
        return yield* workspaceFailure("integrate", "Missing publication directory ownership.");
      const expected = previous.get(entry.path),
        content = next.get(entry.path);
      yield* savePublicationProgress(registry, journal.handle.workspaceId, {
        directories: createdDirectories,
        files: index + 1,
      });
      const result = yield* publishWorkspaceFile({
        directory,
        ...identity,
        name: path.basename(entry.path),
        temporaryName: path.basename(entry.temporaryPath),
        backupName: path.basename(entry.backupPath),
        ...(expected && { before: { bytes: expected.bytes, mode: expected.permissions } }),
        ...(content && {
          after: { bytes: content.bytes, mode: publishedPermissions(expected, content) },
        }),
      });
      if (result.status !== "success")
        return yield* stoppedPublication(
          registry,
          journal,
          result.status === "conflict"
            ? "A parent file changed during publication; the workspace is mid-integration."
            : "Publication of a file is uncertain; the workspace is mid-integration.",
          entry.path,
        );
      if (expected)
        backups.set(directory, {
          directory,
          ...identity,
          names: [...(backups.get(directory)?.names ?? []), path.basename(entry.backupPath)],
        });
    }
    return [...backups.values()];
  });

/**
 * Deletes the preimage backups a publication left beside the files it replaced or deleted. Call it
 * only once the integration has committed: until then the backups are the rollback copy.
 * Returns the backup paths that remain.
 */
export const removePublicationBackups = (backups: ReadonlyArray<WorkspaceBackupRemovalRequest>) =>
  Effect.forEach(backups, (group) =>
    removeWorkspaceBackups(group).pipe(
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

/**
 * Publishes `changed` from `next` over the parent files in `previous`, which hold their current
 * content. The record and its journal are saved once before the first change; publication.json
 * then records each step before it starts, so a rollback knows which entries were never touched.
 */
export const publishWorkspace = (
  registry: string,
  record: WorkspaceRecord,
  previous: PublishedFiles,
  next: PublishedFiles,
  changed: ReadonlyArray<string>,
  preparation: Pick<WorkspacePreparation, "leaseDirectories">,
) =>
  Effect.gen(function* () {
    const root = record.handle.sourceRoot;
    const directories = new Map([[root, yield* directoryIdentity(root)]]);
    const missingDirectories = new Set<string>();
    const drifted: string[] = [];
    for (const name of changed) {
      yield* checkDirectory(path.dirname(path.join(root, name)), true);
      yield* checkAncestors(
        root,
        name,
        preparation.leaseDirectories,
        directories,
        missingDirectories,
      );
      if (!(yield* preimageHolds(root, name, previous.get(name)))) drifted.push(name);
    }
    if (drifted.length > 0) return yield* touchedParentDrift(drifted);
    const plannedDirectories = [...missingDirectories].toSorted(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    );
    const entries = yield* Effect.forEach(changed, (name) =>
      journalEntry(name, previous.get(name), next.get(name)),
    );
    const journal: WorkspaceRecord = {
      ...record,
      status: "integrating",
      plannedDirectories,
      journal: entries,
    };
    // Progress an earlier publication left (its removal is best effort) must not describe this
    // journal: a rollback after stopping before the first step would otherwise skip or revisit
    // entries by its stale counts.
    yield* savePublicationProgress(registry, record.handle.workspaceId, {
      directories: 0,
      files: 0,
    });
    yield* saveWorkspaceRecord(registry, journal);
    const emptiedDirectories = emptiedDirectoryCandidates(
      record,
      changed.filter((name) => !next.has(name)),
      directories,
    );
    const created = yield* createPlannedDirectories(registry, journal, directories);
    const backups = yield* publishEntries(registry, journal, created, directories, previous, next);
    return { record: journal, backups, emptiedDirectories };
  });

/**
 * Every file is already published, so the record stays mid-integration with its journal and every
 * backup; discard rolls the files back.
 */
export const publishedMidIntegration = (
  registry: string,
  journal: WorkspaceRecord,
  message: string,
  remedy: string,
) => {
  const entries = journal.journal ?? [];
  const backups = entries.flatMap((entry) => (entry.before ? [entry.backupPath] : []));
  return new WorkspaceError({
    operation: "integrate",
    message,
    detail: [
      `Published: all ${entries.length} reviewed file changes in ${journal.handle.sourceRoot}`,
      `Journal: ${journalFile(registry, journal)}`,
      ...(backups.length > 0
        ? [`Backups (relative to the source root): ${backups.join(", ")}`]
        : []),
      `Remedy: ${remedy}`,
    ].join("\n"),
  });
};

/**
 * Saves the record that ends a publication, `committed`, in place of its mid-integration
 * `journal`. A failed save can still have renamed the record into place before its directory sync
 * failed, so the record is reread: once it no longer says integrating, the publication is
 * committed and its cleanup proceeds. Otherwise the journal still tracks every backup for
 * discard's rollback, and the failure says so.
 */
export const commitPublication = (
  registry: string,
  journal: WorkspaceRecord,
  committed: WorkspaceRecord,
) =>
  saveWorkspaceRecord(registry, committed).pipe(
    Effect.catchTag("WorkspaceError", (error) =>
      Effect.gen(function* () {
        const saved = yield* readWorkspaceRecord(registry, committed.handle.workspaceId).pipe(
          Effect.option,
        );
        if (
          Option.isSome(saved) &&
          saved.value.status === committed.status &&
          saved.value.baseline === committed.baseline
        )
          return yield* Effect.logWarning(
            `The workspace record was saved, but its durability is unconfirmed: ${error.message}`,
          ).pipe(Effect.annotateLogs("workspaceId", committed.handle.workspaceId));
        return yield* publishedMidIntegration(
          registry,
          journal,
          "Every reviewed file was published, but the workspace record couldn't be saved; the workspace stays mid-integration.",
          "discard the workspace to roll the published files back, or keep them and delete the backups manually.",
        );
      }),
    ),
    Effect.uninterruptible,
  );

/** Clears the progress file once the integration record says integrated; best effort. */
export const finishPublication = (registry: string, record: WorkspaceRecord) =>
  removePublicationProgress(registry, record.handle.workspaceId).pipe(Effect.ignore);

type RollbackStep =
  | { readonly kind: "keep" }
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "undo"; readonly run: Effect.Effect<void, WorkspaceError> };

const keep: RollbackStep = { kind: "keep" };
const refuse = (reason: string): RollbackStep => ({ kind: "refuse", reason });

// Decides from the files on disk alone what undoing one touched journal entry takes: the backup
// must still hold the reviewed preimage, and an installed file must still hold the published
// content. Anything else was changed by someone else, so it is refused rather than overwritten.
const rollbackStep = (root: string, entry: JournalEntry) =>
  Effect.gen(function* () {
    const target = path.join(root, entry.path);
    const backup = path.join(root, entry.backupPath);
    const temporary = path.join(root, entry.temporaryPath);
    const directory = path.dirname(target);
    const anchored = yield* checkDirectory(directory, true).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!anchored) return refuse("a directory leading to it is no longer a real directory");
    const current = yield* inspectPublishedFile(target);
    const saved = yield* inspectPublishedFile(backup);
    const staged = yield* workspaceIOIfPresent("rollback", () => fs.lstat(temporary));
    if (staged && !staged.isFile()) return refuse("its temporary path holds something else");
    const installed =
      entry.after !== undefined && current.kind === "file" && current.digest === entry.after.digest;
    const steps: Array<Effect.Effect<void, WorkspaceError>> = staged
      ? [workspaceIO("rollback", () => fs.unlink(temporary))]
      : [];
    // Publication reserves the backup name with an empty file before moving the target there; a
    // stop between the two leaves that reservation beside the untouched original.
    const reservation =
      entry.before !== undefined &&
      saved.kind === "file" &&
      saved.digest === EMPTY_DIGEST &&
      current.kind === "file" &&
      current.digest === entry.before.digest &&
      (current.dev !== saved.dev || current.ino !== saved.ino);
    if (reservation) steps.push(unlinkIdentified(backup, saved));
    else if (entry.before === undefined) {
      if (installed) steps.push(unlinkIdentified(target, current));
    } else if (saved.kind === "file" && saved.digest === entry.before.digest) {
      if (current.kind === "file" && current.dev === saved.dev && current.ino === saved.ino)
        steps.push(workspaceIO("rollback", () => fs.unlink(backup)));
      else if (current.kind === "absent") steps.push(restoreBackup(backup, target));
      else if (installed)
        steps.push(unlinkIdentified(target, current), restoreBackup(backup, target));
      else return refuse("it changed after publication replaced it");
    } else if (saved.kind !== "absent") return refuse("its backup no longer holds the original");
    else if (installed && entry.after?.digest !== entry.before.digest)
      return refuse("its backup is missing");
    if (steps.length === 0) return keep;
    return {
      kind: "undo",
      run: Effect.gen(function* () {
        for (const step of steps) yield* step;
        yield* syncDirectory(directory);
      }),
    } satisfies RollbackStep;
  });

/**
 * Undoes a stopped publication from its journal: published files that still hold their new
 * content are removed, backups that still hold the reviewed preimage are put back, temporary
 * files are deleted, and directories it created are removed once empty. Entries it never reached
 * are left alone. If any touched file matches neither side, nothing changes and the refusal names
 * it, keeping every artifact for manual recovery.
 */
export const rollbackPublication = (registry: string, record: WorkspaceRecord) =>
  Effect.gen(function* () {
    const root = record.handle.sourceRoot;
    yield* checkDirectory(root);
    const progress = yield* readPublicationProgress(registry, record.handle.workspaceId);
    const journal = record.journal ?? [];
    const planned = record.plannedDirectories ?? [];
    // A finished rollback removes progress before discard saves the record, so a discard retried
    // after a later failure finds none; every entry may then be touched, and each step re-checks
    // the files on disk.
    const touched = journal.slice(0, progress?.files ?? journal.length);
    const steps = yield* Effect.forEach(touched, (entry) =>
      rollbackStep(root, entry).pipe(Effect.map((step) => ({ entry, step }))),
    );
    const refused = steps.flatMap(({ entry, step }) =>
      step.kind === "refuse" ? [`${JSON.stringify(entry.path)}: ${step.reason}`] : [],
    );
    if (refused.length > 0)
      return yield* new WorkspaceError({
        operation: "discard",
        code: "workspace_rollback_refused",
        message:
          refused.length === 1
            ? "A file the integration published has changed since; rollback was refused."
            : `${refused.length} files the integration published have changed since; rollback was refused.`,
        detail: [
          ...refused.slice(0, 5),
          ...(refused.length > 5 ? [`and ${refused.length - 5} more`] : []),
          "Nothing was rolled back; the workspace stays mid-integration.",
          `Journal: ${journalFile(registry, record)}`,
          "Remedy: put each named file back to its published or original content and discard again, or recover manually from the journal's backup paths (relative to the source root).",
        ].join("\n"),
      });
    for (const { step } of steps) if (step.kind === "undo") yield* step.run;
    const created = planned.slice(0, progress?.directories ?? planned.length);
    for (const name of created.toReversed()) {
      const directory = path.join(root, name);
      const stat = yield* workspaceIOIfPresent("rollback", () => fs.lstat(directory));
      // Never created, or replaced by something that isn't a real directory: not publication's.
      if (
        !stat?.isDirectory() ||
        Option.isNone(yield* checkDirectory(directory).pipe(Effect.option))
      )
        continue;
      const removed = yield* workspaceIO("rollback", () =>
        fs.rmdir(directory).then(
          () => true,
          (cause: unknown) => {
            // Someone else's files keep it.
            const code = nodeErrorCode(cause);
            if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return false;
            throw cause;
          },
        ),
      );
      if (removed) yield* syncDirectory(path.dirname(directory));
    }
    yield* removePublicationProgress(registry, record.handle.workspaceId);
    return undefined;
  });
