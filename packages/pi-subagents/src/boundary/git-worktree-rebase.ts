import * as Effect from "effect/Effect";
import type { SafeFile } from "pi-cosmic-core";
import { OPEN_WORKSPACE_STATUSES, WorkspaceError } from "../workspace/model.ts";
import type { WorkspaceRebase, WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  git,
  gitFailure,
  gitFields,
  type GitResult,
  gitResult,
  gitStderrLines,
  gitSucceeded,
  listedPaths,
  workspaceFailure,
  workspaceIO,
  workspaceRefusal,
} from "./git-worktree-process.ts";
import { newWorkspaceId, readWorkspaceRecord, saveWorkspaceRecord } from "./git-worktree-store.ts";
import { patchBytes } from "./git-worktree-patch.ts";
import { includedLeftOut } from "./git-worktree-include.ts";
import {
  captureTree,
  changedPaths as changedBetween,
  commitTree,
  setWorkspaceRef,
  sourceLeftOut,
  treeHolds,
  workerLeftOut,
  workspaceRef,
} from "./git-capture.ts";
import { gitPath, headCommit, sourceIdentity } from "./git-repository.ts";
import {
  removePreparation,
  withOutcome,
  workspaceArtifact,
  workspaceSubdirectory,
  workspaceWorker,
} from "./git-worktree-trees.ts";
import type { BeforeTreeRemoval } from "./git-worktree-hooks.ts";

/** Reads a record the engine manages, refusing one that a worktree hook still quarantines. */
type ManagedWorkspaceRecord = (
  workspaceId: string,
) => Effect.Effect<WorkspaceRecord, WorkspaceError, SafeFile>;

/** Paths `git apply --3way` left unmerged in the tree's index. */
const unmergedPaths = (root: string) =>
  gitFields(root, ["ls-files", "-u", "-z"]).pipe(
    Effect.map((lines) => [...new Set(lines.map((line) => line.slice(line.indexOf("\t") + 1)))]),
  );

const rebaseRefusal = (result: GitResult, changedPaths: ReadonlyArray<string>) => {
  const stderr = gitStderrLines(result.stderr);
  const paths = changedPaths.filter((name) =>
    stderr.some((line) => line.startsWith(`error: ${name}: `)),
  );
  return new WorkspaceError({
    operation: "rebase",
    code: "workspace_rebase_refused",
    message: "The previous changes can't be reapplied to the parent's current files.",
    detail: [
      ...(paths.length > 0 ? [`Unmergeable: ${listedPaths(paths)}`] : []),
      ...(stderr.length > 0 ? [`Git reported:\n${stderr.join("\n")}`] : []),
      "Rule: a rebase reapplies every change with a three-way merge, which can't resolve a file the parent deleted, added, or turned binary, or overwrite an untracked or ignored worker file",
      "Nothing was changed; the workspace keeps its worker tree and revision.",
      "Remedy: revise without rebase, or apply the proposal and start a new writer from the current checkout.",
    ].join("\n"),
  });
};

// A command that refuses changes nothing; any other failure is the caller's to recover from.
const refusable = (
  root: string,
  args: ReadonlyArray<string>,
  changedPaths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const result = yield* gitResult(root, args);
    if (gitSucceeded(result)) return undefined;
    if (result.code === null || result.cleanupUnconfirmed || result.timedOut)
      return yield* gitFailure(args, result);
    return yield* rebaseRefusal(result, changedPaths);
  });

// No capture holds included files, so reading one into an index that stages an included file
// would delete that file. Without their index entries they stay untracked and untouched.
const unstageIncluded = (root: string, included: ReadonlyArray<string>) =>
  included.length === 0
    ? Effect.void
    : git(root, ["update-index", "--force-remove", "-z", "--stdin"], {
        stdin: new TextEncoder().encode(included.map((name) => `${name}\0`).join("")),
      }).pipe(Effect.asVoid);

/**
 * Moves the worker from its captured files to the fresh baseline and reapplies the changes with
 * a three-way merge against the real merge base, the old baseline. Two-tree read-tree touches
 * only tracked files and refuses to overwrite untracked or ignored ones, and `git apply --3way`
 * exits nonzero both when it leaves conflicts and when it can't apply at all; only the first
 * leaves unmerged entries, and the second changes nothing, so the worker is moved back.
 */
