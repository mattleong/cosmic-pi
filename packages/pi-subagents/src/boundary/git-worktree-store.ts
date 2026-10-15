import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  crossProcessLockHolder,
  SafeFile,
  synchronousRandomUuid,
  type CrossProcessLease,
  type CrossProcessLockContract,
  type CrossProcessLockError,
} from "pi-cosmic-core";
import { WorkspaceError, WorkspaceRecordSchema, type WorkspaceRecord } from "../workspace/model.ts";
import { nodeErrorCode } from "./harness-shared.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
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

export const initializeWorkspaceStore = (root: string) =>
  Effect.gen(function* () {
    const absolute = path.resolve(root);
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
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
  });

export const saveWorkspaceRecord = (
  root: string,
  record: WorkspaceRecord,
  onCommitted?: () => void,
) =>
  Effect.gen(function* () {
    const directory = workspaceDirectory(root, record.handle.workspaceId);
    yield* checkDirectory(directory);
    const id = yield* newWorkspaceId;
    const temporary = path.join(directory, `${id}.tmp`);
    const data = yield* encodeRecord(record).pipe(
      Effect.mapError(() => workspaceFailure("registry", "Invalid workspace record.")),
    );
    if (Buffer.byteLength(data, "utf8") > MAX_RECORD_BYTES)
      return yield* workspaceFailure(
        "registry",
        "Encoded workspace record exceeds recovery size limit.",
      );
    yield* writeWorkspaceFile(temporary, new TextEncoder().encode(data), 0o600);
    yield* Effect.gen(function* () {
      yield* workspaceIO("registry", () =>
        fs.rename(temporary, path.join(directory, "record.json")),
      );
      yield* syncWorkspaceDirectory(directory);
      onCommitted?.();
    }).pipe(Effect.uninterruptible);
    return undefined;
  });

export const readWorkspaceRecord = (root: string, id: string) =>
  Effect.gen(function* () {
    if (!validWorkspaceId(id))
      return yield* workspaceFailure("authorization", "Unknown workspace identity.");
    const directory = workspaceDirectory(root, id);
    yield* checkDirectory(directory);
    const safe = yield* SafeFile;
    const { bytes } = yield* safe
      .readContainedRegularFile(path.join(directory, "record.json"), root, MAX_RECORD_BYTES)
      .pipe(
        Effect.mapError(() =>
          workspaceFailure("registry", "Cannot read workspace recovery record."),
        ),
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
export const WORKSPACE_LOCK_WAIT = Duration.minutes(2);
const WORKSPACE_LOCK_POLL = Duration.millis(200);

export const workspaceLockDirectory = (registry: string) => path.join(registry, "locks");
export const sourceLockNamespace = (sourceRoot: string) => `workspace-source:${sourceRoot}`;

const lockFailure = (error: CrossProcessLockError, directory: string) =>
  new WorkspaceError({
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
  return new WorkspaceError({
    operation: "lock",
    message: "Another Pi session is still changing workspaces for this checkout.",
    detail: [
      `Lock: ${holder.slot}`,
      `Owner: ${holder.ownerPid === undefined ? "unknown process" : `process ${holder.ownerPid}`}`,
      `Waited ${Duration.format(WORKSPACE_LOCK_WAIT)}. Try again once that operation finishes; a lock whose process has exited is reclaimed automatically.`,
    ].join("\n"),
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
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(WORKSPACE_LOCK_WAIT);
    const attempt: Effect.Effect<A, E | WorkspaceError, R> = withFreeLock(
      locks,
      directory,
      sourceLockNamespace(sourceRoot),
      effect,
    ).pipe(
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                now >= deadline
                  ? Effect.fail(lockTimeout(sourceRoot, directory))
                  : Effect.sleep(WORKSPACE_LOCK_POLL).pipe(Effect.andThen(() => attempt)),
              ),
            ),
      ),
    );
    return yield* attempt;
  });
