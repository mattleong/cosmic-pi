import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SafeFile } from "pi-cosmic-core";
import type {
  UnavailableWorkspaceArtifact,
  WorkspaceError,
  WorkspaceRecord,
} from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  checkDirectory,
  git,
  isSharedOrForeign,
  workspaceFailure,
  workspaceIO,
  workspaceIOIfPresent,
} from "./git-worktree-process.ts";
import {
  readWorkspaceRecord,
  syncWorkspaceDirectory,
  validWorkspaceId,
  workspaceDirectory,
} from "./git-worktree-store.ts";

// Line-based porcelain works with Git before 2.36; workspace paths never contain a newline.
const registrations = (repository: string) =>
  git(repository, ["worktree", "list", "--porcelain"]).pipe(
    Effect.map((output) =>
      output
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice(9)),
    ),
  );

export const removeWorkspaceTrees = (
  registry: string,
  record: WorkspaceRecord,
  keepWorker = false,
) =>
  Effect.gen(function* () {
    const removedWorker = (name: string) => name === "worker" && !keepWorker;
    const directory = workspaceDirectory(registry, record.handle.workspaceId);
    const repository = path.join(directory, "repo.git");
    const names = yield* workspaceIO("discard", () => fs.readdir(directory));
    if (names.includes("seed"))
      return yield* workspaceFailure(
        "recovery",
        "A fork seed remains; manual recovery is required.",
      );
    if (record.predecessorWorkspaceId !== undefined) {
      if (
        !validWorkspaceId(record.predecessorWorkspaceId) ||
        record.predecessorWorkspaceId === record.handle.workspaceId
      )
        return yield* workspaceFailure("recovery", "Invalid predecessor workspace identity.");
      const predecessor = yield* readWorkspaceRecord(registry, record.predecessorWorkspaceId);
      if (
        predecessor.handle.ownerId !== record.handle.ownerId ||
        predecessor.handle.sourceRoot !== record.handle.sourceRoot ||
        predecessor.handle.sourceCwd !== record.handle.sourceCwd
      )
        return yield* workspaceFailure(
          "recovery",
          "Predecessor ownership or source identity does not match.",
        );
      const seedRepository = path.join(
        workspaceDirectory(registry, predecessor.handle.workspaceId),
        "repo.git",
      );
      yield* checkDirectory(seedRepository);
      if ((yield* registrations(seedRepository)).includes(path.join(directory, "seed")))
        return yield* workspaceFailure(
          "recovery",
          "Seed registration remains without its editable tree.",
        );
    }
    for (const name of names.filter(
      (entry) => removedWorker(entry) || /^prepare-[a-f0-9-]{36}$/u.test(entry),
    )) {
      const tree = path.join(directory, name);
      yield* checkDirectory(tree);
      yield* git(repository, ["worktree", "remove", "--force", tree]);
    }
    const remaining = yield* workspaceIO("discard", () => fs.readdir(directory));
    if (remaining.some((name) => removedWorker(name) || name.startsWith("prepare-")))
      return yield* workspaceFailure(
        "recovery",
        "Editable workspace trees remain; discard is incomplete.",
      );
    return undefined;
  });

const inspectRegistry = (registry: string) =>
  Effect.gen(function* () {
    yield* checkDirectory(registry, true);
    const stat = yield* workspaceIOIfPresent("registry", () => fs.lstat(registry));
    if (!stat) return undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink() || isSharedOrForeign(stat))
      return yield* workspaceFailure(
        "registry",
        "Workspace registry path or permissions are invalid.",
      );
    return stat;
  });

export const listWorkspaceRecords = (registry: string) =>
  Effect.gen(function* () {
    const records: WorkspaceRecord[] = [];
    const unavailable: UnavailableWorkspaceArtifact[] = [];
    const before = yield* inspectRegistry(registry);
    if (!before) return { records, unavailable };
    const names = yield* workspaceIO("registry", () => fs.readdir(registry));
    for (const workspaceId of names.filter(validWorkspaceId).toSorted()) {
      const record = yield* readWorkspaceRecord(registry, workspaceId).pipe(
        Effect.catchTag("WorkspaceError", () => Effect.void),
      );
      if (record) records.push(record);
      else
        unavailable.push({
          workspaceId,
          status: "unavailable",
          reason: "recovery-record-unavailable",
        });
    }
    const after = yield* inspectRegistry(registry);
    if (!after || before.dev !== after.dev || before.ino !== after.ino)
      return yield* workspaceFailure("registry", "Workspace registry changed during listing.");
    return { records, unavailable };
  });