const rebuildWorker = (
  root: string,
  captured: string,
  parent: string,
  patch: Uint8Array,
  changedPaths: ReadonlyArray<string>,
  included: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    yield* unstageIncluded(root, included);
    yield* git(root, ["read-tree", "--reset", "-u", captured]);
    yield* refusable(root, ["read-tree", "-m", "-u", captured, parent], changedPaths);
    if (patch.length === 0) return [];
    const args = ["apply", "--3way", "--binary", "--whitespace=nowarn", "-"];
    const result = yield* gitResult(root, args, { stdin: patch });
    if (gitSucceeded(result)) return [];
    if (result.code === null || result.cleanupUnconfirmed || result.timedOut)
      return yield* gitFailure(args, result);
    const conflicted = yield* unmergedPaths(root);
    if (conflicted.length > 0) return conflicted.toSorted();
    yield* git(root, ["read-tree", "-m", "-u", parent, captured]);
    return yield* rebaseRefusal(result, changedPaths);
  });

// Puts back every captured worker file, with HEAD and the index at the baseline again; files the
// capture left out, such as ignored and included ones, stay as they are.
const restoreWorker = (
  root: string,
  captured: string,
  baseline: string,
  included: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    yield* unstageIncluded(root, included);
    yield* git(root, ["read-tree", "--reset", "-u", captured]);
    yield* git(root, ["reset", "-q", "--mixed", baseline]);
  });

// A nested rebase snapshots its source like a nested create: an active workspace's worker,
// without the files `.worktreeinclude` copied into it.
const activeSource = (
  registry: string,
  record: WorkspaceRecord,
  managedRecord: ManagedWorkspaceRecord,
) =>
  Effect.gen(function* () {
    const sourceId = record.handle.sourceWorkspaceId;
    if (sourceId === undefined) return [];
    const source = yield* managedRecord(sourceId);
    if (
      source.status !== "active" ||
      workspaceWorker(registry, source) !== record.handle.sourceRoot
    )
      return yield* workspaceRefusal("rebase", "The source workspace isn't active.", {
        path: record.handle.sourceRoot,
        rule: "a nested workspace snapshots only an active workspace's worker tree",
        remedy: "Revise without rebase, or discard this workspace.",
      });
    return yield* includedLeftOut(source.repository, source.baseline, source.includedPaths);
  });

/** The baseline record.json names now, or undefined when it can't be read. */
const savedBaseline = (registry: string, record: WorkspaceRecord) =>
  readWorkspaceRecord(registry, record.handle.workspaceId).pipe(
    Effect.map((saved): string | undefined => saved.baseline),
    Effect.orElseSucceed((): string | undefined => undefined),
  );

/**
 * Puts the worker back after rebuilding failed past the merge. A save that renamed the rebuilt
 * record into place can still fail syncing its directory, so the record is reread first: the
 * worker is restored only once the record names the previous baseline again, and otherwise kept
 * as rebuilt so the next freeze can't revert parent edits against a baseline it doesn't hold.
 */
const recoverWorker = (
  registry: string,
  record: WorkspaceRecord,
  captured: string,
  rebuiltBaseline: string,
  error: WorkspaceError,
) =>
  Effect.gen(function* () {
    const capturedAt = `${workspaceRef(record.handle.workspaceId, "rebase-worker")} (${captured}) in ${record.repository}`;
    let named = yield* savedBaseline(registry, record);
    if (named !== record.baseline) {
      yield* saveWorkspaceRecord(registry, record).pipe(Effect.ignore);
      named = yield* savedBaseline(registry, record);
    }
    if (named !== record.baseline)
      return yield* withOutcome(
        error,
        named === rebuiltBaseline
          ? `The workspace record already names the rebuilt worker tree and couldn't be put back, so the rebuilt tree was kept and is active; the previous captured files are at ${capturedAt}.`
          : `The workspace record couldn't be read back, so the worker tree was left as rebuilt; the previous captured files are at ${capturedAt}. Discard the workspace if it can't be inspected.`,
      );
    return yield* restoreWorker(
      workspaceWorker(registry, record),
      captured,
      record.baseline,
      record.includedPaths ?? [],
    ).pipe(
      Effect.andThen(
        setWorkspaceRef(record.repository, record.handle.workspaceId, "baseline", record.baseline),
      ),
      Effect.matchEffect({
        onSuccess: () =>
          Effect.fail(withOutcome(error, "The worker tree was restored from its captured files.")),
        onFailure: () =>
          Effect.fail(
            withOutcome(
              error,
              `Restoring the worker tree failed; its captured files are at ${capturedAt}.`,
            ),
          ),
      }),
    );
  });

/**
 * Rebuilds the worker tree in place from a fresh capture of its source with the worker's changes
 * reapplied by a three-way merge. A merge that can't run puts the worker back and changes
 * nothing; a later failure restores the worker from its capture.
 */
