import * as Effect from "effect/Effect";
import { MAX_WORKSPACE_FILE_BYTES } from "../workspace/policy.ts";
import { nodeErrorCode } from "./harness-shared.ts";
import {
  nodeFsConstants as constants,
  nodeFsPromises as fs,
  nodePath as path,
} from "./node-builtins.ts";
import {
  checkDirectory,
  workspaceFailure,
  workspaceIO,
  workspaceIOIfPresent,
} from "./git-worktree-process.ts";
import { blobId } from "./git-worktree-snapshot.ts";

export const publicationBackupPrefix = ".pi-workspace-old-";
export const publicationTemporaryPrefix = ".pi-workspace-new-";

export interface DirectoryIdentity {
  readonly directoryDev: number;
  readonly directoryIno: number;
}
/** An absolute directory and the identity publication saw, rechecked before each change in it. */
export interface AnchoredDirectory extends DirectoryIdentity {
  readonly directory: string;
}
export interface WorkspaceDirectoryRequest extends AnchoredDirectory {
  readonly name: string;
}
export interface WorkspaceBackupRemovalRequest extends AnchoredDirectory {
  readonly names: ReadonlyArray<string>;
}
export interface WorkspaceDirectoryRemovalRequest extends WorkspaceDirectoryRequest {
  readonly targetDev: number;
  readonly targetIno: number;
}
export interface PublicationImage {
  readonly bytes: Uint8Array;
  readonly mode: number;
}
export interface WorkspacePublicationRequest extends WorkspaceDirectoryRequest {
  readonly backupName: string;
  readonly temporaryName: string;
  readonly before?: PublicationImage | undefined;
  readonly after?: PublicationImage | undefined;
}
export interface PublicationResult {
  /**
   * `conflict`: something else changed the target or its directory; `uncertain`: the outcome is
   * unknown. Either may leave the journal's backup or temporary file for rollback.
   */
  readonly status: "success" | "conflict" | "uncertain";
  readonly reason:
    | "published"
    | "directory-changed"
    | "target-changed"
    | "destination-exists"
    | "io-failure";
}
/** Test seams that run between publication steps. */
export interface PublicationHooks {
  readonly anchored?: Effect.Effect<void> | undefined;
  readonly captured?: Effect.Effect<void> | undefined;
}

const operation = "publication";
const io = <A>(run: () => PromiseLike<A>) => workspaceIO(operation, run);
const lstatIfPresent = (file: string) => workspaceIOIfPresent(operation, () => fs.lstat(file));
const ignoreMissing = (cause: unknown) => {
  if (nodeErrorCode(cause) !== "ENOENT") throw cause;
};

/** Every ancestor is still a real directory and the directory is the one publication saw. */
export const anchorHolds = (anchor: AnchoredDirectory) =>
  Effect.gen(function* () {
    yield* checkDirectory(anchor.directory);
    const stat = yield* io(() => fs.lstat(anchor.directory));
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === anchor.directoryDev &&
      stat.ino === anchor.directoryIno
    );
  }).pipe(Effect.orElseSucceed(() => false));

export const syncDirectory = (directory: string) =>
  Effect.acquireUseRelease(
    io(() => fs.open(directory, constants.O_RDONLY)),
    (handle) => io(() => handle.sync()),
    (handle) => io(() => handle.close()).pipe(Effect.ignore),
  );

const openNoFollow = (file: string) =>
  io(() => fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));

// The backup must be exactly the reviewed preimage, read through one descriptor that stays the
// same unlinked-elsewhere regular file throughout.
const captureMatches = (backup: string, before: PublicationImage) =>
  Effect.gen(function* () {
    const stat = yield* io(() => fs.lstat(backup));
    if (!stat.isFile() || stat.nlink !== 1) return false;
    return yield* Effect.acquireUseRelease(
      openNoFollow(backup),
      (handle) =>
        Effect.gen(function* () {
          const opened = yield* io(() => handle.stat());
          if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.dev !== stat.dev ||
            opened.ino !== stat.ino ||
            opened.size !== before.bytes.byteLength
          )
            return false;
          const bytes = Buffer.alloc(opened.size);
          const { bytesRead } = yield* io(() => handle.read(bytes, 0, bytes.length, 0));
          const final = yield* io(() => handle.stat());
          yield* io(() => handle.sync());
          return (
            bytesRead === bytes.length &&
            final.size === opened.size &&
            bytes.equals(before.bytes) &&
            (final.mode & 0o7777) === before.mode &&
            final.nlink === 1 &&
            final.mtimeMs === opened.mtimeMs &&
            final.ctimeMs === opened.ctimeMs
          );
        }),
      (handle) => io(() => handle.close()).pipe(Effect.ignore),
    );
  });

