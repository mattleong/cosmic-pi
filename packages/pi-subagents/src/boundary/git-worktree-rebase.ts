import * as Effect from "effect/Effect";
import type { SafeFile } from "pi-cosmic-core";
import { WorkspaceError } from "../workspace/model.ts";
import type { WorkspaceRebase, WorkspaceRecord } from "../workspace/model.ts";
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
  workspaceRefusal,
} from "./git-worktree-process.ts";
import { captureSnapshot, readSnapshot, sourceIdentity } from "./git-worktree-snapshot.ts";
import { newWorkspaceId, readWorkspaceRecord, saveWorkspaceRecord } from "./git-worktree-store.ts";
import { patchBytes } from "./git-worktree-patch.ts";
import {
  captureTree,
  preparationTree,
  refuseUncaptured,
  removePreparation,
  sourceCapture,
  withOutcome,
  workspaceRepository,
  workspaceSubdirectory,
  workspaceWorker,
} from "./git-worktree-trees.ts";

/** Reads a record the engine manages, refusing one that a setup command still quarantines. */
export type ManagedWorkspaceRecord = (
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
      "Rule: a rebase reapplies every change with a three-way merge, which can't resolve a file the parent deleted, added, or turned binary",
      "Nothing was changed; the workspace keeps its worker tree and revision.",
      "Remedy: revise without rebase, or apply or export the proposal and start a new writer from the current checkout.",
    ].join("\n"),
  });
};

// `git apply --3way` exits nonzero both when it leaves conflicts and when it can't apply at
// all; only the first leaves unmerged index entries, and the second changes nothing.
const applyThreeWay = (root: string, patch: Uint8Array, changedPaths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const args = ["apply", "--3way", "--binary", "--whitespace=nowarn", "-"];
    const result = yield* gitResult(root, args, { stdin: patch });
    if (gitSucceeded(result)) return [];
    if (result.code === null || result.cleanupUnconfirmed || result.timedOut)
      return yield* gitFailure(args, result);
    const conflicted = yield* unmergedPaths(root);
    if (conflicted.length === 0) return yield* rebaseRefusal(result, changedPaths);
    return conflicted.toSorted();
  });

// Rebuilds the worker in place, so its directory keeps the identity its writer lease names.
const rebuildWorker = (
  root: string,
  parent: string,
  patch: Uint8Array,
  changedPaths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    yield* git(root, ["reset", "-q", "--hard", parent]);
    yield* git(root, ["clean", "-ffdxq"]);
    const conflicted = patch.length === 0 ? [] : yield* applyThreeWay(root, patch, changedPaths);
    // Like a fresh worker's, the index holds the baseline and the changes stay unstaged.
    yield* git(root, ["reset", "-q", "--mixed", parent]);
    return conflicted;
  });

// Puts back every captured worker file from `captured`, with the index at the baseline.
const restoreWorker = (root: string, captured: string, baseline: string) =>
  Effect.gen(function* () {
    yield* git(root, ["reset", "-q", "--hard", captured]);
    yield* git(root, ["clean", "-ffdxq"]);
    yield* git(root, ["reset", "-q", "--mixed", baseline]);
  });

// A nested rebase snapshots its source like a nested create: an active workspace's worker.
const activeSource = (
  registry: string,
  record: WorkspaceRecord,
  managedRecord: ManagedWorkspaceRecord,
) =>
  Effect.gen(function* () {
    const sourceId = record.handle.sourceWorkspaceId;
    if (sourceId === undefined) return undefined;
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
    return undefined;
  });

/** The baseline record.json names now, or undefined when it can't be read. */
const savedBaseline = (registry: string, record: WorkspaceRecord) =>
  readWorkspaceRecord(registry, record.handle.workspaceId).pipe(
    Effect.map((saved): string | undefined => saved.baseline),
    Effect.orElseSucceed((): string | undefined => undefined),
  );