export const rebaseWorkspace = (
  registry: string,
  record: WorkspaceRecord,
  managedRecord: ManagedWorkspaceRecord,
  beforeRemove?: BeforeTreeRemoval,
) =>
  Effect.gen(function* () {
    if (!OPEN_WORKSPACE_STATUSES.has(record.status))
      return yield* workspaceFailure("rebase", "Workspace cannot be rebuilt in its current state.");
    const sourceIncluded = yield* activeSource(registry, record, managedRecord);
    // The worker's included files stay as they are, even staged ones; no capture takes them.
    const included = record.includedPaths ?? [];
    const { repository } = record;
    const { workspaceId, sourceRoot } = record.handle;
    const scratch = workspaceArtifact(registry, record);
    const worker = workspaceWorker(registry, record);
    const current = yield* captureTree(worker, scratch, workerLeftOut, included);
    const captured = yield* commitTree(repository, current.tree, [record.baseline], "worker");
    yield* setWorkspaceRef(repository, workspaceId, "rebase-worker", captured);
    const changedPaths = yield* changedBetween(repository, record.baseline, captured);
    const patch =
      changedPaths.length === 0
        ? new Uint8Array()
        : yield* patchBytes(registry, record, { from: record.baseline, to: captured }, "rebase");
    const identity = yield* sourceIdentity(sourceRoot);
    const source = yield* captureTree(sourceRoot, scratch, sourceLeftOut(record), sourceIncluded);
    const parent = yield* commitTree(
      repository,
      source.tree,
      [yield* headCommit(sourceRoot)],
      "baseline",
    );
    const relative = workspaceSubdirectory(record);
    if (relative !== "" && !(yield* treeHolds(repository, parent, relative)))
      return yield* workspaceRefusal(
        "rebase",
        "The session directory has no files in the parent's current checkout.",
        {
          path: relative,
          rule: "the rebuilt worker must still hold the session directory",
          remedy: "Revise without rebase, or discard this workspace.",
        },
      );
    const after = yield* sourceIdentity(sourceRoot);
    if (after.head !== identity.head || after.index !== identity.index)
      return yield* workspaceFailure("rebase", "Source changed during snapshot acquisition.");
    const rebuilt: WorkspaceRecord = {
      version: 2,
      handle: record.handle,
      repository,
      baseline: parent,
      ownerLease: record.ownerLease,
      lastChangedAt: record.lastChangedAt,
      status: "active",
      ...(record.launch && { launch: record.launch }),
      ...(record.includedPaths && { includedPaths: record.includedPaths }),
    };
    // A refused merge puts the worker's files back; its index, staged entries included, is
    // restored from this copy.
    const index = yield* gitPath(worker, "index");
    const savedIndex = path.join(scratch, `${yield* newWorkspaceId}.index`);
    yield* workspaceIO("rebase", () => fs.copyFile(index, savedIndex));
    const conflictedPaths = yield* Effect.gen(function* () {
      const conflicted = yield* rebuildWorker(
        worker,
        captured,
        parent,
        patch,
        changedPaths,
        included,
      ).pipe(
        Effect.tapError((error) =>
          error.code === "workspace_rebase_refused"
            ? workspaceIO("rebase", () => fs.copyFile(savedIndex, index))
            : Effect.void,
        ),
      );
      // Like a fresh worker's, the index holds the baseline and the changes stay unstaged.
      yield* git(worker, ["reset", "-q", "--mixed", parent]);
      yield* setWorkspaceRef(repository, workspaceId, "baseline", parent);
      const provisioned = yield* captureTree(worker, scratch, workerLeftOut, included);
      yield* saveWorkspaceRecord(registry, { ...rebuilt, rebasedTree: provisioned.tree });
      return conflicted;
    }).pipe(
      Effect.catchIf(
        (error) => !error.cleanupUnconfirmed && error.code !== "workspace_rebase_refused",
        (error) => recoverWorker(registry, record, captured, parent, error),
      ),
      Effect.ensuring(
        workspaceIO("rebase", () => fs.rm(savedIndex, { force: true })).pipe(Effect.ignore),
      ),
      Effect.uninterruptible,
    );
    // The rebuilt record has no preparation, so an earlier test tree is only clutter now, unless
    // its WorktreeRemove hooks quarantined the workspace.
    const kept = record.preparation
      ? yield* removePreparation(registry, record, record.preparation.preparationId, beforeRemove)
      : undefined;
    if (kept?.cleanupUnconfirmed)
      return yield* withOutcome(
        kept,
        "The worker tree was rebuilt onto the parent's current files; its earlier test tree was kept.",
      );
    return { reappliedPaths: changedPaths, conflictedPaths } satisfies WorkspaceRebase;
  });