const writeTemporary = (file: string, after: PublicationImage) =>
  Effect.acquireUseRelease(
    io(() => fs.open(file, "wx", 0o600)),
    (handle) =>
      Effect.gen(function* () {
        yield* io(() => handle.writeFile(after.bytes));
        yield* io(() => handle.chmod(after.mode));
        yield* io(() => handle.sync());
      }),
    (handle) => io(() => handle.close()).pipe(Effect.ignore),
  );

// Only for a definite conflict: the temporary file was never linked to the target, so it holds
// nothing recovery needs.
const discardTemporary = (file: string) =>
  io(() => fs.unlink(file).catch(ignoreMissing)).pipe(Effect.ignore);

// The exclusive link never clobbers a file that appeared meanwhile. Once both names hold the same
// file, dropping the backup name leaves the original exactly as it was found, rather than
// hard-linked to a backup that later captures refuse and in-place edits would change too. Returns
// whether the file is back at its name alone.
const restoreUnmatchedCapture = (target: string, backup: string) =>
  Effect.gen(function* () {
    yield* io(() => fs.link(backup, target));
    const restored = yield* io(() => fs.lstat(target));
    const kept = yield* io(() => fs.lstat(backup));
    if (restored.dev !== kept.dev || restored.ino !== kept.ino) return false;
    yield* io(() => fs.unlink(backup));
    return true;
  }).pipe(Effect.orElseSucceed(() => false));

const result = (
  status: PublicationResult["status"],
  reason: PublicationResult["reason"],
): PublicationResult => ({ status, reason });

/**
 * Publishes one file beside its journal artifacts: the new content goes to a temporary sibling,
 * the file it replaces or deletes moves to a backup that must match the reviewed preimage, and an
 * exclusive link installs the new content, so a competing destination is never clobbered.
 */
export const publishWorkspaceFile = (
  request: WorkspacePublicationRequest,
  hooks: PublicationHooks = {},
): Effect.Effect<PublicationResult> => {
  const target = path.join(request.directory, request.name);
  const temporary = path.join(request.directory, request.temporaryName);
  const backup = path.join(request.directory, request.backupName);
  return Effect.gen(function* () {
    if (!(yield* anchorHolds(request))) return result("conflict", "directory-changed");
    if (hooks.anchored) yield* hooks.anchored;
    const current = yield* lstatIfPresent(target);
    const eligible =
      request.before === undefined
        ? current === undefined
        : current !== undefined && current.isFile() && current.nlink === 1;
    if (!eligible) return result("conflict", "target-changed");
    if ((yield* lstatIfPresent(temporary)) || (yield* lstatIfPresent(backup)))
      return result("conflict", "destination-exists");
    // Revalidated before the first change too, so a swapped ancestor redirects nothing.
    if (!(yield* anchorHolds(request))) return result("conflict", "directory-changed");
    if (request.after !== undefined) yield* writeTemporary(temporary, request.after);
    if (request.before !== undefined) {
      const reservation = yield* io(() => fs.open(backup, "wx", 0o600));
      yield* io(() => reservation.close());
      yield* io(() => fs.rename(target, backup));
      yield* syncDirectory(request.directory);
      if (!(yield* captureMatches(backup, request.before))) {
        const restored = yield* restoreUnmatchedCapture(target, backup);
        yield* discardTemporary(temporary);
        yield* syncDirectory(request.directory);
        return result(restored ? "conflict" : "uncertain", "target-changed");
      }
      if (hooks.captured) yield* hooks.captured;
    }
    // Revalidated before every install; a changed ancestor leaves the journal's artifacts.
    if (!(yield* anchorHolds(request))) return result("uncertain", "directory-changed");
    if (request.after !== undefined) {
      const linked = yield* io(() =>
        fs.link(temporary, target).then(
          () => true,
          (cause: unknown) => {
            if (nodeErrorCode(cause) === "EEXIST") return false;
            throw cause;
          },
        ),
      );
      if (!linked) {
        yield* discardTemporary(temporary);
        yield* syncDirectory(request.directory);
        return result("conflict", "destination-exists");
      }
      yield* io(() => fs.unlink(temporary));
    } else if (yield* lstatIfPresent(target)) {
      yield* syncDirectory(request.directory);
      return result("conflict", "destination-exists");
    }
    yield* syncDirectory(request.directory);
    return result("success", "published");
  }).pipe(Effect.orElseSucceed(() => result("uncertain", "io-failure")));
};

