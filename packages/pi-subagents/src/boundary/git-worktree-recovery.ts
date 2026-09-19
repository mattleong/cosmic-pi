import * as Effect from "effect/Effect";
import type { WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import { checkDirectory, git, workspaceFailure, workspaceIO } from "./git-worktree-process.ts";
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

/** Caller holds the store lock and has confirmed process cleanup and record ownership. */
export const removeWorkspaceTrees = (registry: string, record: WorkspaceRecord) =>
  Effect.gen(function* () {
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
      (name) => name === "worker" || /^prepare-[a-f0-9-]{36}$/u.test(name),
    )) {
      const tree = path.join(directory, name);
      yield* checkDirectory(tree);
      yield* git(repository, ["worktree", "remove", "--force", tree]);
    }
    const remaining = yield* workspaceIO("discard", () => fs.readdir(directory));
    if (
      remaining.some((name) => name === "seed" || name === "worker" || name.startsWith("prepare-"))
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

export const listWorkspaceRecords = (registry: string) =>
  Effect.gen(function* () {
    yield* checkDirectory(registry, true);
    const stat = yield* workspaceIO("registry", () =>
      fs.lstat(registry).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }),
    );
    if (!stat) return [];
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
      return yield* workspaceFailure("registry", "Workspace registry permissions are invalid.");
    const names = yield* workspaceIO("registry", () => fs.readdir(registry));
    return yield* Effect.forEach(names.filter(validWorkspaceId), (name) =>
      readWorkspaceRecord(registry, name),
    );
  });
