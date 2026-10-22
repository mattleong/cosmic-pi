import * as Effect from "effect/Effect";
import {
  isOwnedByCurrentUser,
  nodeFsPromises as fs,
  PrivateFileError,
  replacePrivateFile,
  tryPrivateFileOperation as attempt,
} from "pi-cosmic-core";

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

const unsafe = () => Effect.fail(new PrivateFileError({ reason: "unsafe" }));

/** Creates `path` and any missing parents; directories it creates are 0700. */
export const ensureDirectoryPath = (path: string): Effect.Effect<void, PrivateFileError> =>
  Effect.asVoid(attempt(() => fs.mkdir(path, { recursive: true, mode: 0o700 })));

/** Identifies one directory, so a claim by rename can be checked to have moved that directory. */
export interface DirectoryIdentity {
  readonly device: number;
  readonly inode: number;
  readonly modifiedMillis: number;
}

/** The identity of a real directory of this user at `path`, without following a link. */
export const ownDirectory = (path: string): Effect.Effect<DirectoryIdentity, PrivateFileError> =>
  attempt(() => fs.lstat(path)).pipe(
    Effect.flatMap((info) =>
      info.isDirectory() && isOwnedByCurrentUser(info)
        ? Effect.succeed({ device: info.dev, inode: info.ino, modifiedMillis: info.mtimeMs })
        : unsafe(),
    ),
  );

export const sameDirectory = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
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