/**
 * Puts the worker back after rebuilding failed past the trial. A save that renamed the rebuilt
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
    const repository = workspaceRepository(registry, record);
    const capturedAt = `refs/pi/rebase-worker (${captured}) in ${repository}`;
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
    return yield* restoreWorker(workspaceWorker(registry, record), captured, record.baseline).pipe(
      Effect.matchEffect({
        onSuccess: () =>
          Effect.fail(
            withOutcome(
              error,
              "The worker tree was restored from its captured files; ignored and excluded files were removed.",
            ),
          ),
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
 * Rebuilds the worker tree from a fresh snapshot of its source with the worker's changes
 * reapplied by a three-way merge. A trial in a scratch tree proves the merge can run before
 * the worker changes; the worker is restored from its capture if rebuilding fails after that.
 */
export const rebaseWorkspace = (
  registry: string,
  record: WorkspaceRecord,
  managedRecord: ManagedWorkspaceRecord,
) =>
  Effect.gen(function* () {
    if (!["active", "frozen", "prepared"].includes(record.status))
      return yield* workspaceFailure("rebase", "Workspace cannot be rebuilt in its current state.");
    yield* activeSource(registry, record, managedRecord);
    const repository = workspaceRepository(registry, record);
    const worker = workspaceWorker(registry, record);
    const current = yield* captureTree(registry, record, worker, "rebase-worker");
    const changedPaths = yield* gitFields(repository, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      record.baseline,
      current.commit,
      "--",
    ]);
    // Rebuilding removes every file the capture couldn't hold.
    yield* refuseUncaptured("rebase", {
      revisionId: current.commit,
      changedPaths,
      uncapturedPaths: current.excludedPaths,
    });
    const patch =
      changedPaths.length === 0
        ? new Uint8Array()
        : yield* patchBytes(
            registry,
            record,
            { from: record.baseline, to: current.commit },
            "rebase",
          );
    const { sourceRoot } = record.handle;
    const identity = yield* sourceIdentity(sourceRoot);
    const options = sourceCapture(record);
    const parent = yield* captureSnapshot(sourceRoot, repository, "rebase-parent", options);
    const relative = workspaceSubdirectory(record);
    if (relative !== "" && !parent.entries.some((entry) => entry.path.startsWith(`${relative}/`)))
      return yield* workspaceRefusal(
        "rebase",
        "The session directory has no files in the parent's current checkout.",
        {
          path: relative,
          rule: "the rebuilt worker must still hold the session directory",
          remedy: "Revise without rebase, or discard this workspace.",
        },
      );
    const verified = yield* readSnapshot(sourceRoot, options);
    const after = yield* sourceIdentity(sourceRoot);
    if (
      verified.tree !== parent.tree ||
      after.head !== identity.head ||
      after.index !== identity.index
    )
      return yield* workspaceFailure("rebase", "Source changed during snapshot acquisition.");
    if (patch.length > 0) {
      const trialId = yield* newWorkspaceId;
      const trial = preparationTree(registry, record, trialId);
      yield* git(repository, ["worktree", "add", "--detach", trial, parent.commit]);
      yield* applyThreeWay(trial, patch, changedPaths).pipe(
        Effect.ensuring(removePreparation(registry, record, trialId)),
      );
    }
    const rebuilt: WorkspaceRecord = {
      version: 1,
      handle: record.handle,
      baseline: parent.commit,
      ownerLease: record.ownerLease,
      excludedPaths: parent.excludedPaths,
      status: "active",
    };
    const conflictedPaths = yield* Effect.gen(function* () {
      const conflicted = yield* rebuildWorker(worker, parent.commit, patch, changedPaths);
      const provisioned = yield* captureTree(registry, rebuilt, worker, "rebased");
      yield* saveWorkspaceRecord(registry, { ...rebuilt, rebasedTree: provisioned.tree });
      return conflicted;
    }).pipe(
      Effect.catchIf(
        (error) => !error.cleanupUnconfirmed,
        (error) => recoverWorker(registry, record, current.commit, parent.commit, error),
      ),
      Effect.uninterruptible,
    );
    // The rebuilt record has no preparation, so an earlier test tree is only clutter now.
    if (record.preparation)
      yield* removePreparation(registry, record, record.preparation.preparationId);
    return { reappliedPaths: changedPaths, conflictedPaths } satisfies WorkspaceRebase;
  });
