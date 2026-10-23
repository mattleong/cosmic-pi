import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import {
  crossProcessLockHolder,
  type CrossProcessLease,
  type CrossProcessLockContract,
  type CrossProcessLockError,
} from "pi-cosmic-core/platform/cross-process-lock";
import { SafeFile } from "pi-cosmic-core/platform/safe-file";
import { synchronousRandomUuid } from "pi-cosmic-core/platform/native-crypto";
import { nodeFsPromises as fs, nodePath as path } from "pi-cosmic-core/platform/node-builtins";
import { WorkspaceError, WorkspaceRecordSchema, type WorkspaceRecord } from "../workspace/model.ts";
import { nodeErrorCode } from "./harness-shared.ts";
import {
  checkDirectory,
  isSharedOrForeign,
  workspaceFailure,
  workspaceIO,
  workspaceIOIfPresent,
  writeWorkspaceFile,
} from "./git-worktree-process.ts";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(WorkspaceRecordSchema));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceRecordSchema));

export const newWorkspaceId = Effect.try({
  try: synchronousRandomUuid,
  catch: () => workspaceFailure("identity", "Unable to allocate workspace identity."),
});
export const validWorkspaceId = (id: string) => /^[a-f0-9-]{36}$/u.test(id);
export const workspaceDirectory = (root: string, id: string) => path.join(root, id);

export const syncWorkspaceDirectory = (directory: string) =>
  Effect.acquireUseRelease(
    workspaceIO("registry", () => fs.open(directory, "r")),
    (handle) => workspaceIO("registry", () => handle.sync()),
    (handle) => workspaceIO("registry", () => handle.close()).pipe(Effect.ignore),
  );

export const initializeWorkspaceStore = Effect.fn("GitWorktreeStore.initializeWorkspaceStore")(
  function* (root: string) {
    const absolute = path.resolve(root);
    let current = path.parse(absolute).root;
    for (const part of Arr.filter(
      Str.split(Fn.pipe(absolute, Str.slice(current.length)), path.sep),
      Boolean,
    )) {
      const parent = current;
      current = path.join(current, part);
      const stat = yield* workspaceIOIfPresent("registry", () => fs.lstat(current));
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink())
          return yield* workspaceFailure("registry", "Registry ancestor is not a real directory.");
      } else {
        // Another process may create the same directory first; the final check covers both.
        yield* Effect.gen(function* () {
          yield* workspaceIO("registry", () =>
            fs.mkdir(current, { mode: 0o700 }).catch((cause: unknown) => {
              if (nodeErrorCode(cause) !== "EEXIST") throw cause;
            }),
          );
          yield* syncWorkspaceDirectory(parent);
        }).pipe(Effect.uninterruptible);
      }
    }
    yield* checkDirectory(root);
    if (isSharedOrForeign(yield* workspaceIO("registry", () => fs.lstat(root))))
      return yield* workspaceFailure(
        "registry",
        "Workspace registry must be private and owned by the current user.",
      );
    return undefined;
  },
);

export const saveWorkspaceRecord = Effect.fn("GitWorktreeStore.saveWorkspaceRecord")(function* (
  root: string,
  record: WorkspaceRecord,
  onCommitted?: () => void,
) {
  const directory = workspaceDirectory(root, record.handle.workspaceId);
  yield* checkDirectory(directory);
  const id = yield* newWorkspaceId;
  const temporary = path.join(directory, `${id}.tmp`);
  const lastChangedAt = yield* Clock.currentTimeMillis;
  const data = yield* encodeRecord({ ...record, lastChangedAt }).pipe(
    Effect.mapError(() => workspaceFailure("registry", "Invalid workspace record.")),
  );
  if (Buffer.byteLength(data, "utf8") > MAX_RECORD_BYTES)
    return yield* workspaceFailure(
      "registry",
      "Encoded workspace record exceeds recovery size limit.",
    );
  yield* writeWorkspaceFile(temporary, new TextEncoder().encode(data), 0o600);
  yield* Effect.gen(function* () {
    yield* workspaceIO("registry", () => fs.rename(temporary, path.join(directory, "record.json")));
    yield* syncWorkspaceDirectory(directory);
    onCommitted?.();
  }).pipe(Effect.uninterruptible);
  return undefined;
});

// Git's own stdout bound for workspace commands.
export const MAX_REVISION_DIFF_BYTES = 48 * 1024 * 1024;
export const revisionDiffFile = (root: string, id: string) =>
  path.join(workspaceDirectory(root, id), "revision.diff");

/**
 * Moves a checked patch file into place as the workspace's current revision patch. Freeze commits
 * it before the record that names the revision, so a frozen record's patch is always this file.
 */
export const commitRevisionDiff = Effect.fn("GitWorktreeStore.commitRevisionDiff")(function* (
  root: string,
  id: string,
  file: string,
) {
  yield* workspaceIO("freeze", () => fs.rename(file, revisionDiffFile(root, id)));
  yield* syncWorkspaceDirectory(workspaceDirectory(root, id));
}, Effect.uninterruptible);

