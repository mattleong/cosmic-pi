import * as Effect from "effect/Effect";
import { WorkspaceError } from "../workspace/model.ts";
import type { WorkspaceRecord, WorkspaceRevisionMetadata } from "../workspace/model.ts";
import { blockingUncapturedPath } from "../workspace/policy.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  checkDirectory,
  git,
  gitFields,
  listedPaths,
  workspaceIOIfPresent,
} from "./git-worktree-process.ts";
import { captureSnapshot, type CaptureOptions, readSnapshot } from "./git-worktree-snapshot.ts";
import { workspaceDirectory } from "./git-worktree-store.ts";

/** A workspace's private directory, which holds its repository, record, and trees. */
export const workspaceArtifact = (registry: string, record: WorkspaceRecord) =>
  workspaceDirectory(registry, record.handle.workspaceId);
export const workspaceRepository = (registry: string, record: WorkspaceRecord) =>
  path.join(workspaceArtifact(registry, record), "repo.git");
export const workspaceWorker = (registry: string, record: WorkspaceRecord) =>
  path.join(workspaceArtifact(registry, record), "worker");
export const preparationTree = (registry: string, record: WorkspaceRecord, preparationId: string) =>
  path.join(workspaceArtifact(registry, record), `prepare-${preparationId}`);

/** The session directory relative to the source root, which the worker tree mirrors. */
export const workspaceSubdirectory = (record: WorkspaceRecord) =>
  path.relative(record.handle.sourceRoot, record.handle.sourceCwd);

// A nested workspace's source is a private worker tree. Like worker captures, its content already
// lives in private storage, so it isn't scanned for credentials, and only the ignore rules its
// repository recorded apply.
export const sourceCapture = (record: WorkspaceRecord): CaptureOptions =>
  record.handle.sourceWorkspaceId === undefined
    ? { userCheckout: true }
    : { privateRepository: true };

// The baseline's files and the revision's changes are captured even where they're untracked.
const requiredPaths = (registry: string, record: WorkspaceRecord) =>
  Effect.gen(function* () {
    const paths = record.baseline
      ? yield* gitFields(workspaceRepository(registry, record), [
          "ls-tree",
          "-r",
          "--name-only",
          "-z",
          record.baseline,
        ])
      : [];
    if (record.revision) paths.push(...record.revision.changedPaths);
    return paths;
  });

/** Stores the tree's files as a commit at refs/pi/<reference>. */
export const captureTree = (
  registry: string,
  record: WorkspaceRecord,
  root: string,
  reference: string,
  options: Omit<CaptureOptions, "requiredPaths"> = {},
) =>
  Effect.gen(function* () {
    return yield* captureSnapshot(root, workspaceRepository(registry, record), reference, {
      ...options,
      requiredPaths: yield* requiredPaths(registry, record),
    });
  });

/**
 * Reads and checks the tree like captureTree, but only computes its tree id: verifications
 * compare it with a tree Git already stored.
 */
export const readTree = (
  registry: string,
  record: WorkspaceRecord,
  root: string,
  options: Omit<CaptureOptions, "requiredPaths"> = {},
) =>
  Effect.gen(function* () {
    return yield* readSnapshot(root, {
      ...options,
      requiredPaths: yield* requiredPaths(registry, record),
    });
  });

/** Best effort: a tree that can't be removed stays for integrate or discard to clean up. */
export const removePreparation = (
  registry: string,
  record: WorkspaceRecord,
  preparationId: string,
) => {
  const tree = preparationTree(registry, record, preparationId);
  return Effect.gen(function* () {
    if (!(yield* workspaceIOIfPresent("prepare", () => fs.lstat(tree)))) return;
    yield* checkDirectory(tree);
    yield* git(workspaceRepository(registry, record), ["worktree", "remove", "--force", tree]);
  }).pipe(
    Effect.catchTag("WorkspaceError", (error) =>
      Effect.logWarning(`Failed preparation tree remains on disk: ${error.message}`).pipe(
        Effect.annotateLogs({ workspaceId: record.handle.workspaceId, tree }),
      ),
    ),
    Effect.uninterruptible,
  );
};

/**
 * Refuses a revision that leaves worker files with unsafe names behind. Files left out on
 * purpose (dependency, build, and Pi state directories, and credential files) never refuse.
 */
export const refuseUncaptured = (operation: string, revision: WorkspaceRevisionMetadata) => {
  const paths = (revision.uncapturedPaths ?? []).filter(blockingUncapturedPath);
  if (paths.length === 0) return Effect.void;
  return Effect.fail(
    new WorkspaceError({
      operation,
      code: "workspace_uncaptured_files",
      message:
        paths.length === 1
          ? "The worker left a file the proposal can't carry."
          : `The worker left ${paths.length} files the proposal can't carry.`,
      detail: [
        `Files: ${listedPaths(paths)}`,
        "Rule: files with unsafe names (control characters, backslashes, colons, a leading '-', or '.git' components) never enter a proposal, so integrating without them would silently drop the worker's work",
        "Remedy: revise the workspace so the writer renames, removes, or gitignores them, or copy what you need from the worker tree and discard the workspace.",
      ].join("\n"),
    }),
  );
};

// Failure messages don't say what happened to a partial workspace or rebuilt tree; callers add it.
export const withOutcome = (error: WorkspaceError, outcome: string) =>
  new WorkspaceError({
    ...(error.code !== undefined && { code: error.code }),
    operation: error.operation,
    message: error.message,
    detail: [error.detail, outcome].filter((line) => line !== undefined).join("\n"),
  });
