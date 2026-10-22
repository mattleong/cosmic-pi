import * as Effect from "effect/Effect";
import type { SafeFile } from "pi-cosmic-core";
import { WorkspaceError } from "../workspace/model.ts";
import type { WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "pi-cosmic-core";
import {
  checkDirectory,
  git,
  repositoryGit,
  workspaceIO,
  workspaceIOIfPresent,
} from "./git-worktree-process.ts";
import { workspaceDirectory } from "./git-worktree-store.ts";
import type { BeforeTreeRemoval } from "./git-worktree-hooks.ts";

/** A workspace's private directory, which holds its record, patch, and trees. */
export const workspaceArtifact = (registry: string, record: WorkspaceRecord) =>
  workspaceDirectory(registry, record.handle.workspaceId);
export const workspaceWorker = (registry: string, record: WorkspaceRecord) =>
  path.join(workspaceArtifact(registry, record), "worker");
export const preparationTree = (registry: string, record: WorkspaceRecord, preparationId: string) =>
  path.join(workspaceArtifact(registry, record), `prepare-${preparationId}`);

/** The session directory relative to the source root, which the worker tree mirrors. */
export const workspaceSubdirectory = (record: WorkspaceRecord) =>
  path.relative(record.handle.sourceRoot, record.handle.sourceCwd);

/** Names the workspace in `git worktree list`, so users can tell its trees apart. */
const lockReason = (workspaceId: string) => `pi-subagents workspace ${workspaceId}`;

// Checking out a large tree runs every filter, such as Git LFS, so it may take a while.
const CHECKOUT_TIMEOUT_MILLIS = 10 * 60 * 1000;

/**
 * Adds a locked, detached linked worktree of the record's repository at `tree`, checked out at
 * `commit`. `checkout` is any existing tree of the repository; Git runs the checkout there like a
 * user's `git worktree add`, filters included, but never a hook.
 */
export const addWorkspaceTree = (
  record: WorkspaceRecord,
  checkout: string,
  tree: string,
  commit: string,
) =>
  Effect.gen(function* () {
    yield* git(checkout, ["worktree", "add", "--detach", tree, commit], {
      timeoutMillis: CHECKOUT_TIMEOUT_MILLIS,
    });
    // Locked separately (Git 2.31 has no `add --lock --reason`), so gc never prunes it.
    yield* repositoryGit(record.repository, [
      "worktree",
      "lock",
      "--reason",
      lockReason(record.handle.workspaceId),
      tree,
    ]);
  });

interface ListedTree {
  readonly path: string;
  readonly locked: boolean;
}

/** The repository's linked worktrees inside the workspace's private directory. */
export const listedWorkspaceTrees = (registry: string, record: WorkspaceRecord) =>
  Effect.gen(function* () {
    const artifact = workspaceArtifact(registry, record);
    const output = yield* repositoryGit(record.repository, ["worktree", "list", "--porcelain"]);
    const trees: ListedTree[] = [];
    for (const block of output.split("\n\n")) {
      const lines = block.split("\n");
      const tree = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      if (tree?.startsWith(`${artifact}${path.sep}`))
        trees.push({ path: tree, locked: lines.some((line) => /^locked(?: |$)/u.test(line)) });
    }
    return trees;
  });

/**
 * Removes one linked worktree and Git's entry for it, even when its directory is already gone;
 * a directory Git doesn't list, such as one a failed add left, is deleted. Never prunes: that
 * would also drop the user's own entries whose directories are missing.
 */
export const removeWorkspaceTree = (
  registry: string,
  record: WorkspaceRecord,
  tree: string,
  listed?: ReadonlyArray<ListedTree>,
) =>
  Effect.gen(function* () {
    const entry = (listed ?? (yield* listedWorkspaceTrees(registry, record))).find(
      (candidate) => candidate.path === tree,
    );
    const present = yield* workspaceIOIfPresent("discard", () => fs.lstat(tree));
    if (entry?.locked) yield* repositoryGit(record.repository, ["worktree", "unlock", tree]);
    if (present) yield* checkDirectory(tree);
    if (entry)
      return yield* repositoryGit(record.repository, ["worktree", "remove", "--force", tree]);
    if (present) yield* workspaceIO("discard", () => fs.rm(tree, { recursive: true, force: true }));
    return "";
  });

/**
 * Best effort: a tree that can't be removed stays for integrate or discard to clean up. A
 * failing `beforeRemove` keeps it too. Returns the failure that kept the tree, or undefined once
 * it is gone.
 */
export const removePreparation = (
  registry: string,
  record: WorkspaceRecord,
  preparationId: string,
  beforeRemove?: BeforeTreeRemoval,
): Effect.Effect<WorkspaceError | undefined, never, SafeFile> => {
  const tree = preparationTree(registry, record, preparationId);
  return (beforeRemove ? beforeRemove(record, tree) : Effect.void).pipe(
    Effect.andThen(removeWorkspaceTree(registry, record, tree)),
    Effect.as(undefined),
    Effect.catchTag("WorkspaceError", (error) =>
      Effect.logWarning(`Failed preparation tree remains on disk: ${error.message}`).pipe(
        Effect.annotateLogs({ workspaceId: record.handle.workspaceId, tree }),
        Effect.as(error),
      ),
    ),
    Effect.uninterruptible,
  );
};

// Failure messages don't say what happened to a partial workspace or rebuilt tree; callers add it.
export const withOutcome = (error: WorkspaceError, outcome: string) =>
  new WorkspaceError({
    ...(error.code !== undefined && { code: error.code }),
    operation: error.operation,
    message: error.message,
    detail: [error.detail, outcome].filter((line) => line !== undefined).join("\n"),
    ...(error.cleanupUnconfirmed && { cleanupUnconfirmed: true }),
  });
