import * as Effect from "effect/Effect";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";
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
export const addWorkspaceTree = Effect.fn("GitWorktreeTrees.addWorkspaceTree")(function* (
  record: WorkspaceRecord,
  checkout: string,
  tree: string,
  commit: string,
) {
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
export const listedWorkspaceTrees = Effect.fn("GitWorktreeTrees.listedWorkspaceTrees")(function* (
  registry: string,
  record: WorkspaceRecord,
) {
  const artifact = workspaceArtifact(registry, record);
  const output = yield* repositoryGit(record.repository, ["worktree", "list", "--porcelain"]);
  const trees: ListedTree[] = [];
  for (const block of Str.split(output, "\n\n")) {
    const lines = Str.split(block, "\n");
    const tree = Fn.pipe(
      Arr.findFirst(lines, (line) => Fn.pipe(line, Str.startsWith("worktree "))),
      Option.map(Str.slice("worktree ".length)),
      Option.filter(Str.startsWith(`${artifact}${path.sep}`)),
    );
    if (Option.isSome(tree))
      trees.push({
        path: tree.value,
        locked: Arr.some(lines, (line) => /^locked(?: |$)/u.test(line)),
      });
  }
  return trees;
});

/**
 * Removes one linked worktree and Git's entry for it, even when its directory is already gone;
 * a directory Git doesn't list, such as one a failed add left, is deleted. Never prunes: that
 * would also drop the user's own entries whose directories are missing.
 */
export const removeWorkspaceTree = Effect.fn("GitWorktreeTrees.removeWorkspaceTree")(function* (
  registry: string,
  record: WorkspaceRecord,
  tree: string,
  listed?: ReadonlyArray<ListedTree>,
) {
  const entry = Option.getOrUndefined(
    Arr.findFirst(
      listed ?? (yield* listedWorkspaceTrees(registry, record)),
      (candidate) => candidate.path === tree,
    ),
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
  WorkspaceError.make({
    ...(error.code !== undefined && { code: error.code }),
    operation: error.operation,
    message: error.message,
    detail: Arr.join(
      Arr.filter([error.detail, outcome], (line) => line !== undefined),
      "\n",
    ),
    ...(error.cleanupUnconfirmed && { cleanupUnconfirmed: true }),
  });
