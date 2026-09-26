import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SafeFile } from "pi-cosmic-core";
import { WorkspaceRecordSchema, type WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  checkDirectory,
  workspaceFailure,
  workspaceIO,
  workspaceIOIfPresent,
  writeWorkspaceFile,
} from "./git-worktree-process.ts";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;

export const newWorkspaceId = () =>
  Effect.try({
    try: () => process.getBuiltinModule("node:crypto").randomUUID(),
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
        // Each newly owned entry must survive a crash, including missing agent-dir
        // ancestors. Recursive mkdir cannot tell us which parents require a flush.
        yield* Effect.gen(function* () {
          yield* workspaceIO("registry", () => fs.mkdir(current, { mode: 0o700 }));
          yield* syncWorkspaceDirectory(parent);
        }).pipe(Effect.uninterruptible);
      }
    }
    yield* checkDirectory(root);
    const stat = yield* workspaceIO("registry", () => fs.lstat(root));
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
      return yield* workspaceFailure(
        "registry",
        "Workspace registry must be private and owned by the current user.",
      );
  });

export const saveWorkspaceRecord = (root: string, record: WorkspaceRecord) =>
  Effect.gen(function* () {
    const directory = workspaceDirectory(root, record.handle.workspaceId);
    yield* checkDirectory(directory);
    const id = yield* newWorkspaceId();
    const temporary = path.join(directory, `${id}.tmp`);
    const data = yield* Schema.encodeEffect(Schema.fromJsonString(WorkspaceRecordSchema))(
      record,
    ).pipe(Effect.mapError(() => workspaceFailure("registry", "Invalid workspace record.")));
    // JSON escaping can exceed the reader's bound even for an allowed raw diff.
    if (Buffer.byteLength(data, "utf8") > MAX_RECORD_BYTES)
      return yield* workspaceFailure(
        "registry",
        "Encoded workspace record exceeds recovery size limit.",
      );
    // Exclusive creation owns the temporary. A crash leaves it for manual recovery.
    yield* writeWorkspaceFile(temporary, new TextEncoder().encode(data), 0o600);
    // Rename is not durable until its containing directory is flushed. Failure after
    // rename is an uncertain registry commit and must stop before source publication.
    yield* Effect.gen(function* () {
      yield* workspaceIO("registry", () =>
        fs.rename(temporary, path.join(directory, "record.json")),
      );
      yield* syncWorkspaceDirectory(directory);
    }).pipe(Effect.uninterruptible);
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
    const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceRecordSchema))(
      new TextDecoder().decode(bytes),
    ).pipe(
      Effect.mapError(() => workspaceFailure("registry", "Invalid workspace recovery record.")),
    );
    if (
      record.handle.workspaceId !== id ||
      path.dirname(record.handle.cwd) === record.handle.sourceRoot
    )
      return yield* workspaceFailure("registry", "Workspace recovery identity is invalid.");
    return record;
  });

/** Cross-process operations serialize too. Crash-left locks require explicit manual review. */
export const withWorkspaceStoreLock = <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    workspaceIO("lock", () => fs.mkdir(path.join(root, "operation.lock"), { mode: 0o700 })),
    () => effect,
    () =>
      workspaceIO("lock", () => fs.rmdir(path.join(root, "operation.lock"))).pipe(Effect.ignore),
  );
