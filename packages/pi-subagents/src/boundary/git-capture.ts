import * as Effect from "effect/Effect";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import type { WorkspaceDiffStatFile } from "../workspace/diffstat.ts";
import { credentialPrivatePath, credentialWorkspacePath } from "../workspace/policy.ts";
import { nodeFsPromises as fs, nodePath as path } from "pi-cosmic-core/platform/node-builtins";
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

interface TreeCapture {
  /** The Git tree the captured files make. */
  readonly tree: string;
  /** Untracked files left out by name, such as credential files. */
  readonly droppedPaths: ReadonlyArray<string>;
}

/**
 * Untracked files a capture of the user's checkout leaves out: any credential-shaped name, so
 * local secrets never enter the repository's objects.
 */
export const sourceLeftOut = credentialWorkspacePath;
/**
 * Untracked files a capture of a private tree (worker or prepared) leaves out: credential files
 * a writer created, but not credential-named source such as `credentials.ts`.
 */
export const workerLeftOut = credentialPrivatePath;

const unmergedRefusal = (name: string) =>
  workspaceRefusal("snapshot", "The checkout has unresolved merge conflicts.", {
    path: name,
    rule: "unmerged index entries are unsupported",
    remedy: "Resolve the conflicts and stage the results.",
  });

/** Runs `use` with a temporary index in `scratch`, so Git never reads or writes a real one. */
export const withScratchIndex = Effect.fn("GitCapture.withScratchIndex")(function* <A, E, R>(
  scratch: string,
  use: (environment: { readonly GIT_INDEX_FILE: string }) => Effect.Effect<A, E, R>,
) {
  const index = path.join(scratch, `${yield* newWorkspaceId}.index`);
  return yield* use({ GIT_INDEX_FILE: index }).pipe(
    Effect.ensuring(workspaceIO("index", () => fs.rm(index, { force: true })).pipe(Effect.ignore)),
  );
});

