import * as Effect from "effect/Effect";
import type { WorkspaceDiffStatFile } from "../workspace/diffstat.ts";
import type { WorkspaceRecord } from "../workspace/model.ts";
import { credentialPrivatePath, credentialWorkspacePath } from "../workspace/policy.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  git,
  gitFields,
  oid,
  repositoryGit,
  repositoryGitFields,
  workspaceIO,
  workspaceIOIfPresent,
  workspaceRefusal,
} from "./git-worktree-process.ts";
import { gitPath } from "./git-repository.ts";
import { newWorkspaceId } from "./git-worktree-store.ts";

export interface TreeCapture {
  /** The Git tree the captured files make. */
  readonly tree: string;
  /** Untracked files left out by name, such as credential files. */
  readonly droppedPaths: ReadonlyArray<string>;
}

/**
 * Untracked files a capture of the user's checkout leaves out: any credential-shaped name, so
 * local secrets never enter the repository's objects.
 */
const checkoutLeftOut = credentialWorkspacePath;
/**
 * Untracked files a capture of a private tree (worker, prepared, or nested source) leaves out:
 * credential files a writer created, but not credential-named source such as `credentials.ts`.
 */
export const workerLeftOut = credentialPrivatePath;
/** The rule for the tree a workspace was created from. */
export const sourceLeftOut = (record: WorkspaceRecord) =>
  record.handle.sourceWorkspaceId === undefined ? checkoutLeftOut : workerLeftOut;

const unmergedRefusal = (name: string) =>
  workspaceRefusal("snapshot", "The checkout has unresolved merge conflicts.", {
    path: name,
    rule: "unmerged index entries are unsupported",
    remedy: "Resolve the conflicts and stage the results.",
  });

// Git trusts an entry's cached stat data only when the file's mtime is older than the index
// file's, so a copy keeps the original's mtime, a second earlier: a file rewritten with the same
// size just after the index was written must still be rehashed. A checkout without an index file
// has nothing staged.
const copyIndex = (real: string, copy: string) =>
  Effect.gen(function* () {
    const stat = yield* workspaceIOIfPresent("snapshot", () => fs.stat(real));
    if (!stat) return;
    yield* workspaceIO("snapshot", () => fs.copyFile(real, copy));
    yield* workspaceIO("snapshot", () =>
      fs.utimes(copy, stat.atimeMs / 1000, (stat.mtimeMs - 1000) / 1000),
    );
  });

/**
 * Captures the tree at `root` as Git would commit `git add -A` without touching its index: a copy
 * of the real index (keeping skip-worktree and assume-unchanged bits) takes every tracked change
 * and the untracked files Git's ignore rules leave eligible, except those `leaveOut` names.
 * Untracked nested repositories are never captured. The copy lives in `scratch`. `included` names
 * files `.worktreeinclude` copied in: they are left out silently, even when staged or no longer
 * ignored, and Git never hashes them.
 */
export const captureTree = (
  root: string,
  scratch: string,
  leaveOut: (name: string) => boolean,
  included: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const index = path.join(scratch, `${yield* newWorkspaceId}.index`);
    const environment = { GIT_INDEX_FILE: index };
    return yield* Effect.gen(function* () {
      const real = yield* gitPath(root, "index");
      yield* copyIndex(real, index);
      const [unmerged] = yield* gitFields(root, ["ls-files", "--unmerged", "-z"], {
        environment,
      });
      if (unmerged !== undefined)
        return yield* unmergedRefusal(unmerged.slice(unmerged.indexOf("\t") + 1));
      const omitted = new Set(included);
      if (omitted.size > 0)
        yield* git(root, ["update-index", "--force-remove", "-z", "--stdin"], {
          environment,
          stdin: new TextEncoder().encode(included.map((name) => `${name}\0`).join("")),
        });
      yield* git(root, ["add", "--update"], { environment });
      const untracked = (yield* gitFields(
        root,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        { environment },
      )).filter((name) => !name.endsWith("/") && !omitted.has(name));
      const droppedPaths = untracked.filter(leaveOut);
      const added = untracked.filter((name) => !leaveOut(name));
      if (added.length > 0)
        yield* git(root, ["update-index", "--add", "-z", "--stdin"], {
          environment,
          stdin: new TextEncoder().encode(added.map((name) => `${name}\0`).join("")),
        });
      const tree = yield* git(root, ["write-tree"], { environment }).pipe(Effect.flatMap(oid));
      return { tree, droppedPaths: droppedPaths.toSorted() } satisfies TreeCapture;
    }).pipe(
      Effect.ensuring(
        workspaceIO("snapshot", () => fs.rm(index, { force: true })).pipe(Effect.ignore),
      ),
    );
  });

/** Commits `tree` unsigned with the placeholder identity; the nonce keeps every capture distinct. */
export const commitTree = (
  repository: string,
  tree: string,
  parents: ReadonlyArray<string>,
  message: string,
) =>
  Effect.gen(function* () {
    const nonce = yield* newWorkspaceId;
    return yield* repositoryGit(repository, [
      "commit-tree",
      "--no-gpg-sign",
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      `${message} ${nonce}`,
      tree,
    ]).pipe(Effect.flatMap(oid));
  });