/** The current revision patch's bytes, kept out of the record so listings stay small. */
export const readRevisionDiff = Effect.fn("GitWorktreeStore.readRevisionDiff")(function* (
  root: string,
  id: string,
) {
  const safe = yield* SafeFile;
  const { bytes } = yield* safe
    .readContainedRegularFile(revisionDiffFile(root, id), root, MAX_REVISION_DIFF_BYTES)
    .pipe(Effect.mapError(() => workspaceFailure("revision", "Cannot read the revision patch.")));
  return bytes;
});

export const readWorkspaceRecord = Effect.fn("GitWorktreeStore.readWorkspaceRecord")(function* (
  root: string,
  id: string,
) {
  if (!validWorkspaceId(id))
    return yield* workspaceFailure("authorization", "Unknown workspace identity.");
  const directory = workspaceDirectory(root, id);
  yield* checkDirectory(directory);
  const safe = yield* SafeFile;
  const { bytes } = yield* safe
    .readContainedRegularFile(path.join(directory, "record.json"), root, MAX_RECORD_BYTES)
    .pipe(
      Effect.mapError(() => workspaceFailure("registry", "Cannot read workspace recovery record.")),
    );
  const record = yield* decodeRecord(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError(() => workspaceFailure("registry", "Invalid workspace recovery record.")),
  );
  if (
    record.handle.workspaceId !== id ||
    path.dirname(record.handle.cwd) === record.handle.sourceRoot
  )
    return yield* workspaceFailure("registry", "Workspace recovery identity is invalid.");
  return record;
});

/** How long a workspace operation waits for another session's operation on the same checkout. */
const WORKSPACE_LOCK_WAIT = Duration.minutes(2);
const WORKSPACE_LOCK_POLL = Duration.millis(200);

export const workspaceLockDirectory = (registry: string) => path.join(registry, "locks");
export const sourceLockNamespace = (sourceRoot: string) => `workspace-source:${sourceRoot}`;

/** Held by a live engine; free once the session that created a workspace has ended. */
export const ownerLockNamespace = (token: string) => `workspace-owner:${token}`;

const lockFailure = (error: CrossProcessLockError, directory: string) =>
  WorkspaceError.make({
    operation: "lock",
    message:
      error.reason === "recovery-required"
        ? "The workspace lock for this checkout needs manual recovery."
        : "The workspace lock for this checkout couldn't be prepared.",
    detail:
      error.reason === "recovery-required"
        ? `Lock: ${error.slot ?? directory}\nIts owner evidence is damaged or its directory permissions are unsafe. Remove that lock directory only after confirming no Pi session is changing workspaces for this checkout.`
        : `Lock directory: ${directory}\nIt must be a private directory owned by the current user.`,
  });

const lockTimeout = (sourceRoot: string, directory: string) => {
  const holder = crossProcessLockHolder(sourceLockNamespace(sourceRoot), { directory });
  return WorkspaceError.make({
    operation: "lock",
    message: "Another Pi session is still changing workspaces for this checkout.",
    detail: Arr.join(
      [
        `Lock: ${holder.slot}`,
        `Owner: ${holder.ownerPid === undefined ? "unknown process" : `process ${holder.ownerPid}`}`,
        `Waited ${Duration.format(WORKSPACE_LOCK_WAIT)}. Try again once that operation finishes; a lock whose process has exited is reclaimed automatically.`,
      ],
      "\n",
    ),
  });
};

const releaseLease = (lease: CrossProcessLease) =>
  Effect.try({
    try: () => lease.release(),
    catch: () => workspaceFailure("lock", "The workspace lock couldn't be released."),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`${error.message} It is reclaimed once this process exits.`),
    ),
  );

/** Runs `effect` under a lease on `namespace` when it is free, without waiting. */
export const withFreeLock = <A, E, R>(
  locks: CrossProcessLockContract,
  directory: string,
  namespace: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E | WorkspaceError, R> =>
  Effect.acquireUseRelease(
    locks.tryAcquire(namespace).pipe(Effect.mapError((error) => lockFailure(error, directory))),
    (lease) => (lease ? Effect.asSome(effect) : Effect.succeed(Option.none<A>())),
    (lease) => (lease ? releaseLease(lease) : Effect.void),
  );

/**
 * Serializes workspace operations on one source checkout across every Pi process sharing the
 * agent directory, waiting interruptibly for another session's operation to finish.
 */
export const withWorkspaceStoreLock = <A, E, R>(
  locks: CrossProcessLockContract,
  directory: string,
  sourceRoot: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | WorkspaceError, R> =>
  withFreeLock(locks, directory, sourceLockNamespace(sourceRoot), effect).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(WORKSPACE_LOCK_POLL).pipe(
        Schedule.upTo({ duration: WORKSPACE_LOCK_WAIT }),
      ),
      until: Option.isSome,
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(lockTimeout(sourceRoot, directory)),
        onSome: (value) => Effect.succeed(value),
      }),
    ),
  );