// Git trusts an entry's cached stat data only when the file's mtime is older than the index
// file's, so a copy keeps the original's mtime, a second earlier: a file rewritten with the same
// size just after the index was written must still be rehashed. A checkout without an index file
// has nothing staged.
const copyIndex = Effect.fn("GitCapture.copyIndex")(function* (real: string, copy: string) {
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
  withScratchIndex(scratch, (environment) =>
    Effect.gen(function* () {
      const real = yield* gitPath(root, "index");
      yield* copyIndex(real, environment.GIT_INDEX_FILE);
      const [unmerged] = yield* gitFields(root, ["ls-files", "--unmerged", "-z"], {
        environment,
      });
      if (unmerged !== undefined)
        return yield* unmergedRefusal(
          Fn.pipe(
            unmerged,
            Str.slice(
              Fn.pipe(
                unmerged,
                Str.indexOf("\t"),
                Option.getOrElse(() => -1),
              ) + 1,
            ),
          ),
        );
      const omitted = new Set(included);
      if (omitted.size > 0)
        yield* git(root, ["update-index", "--force-remove", "-z", "--stdin"], {
          environment,
          stdin: new TextEncoder().encode(
            Arr.join(
              Arr.map(included, (name) => `${name}\0`),
              "",
            ),
          ),
        });
      yield* git(root, ["add", "--update"], { environment });
      const untracked = Arr.filter(
        yield* gitFields(root, ["ls-files", "--others", "--exclude-standard", "-z"], {
          environment,
        }),
        (name) => !Fn.pipe(name, Str.endsWith("/")) && !omitted.has(name),
      );
      const droppedPaths = Arr.filter(untracked, leaveOut);
      const added = Arr.filter(untracked, (name) => !leaveOut(name));
      if (added.length > 0)
        yield* git(root, ["update-index", "--add", "-z", "--stdin"], {
          environment,
          stdin: new TextEncoder().encode(
            Arr.join(
              Arr.map(added, (name) => `${name}\0`),
              "",
            ),
          ),
        });
      const tree = yield* git(root, ["write-tree"], { environment }).pipe(Effect.flatMap(oid));
      return { tree, droppedPaths: Arr.sort(droppedPaths, Order.String) } satisfies TreeCapture;
    }),
  );

/** Commits `tree` unsigned with the placeholder identity; the nonce keeps every capture distinct. */
export const commitTree = Effect.fn("GitCapture.commitTree")(function* (
  repository: string,
  tree: string,
  parents: ReadonlyArray<string>,
  message: string,
) {
  const nonce = yield* newWorkspaceId;
  return yield* repositoryGit(repository, [
    "commit-tree",
    "--no-gpg-sign",
    ...Arr.flatMap(parents, (parent) => ["-p", parent]),
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
export const deleteWorkspaceRefs = Effect.fn("GitCapture.deleteWorkspaceRefs")(function* (
  repository: string,
  workspaceId: string,
) {
  const refs = Arr.filter(
    Str.split(
      yield* repositoryGit(repository, [
        "for-each-ref",
        "--format=%(refname)",
        workspaceRefPrefix(workspaceId),
      ]),
      "\n",
    ),
    Boolean,
  );
  if (refs.length === 0) return;
  yield* repositoryGit(repository, ["update-ref", "--stdin"], {
    stdin: new TextEncoder().encode(
      Arr.join(
        Arr.map(refs, (ref) => `delete ${ref}\n`),
        "",
      ),
    ),
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

interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
}
type TreeEntries = ReadonlyMap<string, TreeEntry>;

/** Every entry a stored tree or commit holds, by path. */
export const treeEntries = (repository: string, tree: string) =>
  repositoryGitFields(repository, ["ls-tree", "-r", "-z", "--full-tree", tree]).pipe(
    Effect.map(
      (lines): TreeEntries =>
        new Map(
          Arr.map(lines, (line) => {
            const tab = Fn.pipe(
              line,
              Str.indexOf("\t"),
              Option.getOrElse(() => -1),
            );
            const [mode, , id = ""] = Str.split(Fn.pipe(line, Str.slice(0, tab)), " ");
            return [Fn.pipe(line, Str.slice(tab + 1)), { mode, oid: id }] as const;
          }),
        ),
    ),
  );

export interface ChangedEntry {
  readonly path: string;
  /** `000000` where the path is absent on that side. */
  readonly from: string;
  readonly to: string;
  /** Each side's object, all zeros where the path is absent. */
  readonly fromObject: string;
  readonly toObject: string;
}

/** The paths that differ between two stored trees, with each side's mode and object. */
export const changedEntries = (repository: string, from: string, to: string) =>
  repositoryGitFields(repository, ["diff-tree", "-r", "-z", "--no-renames", from, to]).pipe(
    Effect.map((fields) => {
      const entries: ChangedEntry[] = [];
      for (let index = 0; index + 1 < fields.length; index += 2) {
        const [fromMode, toMode = "", fromObject = "", toObject = ""] = Str.split(
          Fn.pipe(fields[index] ?? "", Str.slice(1)),
          " ",
        );
        entries.push({
          path: fields[index + 1] ?? "",
          from: fromMode,
          to: toMode,
          fromObject,
          toObject,
        });
      }
      return entries;
    }),
  );

/** Changed paths between two stored trees, in Git's order. */
export const changedPaths = (repository: string, from: string, to: string) =>
  changedEntries(repository, from, to).pipe(
    Effect.map((entries) => Arr.map(entries, (entry) => entry.path)),
  );

export const ABSENT_MODE = "000000";

/** One `--numstat -z` line as a diffstat file, its change kind read from both sides' modes. */
const numstatFile = (
  line: string,
  modes: ReadonlyMap<string, ChangedEntry>,
): WorkspaceDiffStatFile => {
  const [added, deleted = "", ...rest] = Str.split(line, "\t");
  const name = Arr.join(rest, "\t");
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
export const diffStat = Effect.fn("GitCapture.diffStat")(function* (
  repository: string,
  from: string,
  to: string,
) {
  const modes = new Map(
    Arr.map(yield* changedEntries(repository, from, to), (entry) => [entry.path, entry]),
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
  return Arr.map(lines, (line) => numstatFile(line, modes));
});