/** Discarded and integrated records stay this long for inspection, like delivered reports. */
export const WORKSPACE_RECORD_RETENTION = Duration.days(7);

const COLLECTED_PREFIX = ".collected-";

const finished = (record: WorkspaceRecord) =>
  record.status === "discarded" || record.status === "integrated";

const editableTree = (name: string) =>
  name === "worker" || name === "seed" || name.startsWith("prepare-");

// Renaming first keeps a half-removed directory out of every listing.
const removeCollected = (registry: string, workspaceId: string) =>
  Effect.gen(function* () {
    const retired = path.join(registry, `${COLLECTED_PREFIX}${workspaceId}`);
    yield* Effect.gen(function* () {
      yield* workspaceIO("collect", () =>
        fs.rename(workspaceDirectory(registry, workspaceId), retired),
      );
      yield* syncWorkspaceDirectory(registry);
    }).pipe(Effect.uninterruptible);
    yield* workspaceIO("collect", () => fs.rm(retired, { recursive: true, force: true }));
  });

const collectRecord = (registry: string, workspaceId: string, now: number) =>
  Effect.gen(function* () {
    const record = yield* readWorkspaceRecord(registry, workspaceId);
    if (!finished(record)) return false;
    const directory = workspaceDirectory(registry, workspaceId);
    yield* checkDirectory(directory);
    const saved = yield* workspaceIO("collect", () => fs.stat(path.join(directory, "record.json")));
    if (now - saved.mtimeMs < Duration.toMillis(WORKSPACE_RECORD_RETENTION)) return false;
    const names = yield* workspaceIO("collect", () => fs.readdir(directory));
    if (names.some(editableTree)) return false;
    yield* removeCollected(registry, workspaceId);
    return true;
  });

export interface WorkspaceCollection {
  readonly now: number;
  /** Records this session still owns are never collected. */
  readonly owned: (workspaceId: string) => boolean;
  /** Runs under the source checkout's lock, or returns none while another session holds it. */
  readonly whenSourceFree: (
    sourceRoot: string,
    effect: Effect.Effect<boolean, WorkspaceError, SafeFile>,
  ) => Effect.Effect<Option.Option<boolean>, WorkspaceError, SafeFile>;
}

/**
 * Deletes discarded and integrated records once they are a week old, unless an editable tree
 * remains (such as a worker kept for files integration left out) or a later fork still names
 * the record as its predecessor. Unreadable artifacts are never touched.
 */
export const collectWorkspaceRecords = (registry: string, collection: WorkspaceCollection) =>
  Effect.gen(function* () {
    const { records } = yield* listWorkspaceRecords(registry);
    const referenced = new Set(records.flatMap((record) => record.predecessorWorkspaceId ?? []));
    const collected: string[] = [];
    for (const record of records) {
      const workspaceId = record.handle.workspaceId;
      if (!finished(record) || referenced.has(workspaceId) || collection.owned(workspaceId))
        continue;
      const removed = yield* collection
        .whenSourceFree(
          record.handle.sourceRoot,
          collectRecord(registry, workspaceId, collection.now),
        )
        .pipe(
          Effect.catchTag("WorkspaceError", (error) =>
            Effect.logWarning(`Workspace record was not collected: ${error.message}`).pipe(
              Effect.annotateLogs("workspaceId", workspaceId),
              Effect.as(Option.none<boolean>()),
            ),
          ),
        );
      if (Option.getOrElse(removed, () => false)) collected.push(workspaceId);
    }
    const names = yield* workspaceIOIfPresent("collect", () => fs.readdir(registry));
    for (const name of names ?? [])
      if (name.startsWith(COLLECTED_PREFIX))
        yield* workspaceIO("collect", () =>
          fs.rm(path.join(registry, name), { recursive: true, force: true }),
        );
    return collected;
  });