export const createWorkspaceDirectory = (request: WorkspaceDirectoryRequest) =>
  Effect.gen(function* () {
    if (!(yield* anchorHolds(request)))
      return yield* workspaceFailure(operation, "A publication directory changed.");
    const created = path.join(request.directory, request.name);
    yield* io(() => fs.mkdir(created, { mode: 0o755 }));
    const stat = yield* io(() => fs.lstat(created));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return yield* workspaceFailure(operation, "A publication directory changed.");
    yield* syncDirectory(request.directory);
    return { directoryDev: stat.dev, directoryIno: stat.ino } satisfies DirectoryIdentity;
  });

/** Deletes publication backups in one directory; returns the names still present. */
export const removeWorkspaceBackups = (request: WorkspaceBackupRemovalRequest) =>
  Effect.gen(function* () {
    if (!(yield* anchorHolds(request))) return request.names;
    const retained: string[] = [];
    for (const name of request.names) {
      const file = path.join(request.directory, name);
      // A name that is no longer a regular file was replaced by someone else, so it stays.
      const removed = yield* lstatIfPresent(file).pipe(
        Effect.flatMap((stat) =>
          stat === undefined
            ? Effect.succeed(true)
            : stat.isFile()
              ? io(() => fs.unlink(file)).pipe(Effect.as(true))
              : Effect.succeed(false),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (!removed) retained.push(name);
    }
    yield* syncDirectory(request.directory).pipe(Effect.ignore);
    return retained;
  });

/** Removes the directory only while it is still the identified, empty one. */
export const removeEmptyWorkspaceDirectory = (request: WorkspaceDirectoryRemovalRequest) =>
  Effect.gen(function* () {
    if (!(yield* anchorHolds(request))) return false;
    const target = path.join(request.directory, request.name);
    const stat = yield* lstatIfPresent(target);
    if (
      stat === undefined ||
      !stat.isDirectory() ||
      stat.dev !== request.targetDev ||
      stat.ino !== request.targetIno
    )
      return false;
    // Non-recursive: a directory that isn't empty stays.
    yield* io(() => fs.rmdir(target));
    yield* syncDirectory(request.directory);
    return true;
  }).pipe(Effect.orElseSucceed(() => false));

/** A journal path's current state: absent, a regular file with its blob id, or something else. */
export type PublishedFileState =
  | { readonly kind: "absent" }
  | { readonly kind: "other" }
  | {
      readonly kind: "file";
      readonly oid: string;
      readonly dev: number;
      readonly ino: number;
    };

export const inspectPublishedFile = (file: string) =>
  Effect.gen(function* () {
    const stat = yield* lstatIfPresent(file);
    if (stat === undefined) return { kind: "absent" } satisfies PublishedFileState;
    if (!stat.isFile() || stat.size > MAX_WORKSPACE_FILE_BYTES)
      return { kind: "other" } satisfies PublishedFileState;
    return yield* Effect.acquireUseRelease(
      openNoFollow(file),
      (handle) =>
        Effect.gen(function* () {
          const opened = yield* io(() => handle.stat());
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
            return { kind: "other" } satisfies PublishedFileState;
          const bytes = Buffer.alloc(opened.size);
          const { bytesRead } = yield* io(() => handle.read(bytes, 0, bytes.length, 0));
          if (bytesRead !== bytes.length) return { kind: "other" } satisfies PublishedFileState;
          return {
            kind: "file",
            oid: blobId(bytes),
            dev: opened.dev,
            ino: opened.ino,
          } satisfies PublishedFileState;
        }),
      (handle) => io(() => handle.close()).pipe(Effect.ignore),
    );
  });

/** Unlinks `file` only while it is still the identified file. */
export const unlinkIdentified = (
  file: string,
  identity: { readonly dev: number; readonly ino: number },
) =>
  Effect.gen(function* () {
    const stat = yield* io(() => fs.lstat(file));
    if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino)
      return yield* workspaceFailure(operation, "A published file changed before its removal.");
    yield* io(() => fs.unlink(file));
    return undefined;
  });

/** Puts a backup back at its original name without clobbering anything that appeared there. */
export const restoreBackup = (backup: string, target: string) =>
  Effect.gen(function* () {
    yield* io(() => fs.link(backup, target));
    yield* io(() => fs.unlink(backup));
    return undefined;
  });
