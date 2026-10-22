import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { nodeFsConstants as constants, nodeFsPromises as fs, nodePath } from "./node-builtins.ts";

/**
 * `missing`: nothing is at the path; `exists`: something is where a new entry was to be created;
 * `unsafe`: an entry is there, but it is a link, the wrong kind of entry, another user's, readable
 * by others, or too large; `failed`: the OS refused otherwise. Paths and OS messages are never
 * retained.
 */
export class PrivateFileError extends Schema.TaggedError<PrivateFileError>()("PrivateFileError", {
  reason: Schema.Literals(["missing", "exists", "unsafe", "failed"]),
}) {}

const errorCode = (cause: unknown): string | undefined =>
  Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : undefined;

const classify = (cause: unknown): PrivateFileError => {
  const code = errorCode(cause);
  return new PrivateFileError({
    reason:
      code === "ENOENT"
        ? "missing"
        : code === "EEXIST"
          ? "exists"
          : code === "ELOOP" || code === "ENOTDIR" || code === "EMLINK"
            ? "unsafe"
            : "failed",
  });
};

/** Runs one filesystem call of a private-file boundary, classifying its failure. */
export const tryPrivateFileOperation = <A>(
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, PrivateFileError> => Effect.tryPromise({ try: evaluate, catch: classify });

const unsafe = () => Effect.fail(new PrivateFileError({ reason: "unsafe" }));

export const currentUserId = (): number | undefined => process.getuid?.();

/** False when the OS reports no user id, so ownership can never be assumed. */
export const isOwnedByCurrentUser = (info: { readonly uid: number }): boolean => {
  const uid = currentUserId();
  return uid !== undefined && info.uid === uid;
};

/** No group or other permission bits. */
export const hasPrivateMode = (info: { readonly mode: number }): boolean =>
  (info.mode & 0o077) === 0;

interface EntryInfo {
  readonly uid: number;
  readonly mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** A real directory, never a link, of this user that no one else may access. */
export const isPrivateDirectoryInfo = (info: EntryInfo): boolean =>
  info.isDirectory() &&
  !info.isSymbolicLink() &&
  isOwnedByCurrentUser(info) &&
  hasPrivateMode(info);

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

const withHandle = <A>(
  path: string,
  flags: number,
  use: (handle: FileHandle) => Effect.Effect<A, PrivateFileError>,
): Effect.Effect<A, PrivateFileError> =>
  Effect.acquireUseRelease(
    tryPrivateFileOperation(() => fs.open(path, flags)),
    use,
    (handle) => Effect.ignore(tryPrivateFileOperation(() => handle.close())),
  );

/** Requires the open directory to be a real directory of this user, then makes it 0700. */
const secureOpenDirectory = (path: string) =>
  withHandle(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, (handle) =>
    Effect.gen(function* () {
      const info = yield* tryPrivateFileOperation(() => handle.stat());
      if (!info.isDirectory() || !isOwnedByCurrentUser(info)) return yield* unsafe();
      return yield* tryPrivateFileOperation(() => handle.chmod(0o700));
    }),
  );

/**
 * Creates `path` as a 0700 directory, or accepts an existing one only when it is a real directory
 * of this user, never a link, and then tightens it to 0700.
 */
export const ensurePrivateDirectory = (path: string): Effect.Effect<void, PrivateFileError> =>
  tryPrivateFileOperation(() => fs.mkdir(path, { mode: 0o700 })).pipe(
    Effect.catchIf(
      (error) => error.reason === "exists",
      () => Effect.void,
    ),
    Effect.andThen(secureOpenDirectory(path)),
  );

/** Creates `path` as a new 0700 directory; fails with `exists` when anything is already there. */
export const createPrivateDirectory = (path: string): Effect.Effect<void, PrivateFileError> =>
  tryPrivateFileOperation(() => fs.mkdir(path, { mode: 0o700 })).pipe(
    Effect.andThen(secureOpenDirectory(path)),
  );

/**
 * Reads a regular file of this user that no one else may read, without following a link, and
 * refuses it when it is larger than `maxBytes`.
 */
export const readPrivateFile = (
  path: string,
  maxBytes: number,
): Effect.Effect<string, PrivateFileError> =>
  withHandle(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, (handle) =>
    Effect.gen(function* () {
      const info = yield* tryPrivateFileOperation(() => handle.stat());
      if (!info.isFile() || !isOwnedByCurrentUser(info) || !hasPrivateMode(info))
        return yield* unsafe();
      if (info.size > maxBytes) return yield* unsafe();
      // One byte past the limit shows a file that grew after the check.
      const buffer = new Uint8Array(maxBytes + 1);
      let length = 0;
      while (length < buffer.byteLength) {
        const offset = length;
        const { bytesRead } = yield* tryPrivateFileOperation(() =>
          handle.read(buffer, offset, buffer.byteLength - offset, offset),
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes) return yield* unsafe();
      return new TextDecoder().decode(buffer.subarray(0, length));
    }),
  );

const EXCLUSIVE_CREATE =
  constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

/**
 * Exclusively creates `path` as a 0600 file, writes and syncs `source`, then runs `commit` without
 * interruption while the file is still held. Unless `commit` succeeded, the file this call created
 * is removed; an entry that was already at `path` is never this call's and stays.
 */
const withExclusiveFile = (
  path: string,
  source: string,
  commit: Effect.Effect<void, PrivateFileError>,
): Effect.Effect<void, PrivateFileError> =>
  Effect.gen(function* () {
    let committed = false;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* Effect.acquireRelease(
          tryPrivateFileOperation(() => fs.open(path, EXCLUSIVE_CREATE, 0o600)),
          (opened) =>
            Effect.ignore(tryPrivateFileOperation(() => opened.close())).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  committed
                    ? Effect.void
                    : Effect.ignore(tryPrivateFileOperation(() => fs.unlink(path))),
                ),
              ),
            ),
        );
        yield* tryPrivateFileOperation(() => handle.writeFile(source, "utf8"));
        yield* tryPrivateFileOperation(() => handle.sync());
        yield* tryPrivateFileOperation(() => handle.chmod(0o600));
        // Recording the commit in the same uninterruptible region keeps a late interruption from
        // removing a file the commit already published.
        yield* commit.pipe(
          Effect.andThen(
            Effect.sync(() => {
              committed = true;
            }),
          ),
          Effect.uninterruptible,
        );
      }),
    );
  });

