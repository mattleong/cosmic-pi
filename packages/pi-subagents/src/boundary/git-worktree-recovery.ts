import * as Effect from "effect/Effect";
import type { UnavailableWorkspaceArtifact, WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  checkDirectory,
  git,
  gitFields,
  isSharedOrForeign,
  workspaceFailure,
  workspaceIO,
  workspaceIOIfPresent,
} from "./git-worktree-process.ts";
import { readWorkspaceRecord, validWorkspaceId, workspaceDirectory } from "./git-worktree-store.ts";

const registrations = (repository: string) =>
  gitFields(repository, ["worktree", "list", "--porcelain", "-z"]).pipe(
    Effect.map((fields) =>
      fields.filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9)),
    ),
  );

/**
 * Caller holds the store lock and has confirmed process cleanup and record ownership.
 * `keepWorker` removes only the test trees, leaving a worker that still holds files.
 */
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
    // Creation removes a fork's seed before the workspace becomes owned, so one that remains
    // belongs to a failed fork and needs manual recovery.
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
      // A missing directory with a live registration needs manual inspection. Never prune broadly.
      if ((yield* registrations(seedRepository)).includes(path.join(directory, "seed")))
        return yield* workspaceFailure(
          "recovery",
          "Seed registration remains without its editable tree.",
        );
    }
    for (const name of names.filter(
      (name) => removedWorker(name) || /^prepare-[a-f0-9-]{36}$/u.test(name),
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
    for (const workspaceId of names.filter(validWorkspaceId).sort()) {
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
    // A strict record read also checks registry ancestors. Never downgrade a registry
    // failure discovered during the scan to an individual unavailable artifact.
    const after = yield* inspectRegistry(registry);
    if (!after || before.dev !== after.dev || before.ino !== after.ino)
      return yield* workspaceFailure("registry", "Workspace registry changed during listing.");
    return { records, unavailable };
  });
