import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Order from "effect/Order";
import { WorkspaceError, type WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "pi-cosmic-core";
import { nodeErrorCode } from "./harness-shared.ts";
import {
  checkDirectory,
  git,
  gitFields,
  listedPaths,
  workspaceFailure,
  workspaceIO,
} from "./git-worktree-process.ts";
import {
  ABSENT_MODE,
  changedEntries,
  type ChangedEntry,
  withScratchIndex,
  workspaceRef,
} from "./git-capture.ts";

// Checking out large files runs every filter, such as Git LFS, so it may take a while.
const CHECKOUT_TIMEOUT_MILLIS = 10 * 60 * 1000;

const nulTerminated = (lines: ReadonlyArray<string>) =>
  new TextEncoder().encode(
    Arr.join(
      Arr.map(lines, (line) => `${line}\0`),
      "",
    ),
  );

/** Whether anything is at `name` in the checkout at `root`; a final symlink isn't followed. */
const present = (root: string, name: string) =>
  workspaceIO("integrate", () =>
    fs.lstat(path.join(root, name)).then(
      () => true,
      (cause: unknown) => {
        const code = nodeErrorCode(cause);
        if (code === "ENOENT" || code === "ENOTDIR") return false;
        throw cause;
      },
    ),
  );

/** Parent files the proposal changes moved on since they were tested; nothing was changed. */
export const touchedParentDrift = (paths: ReadonlyArray<string>) =>
  WorkspaceError.make({
    operation: "integrate",
    code: "workspace_parent_changed",
    message:
      paths.length === 1
        ? "A parent file the proposal changes no longer matches the tested one."
        : `${paths.length} parent files the proposal changes no longer match the tested ones.`,
    detail: Arr.join(
      [
        `Changed: ${listedPaths(paths)}`,
        "Nothing was changed.",
        "Remedy: prepare again so the proposal is tested against the current files, then integrate the new preparation. A parent file captures skip, such as an ignored or untracked credential file, never matches: move it aside, or revise the workspace so the writer leaves that path alone.",
      ],
      "\n",
    ),
  });

// Git's forced checkout replaces a symlink or file where it needs a directory, so every existing
// directory leading to a changed path must be a real one.
const refuseLinkedAncestors = (root: string, changes: ReadonlyArray<ChangedEntry>) =>
  Effect.forEach(
    changes,
    (change) => checkDirectory(path.dirname(path.join(root, change.path)), true),
    { discard: true },
  );

/**
 * Refuses changes the parent checkout can't take as tested: a directory leading to one isn't
 * real, or a parent file at a changed path is one captures leave out, such as an ignored file,
 * which would be replaced untested.
 */
export const refuseUntestedTargets = Effect.fn("GitWorktreeIntegration.refuseUntestedTargets")(
  function* (root: string, changes: ReadonlyArray<ChangedEntry>) {
    yield* refuseLinkedAncestors(root, changes);
    const hidden: string[] = [];
    for (const change of changes)
      if ((yield* present(root, change.path)) !== (change.from !== ABSENT_MODE))
        hidden.push(change.path);
    if (hidden.length > 0) return yield* touchedParentDrift(hidden);
    return undefined;
  },
);

const isAttributesFile = (name: string) => path.basename(name) === ".gitattributes";

/**
 * Writes `paths` from the stored `tree` into the checkout at `root` as checking it out would, with
 * filters, line endings, executable bits, and symlinks, through a scratch index in `scratch`.
 * `checkout-index` reads attributes from the files already in the checkout, so `.gitattributes`
 * files go first, in their own run, and the rest follow under their rules.
 */
const checkoutPaths = (root: string, scratch: string, tree: string, paths: ReadonlyArray<string>) =>
  paths.length === 0
    ? Effect.void
    : withScratchIndex(scratch, (environment) =>
        git(root, ["read-tree", tree], { environment }).pipe(
          Effect.andThen(
            Effect.forEach(
              [
                Arr.filter(paths, isAttributesFile),
                Arr.filter(paths, (name) => !isAttributesFile(name)),
              ],
              (batch) =>
                batch.length === 0
                  ? Effect.void
                  : git(root, ["checkout-index", "-f", "-z", "--stdin"], {
                      environment,
                      stdin: nulTerminated(batch),
                      timeoutMillis: CHECKOUT_TIMEOUT_MILLIS,
                    }),
              { discard: true },
            ),
          ),
        ),
      );

// Removes `paths`, then directories that left empty, as `git apply` would; the source root and
// the session directory and its ancestors stay.
const removePaths = Effect.fn("GitWorktreeIntegration.removePaths")(function* (
  record: WorkspaceRecord,
  paths: ReadonlyArray<string>,
) {
  const { sourceRoot, sourceCwd } = record.handle;
  for (const name of paths)
    yield* workspaceIO("integrate", () => fs.rm(path.join(sourceRoot, name), { force: true }));
  const directories = new Set<string>();
  for (const name of paths)
    for (let parent = path.dirname(name); parent !== "."; parent = path.dirname(parent))
      directories.add(parent);
  for (const directory of Arr.sort(
    [...directories],
    Order.flip(Order.mapInput(Order.Number, (name: string) => Str.split(name, path.sep).length)),
  )) {
    const full = path.join(sourceRoot, directory);
    if (full === sourceCwd || Fn.pipe(sourceCwd, Str.startsWith(`${full}${path.sep}`))) continue;
    // A directory that isn't empty, or is no longer one, stays.
    yield* workspaceIO("integrate", () => fs.rmdir(full).catch(() => undefined));
  }
});

const deleted = (change: ChangedEntry) => change.to === ABSENT_MODE;

/**
 * Makes the parent checkout's files at the changed paths match the prepared tree: new and changed
 * files are checked out from it, then deleted ones are removed. The checkout's index is never read
 * or written.
 */
export const writeChanges = Effect.fn("GitWorktreeIntegration.writeChanges")(function* (
  record: WorkspaceRecord,
  scratch: string,
  preparedTree: string,
  changes: ReadonlyArray<ChangedEntry>,
) {
  const [removed, written] = Arr.partition(changes, (change) =>
    deleted(change) ? Result.succeed(change.path) : Result.fail(change.path),
  );
  yield* checkoutPaths(record.handle.sourceRoot, scratch, preparedTree, written);
  yield* removePaths(record, removed);
});

// Paths whose file in the checkout differs from its entry, as `git status` judges a file: its
// content through clean filters, its executable bit, or its symlink target. A missing file differs.
const differingFrom = (
  root: string,
  scratch: string,
  entries: ReadonlyArray<{ readonly path: string; readonly mode: string; readonly object: string }>,
) =>
  entries.length === 0
    ? Effect.succeed(new Set<string>())
    : withScratchIndex(scratch, (environment) =>
        git(root, ["update-index", "-z", "--index-info"], {
          environment,
          stdin: nulTerminated(
            Arr.map(entries, (entry) => `${entry.mode} ${entry.object}\t${entry.path}`),
          ),
        }).pipe(
          Effect.andThen(gitFields(root, ["ls-files", "--modified", "-z"], { environment })),
          Effect.map((paths) => new Set(paths)),
        ),
      );

const rollbackRefused = (record: WorkspaceRecord, paths: ReadonlyArray<string>) => {
  const prepared = workspaceRef(record.handle.workspaceId, "prepared");
  return WorkspaceError.make({
    operation: "discard",
    code: "workspace_rollback_refused",
    message:
      paths.length === 1
        ? "A file the integration touched has changed since; rollback was refused."
        : `${paths.length} files the integration touched have changed since; rollback was refused.`,
    detail: Arr.join(
      [
        `Changed: ${listedPaths(paths)}`,
        "Nothing was rolled back; the workspace stays mid-integration.",
        `Remedy: put each named file back to its content from before the integration (\`git show ${prepared}^:<path>\`) or the proposal's (\`git show ${prepared}:<path>\`), then discard again.`,
      ],
      "\n",
    ),
  });
};

/**
 * Undoes an integration that stopped partway. Each changed path that still holds the parent's or
 * the proposal's content, or nothing, is put back from the parent tree, and paths the parent
 * didn't have are removed. If any holds something else, nothing changes and the refusal names it.
 */
export const rollbackIntegration = Effect.fn("GitWorktreeIntegration.rollbackIntegration")(
  function* (record: WorkspaceRecord, scratch: string) {
    const { parentTree, preparedTree } = record;
    const root = record.handle.sourceRoot;
    if (parentTree === undefined || preparedTree === undefined)
      return yield* workspaceFailure("discard", "The interrupted integration's trees are unknown.");
    yield* checkDirectory(root);
    const changes = yield* changedEntries(record.repository, parentTree, preparedTree);
    yield* refuseLinkedAncestors(root, changes);
    const unlikeParent = yield* differingFrom(
      root,
      scratch,
      Arr.flatMap(changes, (change) =>
        change.from === ABSENT_MODE
          ? []
          : [{ path: change.path, mode: change.from, object: change.fromObject }],
      ),
    );
    const unlikePrepared = yield* differingFrom(
      root,
      scratch,
      Arr.flatMap(changes, (change) =>
        change.to === ABSENT_MODE
          ? []
          : [{ path: change.path, mode: change.to, object: change.toObject }],
      ),
    );
    const found = new Set<string>();
    for (const change of changes) if (yield* present(root, change.path)) found.add(change.path);
    const holds = (name: string, mode: string, unlike: ReadonlySet<string>) =>
      mode === ABSENT_MODE ? !found.has(name) : !unlike.has(name);
    const refused = Arr.flatMap(changes, (change) =>
      found.has(change.path) &&
      !holds(change.path, change.from, unlikeParent) &&
      !holds(change.path, change.to, unlikePrepared)
        ? [change.path]
        : [],
    );
    if (refused.length > 0) return yield* rollbackRefused(record, refused);
    yield* removePaths(
      record,
      Arr.flatMap(changes, (change) =>
        change.from === ABSENT_MODE && found.has(change.path) ? [change.path] : [],
      ),
    );
    yield* checkoutPaths(
      root,
      scratch,
      parentTree,
      Arr.flatMap(changes, (change) =>
        change.from !== ABSENT_MODE && unlikeParent.has(change.path) ? [change.path] : [],
      ),
    );
    return undefined;
  },
);