/** Creates `path` as a new 0600 file holding `source`; fails with `exists` when anything is there. */
export const createPrivateFile = (
  path: string,
  source: string,
): Effect.Effect<void, PrivateFileError> => withExclusiveFile(path, source, Effect.void);

/**
 * Writes `source` to `target` as a 0600 file through `temporary`, an exclusively created file in
 * the same directory, replacing `target` only by the final rename. Nothing fallible follows that
 * rename, and the temporary file is removed unless the rename committed it.
 */
export const replacePrivateFile = (
  target: string,
  temporary: string,
  source: string,
): Effect.Effect<void, PrivateFileError> =>
  withExclusiveFile(
    temporary,
    source,
    tryPrivateFileOperation(() => fs.rename(temporary, target)),
  );

/**
 * Removes a non-directory entry of this user without following a link; a missing entry is
 * already removed.
 */
export const removeOwnEntry = (path: string): Effect.Effect<void, PrivateFileError> =>
  tryPrivateFileOperation(() => fs.lstat(path)).pipe(
    Effect.flatMap((info) =>
      info.isDirectory() || !isOwnedByCurrentUser(info)
        ? unsafe()
        : tryPrivateFileOperation(() => fs.unlink(path)),
    ),
    Effect.catchIf(
      (error) => error.reason === "missing",
      () => Effect.void,
    ),
  );

/** Restores owner access to every directory in a private tree, one directory at a time. */
const restoreDirectoryAccess = (path: string): Effect.Effect<void, PrivateFileError> =>
  tryPrivateFileOperation(() => fs.lstat(path)).pipe(
    Effect.flatMap((info) =>
      info.isDirectory()
        ? tryPrivateFileOperation(() => fs.chmod(path, 0o700)).pipe(
            Effect.andThen(tryPrivateFileOperation(() => fs.readdir(path))),
            Effect.flatMap((names) =>
              Effect.forEach(
                names,
                (name) => Effect.suspend(() => restoreDirectoryAccess(nodePath.join(path, name))),
                { discard: true },
              ),
            ),
          )
        : Effect.void,
    ),
  );

const removeTree = (path: string) =>
  tryPrivateFileOperation(() => fs.rm(path, { recursive: true, force: true }));

/**
 * Removes whatever is at `path` without following links; a missing entry is already removed. A
 * process may leave a directory in its private tree without owner write or search access, so such
 * directories are opened back up before a second attempt.
 */
export const removePrivateTree = (path: string): Effect.Effect<void, PrivateFileError> =>
  removeTree(path).pipe(
    Effect.catch(() => restoreDirectoryAccess(path).pipe(Effect.andThen(removeTree(path)))),
  );

/** Removes a private tree whose root must be a real directory of this user, never a link. */
export const removePrivateDirectory = (path: string): Effect.Effect<void, PrivateFileError> =>
  tryPrivateFileOperation(() => fs.lstat(path)).pipe(
    Effect.flatMap((info) =>
      info.isDirectory() && !info.isSymbolicLink() && isOwnedByCurrentUser(info)
        ? removePrivateTree(path)
        : unsafe(),
    ),
  );
