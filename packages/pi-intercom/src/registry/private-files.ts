import * as Effect from "effect/Effect";
import {
  isOwnedByCurrentUser,
  PrivateFileError,
  replacePrivateFile,
  tryPrivateFileOperation as attempt,
} from "pi-cosmic-core/platform/private-file";
import { nodeFsPromises as fs } from "pi-cosmic-core/platform/node-builtins";

// The shared no-follow private-file mechanism lives in core; this module keeps the registry's own
// operations: record encoding, directory identity for claims by rename, and socket permissions.
export {
  createPrivateDirectory,
  currentUserId,
  ensurePrivateDirectory,
  PrivateFileError,
  readPrivateFile,
  removeOwnEntry,
} from "pi-cosmic-core";

const unsafe = () => Effect.fail(PrivateFileError.make({ reason: "unsafe" }));

/** Creates `path` and any missing parents; directories it creates are 0700. */
export const ensureDirectoryPath = (path: string): Effect.Effect<void, PrivateFileError> =>
  Effect.asVoid(attempt(() => fs.mkdir(path, { recursive: true, mode: 0o700 })));

/** Identifies one entry, so a claim by rename can be checked to have moved that entry. */
export interface EntryIdentity {
  readonly device: number;
  readonly inode: number;
  readonly modifiedMillis: number;
}

type EntryKind = (info: { isDirectory(): boolean; isFile(): boolean }) => boolean;

const ownEntry = (
  path: string,
  isKind: EntryKind,
): Effect.Effect<EntryIdentity, PrivateFileError> =>
  attempt(() => fs.lstat(path)).pipe(
    Effect.flatMap((info) =>
      isKind(info) && isOwnedByCurrentUser(info)
        ? Effect.succeed({ device: info.dev, inode: info.ino, modifiedMillis: info.mtimeMs })
        : unsafe(),
    ),
  );

/** The identity of a real directory of this user at `path`, without following a link. */
export const ownDirectory = (path: string): Effect.Effect<EntryIdentity, PrivateFileError> =>
  ownEntry(path, (info) => info.isDirectory());

/** The identity of a regular file of this user at `path`, without following a link. */
export const ownFile = (path: string): Effect.Effect<EntryIdentity, PrivateFileError> =>
  ownEntry(path, (info) => info.isFile());

export const sameEntry = (left: EntryIdentity, right: EntryIdentity): boolean =>
  left.device === right.device && left.inode === right.inode;

/**
 * Writes `source` and a final newline to `target` as a 0600 file through an exclusively created
 * temporary file in the same directory, replacing `target` only by the final rename. The temporary
 * file is removed unless the rename committed it; an entry that was already at its path is never
 * this write's.
 */
export const writePrivateFile = (
  target: string,
  temporary: string,
  source: string,
): Effect.Effect<void, PrivateFileError> => replacePrivateFile(target, temporary, `${source}\n`);

/** Removes an empty directory; one that still holds anything stays. */
export const removeEmptyDirectory = (path: string): Effect.Effect<void, PrivateFileError> =>
  attempt(() => fs.rmdir(path));

export const listEntries = (path: string): Effect.Effect<ReadonlyArray<string>, PrivateFileError> =>
  attempt(() => fs.readdir(path));

export const renameEntry = (from: string, to: string): Effect.Effect<void, PrivateFileError> =>
  attempt(() => fs.rename(from, to));

/** Links `to` to `from`'s file; fails when `to` already exists. */
export const linkEntry = (from: string, to: string): Effect.Effect<void, PrivateFileError> =>
  attempt(() => fs.link(from, to));

/** Restricts a bound socket of this user to 0600, refusing anything else at the path. */
export const restrictSocket = (path: string): Effect.Effect<void, PrivateFileError> =>
  attempt(() => fs.lstat(path)).pipe(
    Effect.flatMap((info) =>
      info.isSocket() && isOwnedByCurrentUser(info)
        ? attempt(() => fs.chmod(path, 0o600))
        : unsafe(),
    ),
  );