const workspaceRefPrefix = (workspaceId: string) => `refs/pi/workspaces/${workspaceId}/`;

/** The ref that keeps one of a workspace's commits reachable in the user's repository. */
export const workspaceRef = (workspaceId: string, name: string) =>
  `${workspaceRefPrefix(workspaceId)}${name}`;

export const setWorkspaceRef = (
  repository: string,
  workspaceId: string,
  name: string,
  commit: string,
) => repositoryGit(repository, ["update-ref", workspaceRef(workspaceId, name), commit]);

/** Deletes every ref the workspace keeps in the repository. */
export const deleteWorkspaceRefs = (repository: string, workspaceId: string) =>
  Effect.gen(function* () {
    const refs = (yield* repositoryGit(repository, [
      "for-each-ref",
      "--format=%(refname)",
      workspaceRefPrefix(workspaceId),
    ]))
      .split("\n")
      .filter(Boolean);
    if (refs.length === 0) return;
    yield* repositoryGit(repository, ["update-ref", "--stdin"], {
      stdin: new TextEncoder().encode(refs.map((ref) => `delete ${ref}\n`).join("")),
    });
  });

export const treeOf = (repository: string, revision: string) =>
  repositoryGit(repository, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{tree}`,
  ]).pipe(Effect.flatMap(oid));

/** Whether a stored tree or commit holds anything at or below `name`. */
export const treeHolds = (repository: string, tree: string, name: string) =>
  repositoryGit(repository, ["ls-tree", "--name-only", tree, "--", `:(literal)${name}`]).pipe(
    Effect.map((output) => output !== ""),
  );

export interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
}
export type TreeEntries = ReadonlyMap<string, TreeEntry>;

/** Every entry a stored tree or commit holds, by path. */
export const treeEntries = (repository: string, tree: string) =>
  repositoryGitFields(repository, ["ls-tree", "-r", "-z", "--full-tree", tree]).pipe(
    Effect.map(
      (lines): TreeEntries =>
        new Map(
          lines.map((line) => {
            const tab = line.indexOf("\t");
            const [mode = "", , id = ""] = line.slice(0, tab).split(" ");
            return [line.slice(tab + 1), { mode, oid: id }] as const;
          }),
        ),
    ),
  );

export interface ChangedEntry {
  readonly path: string;
  /** `000000` where the path is absent on that side. */
  readonly from: string;
  readonly to: string;
}

/** The paths that differ between two stored trees, with each side's mode. */
export const changedEntries = (repository: string, from: string, to: string) =>
  repositoryGitFields(repository, ["diff-tree", "-r", "-z", "--no-renames", from, to]).pipe(
    Effect.map((fields) => {
      const entries: ChangedEntry[] = [];
      for (let index = 0; index + 1 < fields.length; index += 2) {
        const [fromMode = "", toMode = ""] = (fields[index] ?? "").slice(1).split(" ");
        entries.push({ path: fields[index + 1] ?? "", from: fromMode, to: toMode });
      }
      return entries;
    }),
  );

/** Changed paths between two stored trees, in Git's order. */
export const changedPaths = (repository: string, from: string, to: string) =>
  changedEntries(repository, from, to).pipe(
    Effect.map((entries) => entries.map((entry) => entry.path)),
  );

const ABSENT_MODE = "000000";

/** One `--numstat -z` line as a diffstat file, its change kind read from both sides' modes. */
const numstatFile = (
  line: string,
  modes: ReadonlyMap<string, ChangedEntry>,
): WorkspaceDiffStatFile => {
  const [added = "", deleted = "", ...rest] = line.split("\t");
  const name = rest.join("\t");
  const entry = modes.get(name);
  const before = entry?.from ?? ABSENT_MODE;
  const after = entry?.to ?? ABSENT_MODE;
  const binary = added === "-";
  return {
    path: name,
    change: before === ABSENT_MODE ? "added" : after === ABSENT_MODE ? "deleted" : "modified",
    binary,
    addedLines: binary ? 0 : Number(added),
    deletedLines: binary ? 0 : Number(deleted),
    ...(before !== ABSENT_MODE &&
      after !== ABSENT_MODE &&
      before !== after && { modeChange: { from: before, to: after } }),
  };
};

/** Git's line counts for each path that differs between two stored trees. */
export const diffStat = (repository: string, from: string, to: string) =>
  Effect.gen(function* () {
    const modes = new Map(
      (yield* changedEntries(repository, from, to)).map((entry) => [entry.path, entry]),
    );
    const lines = yield* repositoryGitFields(repository, [
      "diff-tree",
      "-r",
      "-z",
      "--numstat",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      from,
      to,
    ]);
    return lines.map((line) => numstatFile(line, modes));
  });
