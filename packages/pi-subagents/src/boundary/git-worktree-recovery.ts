import * as Effect from "effect/Effect";
import type { UnavailableWorkspaceArtifact, WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  checkDirectory,
  git,
  workspaceFailure,
  workspaceIO,
  workspaceIOIfPresent,
} from "./git-worktree-process.ts";
import { readWorkspaceRecord, validWorkspaceId, workspaceDirectory } from "./git-worktree-store.ts";

const registrations = (repository: string) =>
  git(repository, ["worktree", "list", "--porcelain", "-z"]).pipe(
    Effect.map((output) =>
      output
        .split("\0")
        .filter((field) => field.startsWith("worktree "))
        .map((field) => field.slice(9)),
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
    const seed = path.join(directory, "seed");
    let seedRepository: string | undefined;
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
      seedRepository = path.join(
        workspaceDirectory(registry, predecessor.handle.workspaceId),
        "repo.git",
      );
      yield* checkDirectory(seedRepository);
      const registered = (yield* registrations(seedRepository)).filter((entry) => entry === seed);
      if (names.includes("seed")) {
        yield* checkDirectory(seed);
        const common = (yield* git(seed, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])).trim();
        if (common !== seedRepository || registered.length !== 1)
          return yield* workspaceFailure(
            "recovery",
            "Seed does not match the expected repository registration.",
          );
      } else if (registered.length !== 0) {
        // A missing directory with a live registration needs manual inspection. Never prune broadly.
        return yield* workspaceFailure(
          "recovery",
          "Seed registration remains without its editable tree.",
        );
      } else seedRepository = undefined;
    } else if (names.includes("seed")) {
      return yield* workspaceFailure(
        "recovery",
        "Seed predecessor provenance is missing; manual recovery is required.",
      );
    }
    // Validate seed provenance before deleting any of this proposal's editable trees.
    if (seedRepository) yield* git(seedRepository, ["worktree", "remove", "--force", seed]);
    for (const name of names.filter(
      (name) => removedWorker(name) || /^prepare-[a-f0-9-]{36}$/u.test(name),
    )) {
      const tree = path.join(directory, name);
      yield* checkDirectory(tree);
      yield* git(repository, ["worktree", "remove", "--force", tree]);
    }
    const remaining = yield* workspaceIO("discard", () => fs.readdir(directory));
    if (
      remaining.some(
        (name) => name === "seed" || removedWorker(name) || name.startsWith("prepare-"),
      )
    )
      return yield* workspaceFailure(
        "recovery",
        "Editable workspace trees remain; discard is incomplete.",
      );
    if (seedRepository && (yield* registrations(seedRepository)).includes(seed))
      return yield* workspaceFailure(
        "recovery",
        "Seed registration remains; discard is incomplete.",
      );
  });

const inspectRegistry = (registry: string) =>
  Effect.gen(function* () {
    yield* checkDirectory(registry, true);
    const stat = yield* workspaceIOIfPresent("registry", () => fs.lstat(registry));
    if (!stat) return undefined;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
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
        Effect.catchTag("WorkspaceError", () => Effect.succeed(undefined)),
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
