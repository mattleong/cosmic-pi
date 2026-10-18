import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const nodeFs = process.getBuiltinModule("node:fs");
if (!nodeFs) throw new Error("The Node fs builtin is unavailable.");
const { constants, promises: fs } = nodeFs;
type Stats = Awaited<ReturnType<typeof fs.lstat>>;

/**
 * `missing`: nothing is at the path; `exists`: something is where a new entry was to be created;
 * `unsafe`: an entry is there, but it is a link, the wrong kind of entry, another user's, readable
 * by others, or too large; `failed`: the OS refused otherwise.
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

const attempt = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<A, PrivateFileError> =>
  Effect.tryPromise({ try: evaluate, catch: classify });

const unsafe = () => Effect.fail(new PrivateFileError({ reason: "unsafe" }));

const ownUid = (): number | undefined => process.getuid?.();

const ownedByUser = (info: Stats): boolean => {
  const uid = ownUid();
  return uid !== undefined && info.uid === uid;
};

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

const withHandle = <A>(
  path: string,
  flags: number,
  use: (handle: FileHandle) => Effect.Effect<A, PrivateFileError>,
  mode?: number,
): Effect.Effect<A, PrivateFileError> =>
  Effect.acquireUseRelease(
    attempt(() => fs.open(path, flags, mode)),
    use,
    (handle) => Effect.ignore(attempt(() => handle.close())),
  );

/** Requires the open directory to be a real directory of this user, then makes it 0700. */
const secureOpenDirectory = (path: string) =>
  withHandle(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, (handle) =>
    Effect.gen(function* () {
      const info = yield* attempt(() => handle.stat());
      if (!info.isDirectory() || !ownedByUser(info)) return yield* unsafe();
      return yield* attempt(() => handle.chmod(0o700));
    }),
  );

/**
 * Creates `path` as a 0700 directory, or accepts an existing one only when it is a real directory
 * of this user, never a link, and then tightens it to 0700.
 */
export const ensurePrivateDirectory = (path: string): Effect.Effect<void, PrivateFileError> =>
  attempt(() => fs.mkdir(path, { mode: 0o700 })).pipe(
    Effect.catchIf(
      (error) => error.reason === "exists",
      () => Effect.void,
    ),
    Effect.andThen(secureOpenDirectory(path)),
  );

/** Creates `path` and any missing parents; directories it creates are 0700. */
export const ensureDirectoryPath = (path: string): Effect.Effect<void, PrivateFileError> =>
  Effect.asVoid(attempt(() => fs.mkdir(path, { recursive: true, mode: 0o700 })));

/** Creates `path` as a new 0700 directory; fails when anything is already there. */
export const createPrivateDirectory = (path: string): Effect.Effect<void, PrivateFileError> =>
  attempt(() => fs.mkdir(path, { mode: 0o700 })).pipe(Effect.andThen(secureOpenDirectory(path)));

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
      info.isDirectory() && ownedByUser(info)
        ? Effect.succeed({ device: info.dev, inode: info.ino, modifiedMillis: info.mtimeMs })
        : unsafe(),
    ),
  );

export const sameDirectory = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  left.device === right.device && left.inode === right.inode;

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
      const info = yield* attempt(() => handle.stat());
      if (!info.isFile() || !ownedByUser(info) || (info.mode & 0o077) !== 0 || info.size > maxBytes)
        return yield* unsafe();
      // One byte past the limit shows a file that grew after the check.
      const buffer = new Uint8Array(maxBytes + 1);
      let length = 0;
      while (length < buffer.byteLength) {
        const offset = length;
        const { bytesRead } = yield* attempt(() =>
          handle.read(buffer, offset, buffer.byteLength - offset, offset),
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes) return yield* unsafe();
      return new TextDecoder().decode(buffer.subarray(0, length));
    }),
  );

/**
 * Writes `source` to `target` as a 0600 file through an exclusively created temporary file in the
 * same directory, replacing `target` only by the final rename. The temporary file is removed
 * unless the rename committed it; an entry that was already at its path is never this write's.
 */
export const writePrivateFile = (
  target: string,
  temporary: string,
  source: string,
): Effect.Effect<void, PrivateFileError> =>
  Effect.gen(function* () {
    let committed = false;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* Effect.acquireRelease(
          attempt(() =>
            fs.open(
              temporary,
              constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
              0o600,
            ),
          ),
          (opened) =>
            Effect.ignore(attempt(() => opened.close())).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  committed ? Effect.void : Effect.ignore(attempt(() => fs.unlink(temporary))),
                ),
              ),
            ),
        );
        yield* attempt(() => handle.writeFile(`${source}\n`, "utf8"));
        yield* attempt(() => handle.sync());
        yield* attempt(() => handle.chmod(0o600));
        yield* attempt(() => fs.rename(temporary, target)).pipe(
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

/**
 * Removes a non-directory entry of this user without following a link; a missing entry is
 * already removed.
 */
export const removeOwnEntry = (path: string): Effect.Effect<void, PrivateFileError> =>
  attempt(() => fs.lstat(path)).pipe(
    Effect.flatMap((info) =>
      info.isDirectory() || !ownedByUser(info) ? unsafe() : attempt(() => fs.unlink(path)),
    ),
    Effect.catchIf(
      (error) => error.reason === "missing",
      () => Effect.void,
    ),
  );

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
      info.isSocket() && ownedByUser(info) ? attempt(() => fs.chmod(path, 0o600)) : unsafe(),
    ),
  );

/** The current user's id, which names this user's private fallback socket namespace. */
export const currentUserId = (): number | undefined => ownUid();
