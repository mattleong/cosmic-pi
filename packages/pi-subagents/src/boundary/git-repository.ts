import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { WorkspaceError } from "../workspace/model.ts";
import { nodeCreateHash, nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  checkDirectory,
  git,
  gitFields,
  listedPaths,
  oid,
  workspaceFailure,
  workspaceIO,
  workspaceRefusal,
} from "./git-worktree-process.ts";

const SHARED_CHECKOUT_REMEDY = "or use the shared-checkout writer workspace";

/** A session directory's checkout, resolved without symlinks. */
export interface SourceCheckout {
  readonly sourceRoot: string;
  readonly sourceCwd: string;
  /** The session directory relative to the checkout root. */
  readonly subdirectory: string;
  /** The common Git directory every linked worktree of the repository shares. */
  readonly repository: string;
}

const revParse = (cwd: string, args: ReadonlyArray<string>, count: number) =>
  git(cwd, ["rev-parse", "--path-format=absolute", ...args]).pipe(
    Effect.flatMap((output) => {
      const lines = output.replace(/\n$/u, "").split("\n");
      return lines.length === count && lines.every((line) => line !== "" && !/\p{Cc}/u.test(line))
        ? Effect.succeed(lines)
        : Effect.fail(workspaceFailure("source", "Git reported unusable repository paths."));
    }),
  );

/** An absolute path Git keeps for the tree at `root`, such as its index or HEAD file. */
export const gitPath = (root: string, name: string) =>
  revParse(root, ["--git-path", name], 1).pipe(Effect.map(([file = ""]) => file));

// Git reports these states only as a failed rev-parse; probe so the refusal names the cause.
const unsupportedRepository = (sourceCwd: string, failure: WorkspaceError) =>
  Effect.gen(function* () {
    const probe = yield* Effect.option(
      git(sourceCwd, ["rev-parse", "--is-bare-repository", "--is-inside-git-dir"]),
    );
    if (Option.isNone(probe))
      return yield* workspaceRefusal("source", "The session directory isn't in a Git checkout.", {
        path: sourceCwd,
        rule: "isolated workspaces are linked worktrees of a Git checkout that Git accepts for the current user",
        remedy: `Start Pi inside a Git checkout you own, ${SHARED_CHECKOUT_REMEDY}.`,
      });
    const [bare, insideGitDirectory] = probe.value.split("\n");
    if (bare === "true")
      return yield* workspaceRefusal("source", "Bare repositories can't be snapshotted.", {
        path: sourceCwd,
        rule: "isolated workspaces need a checkout with a working tree",
        remedy: `Start Pi in a checkout or linked worktree of the repository, ${SHARED_CHECKOUT_REMEDY}.`,
      });
    if (insideGitDirectory === "true")
      return yield* workspaceRefusal(
        "source",
        "The session directory is inside Git's own metadata.",
        {
          path: sourceCwd,
          rule: "isolated workspaces need the session directory in the checkout's working tree",
          remedy: `Start Pi in the checkout's working tree, ${SHARED_CHECKOUT_REMEDY}.`,
        },
      );
    return yield* failure;
  });

/** The commit HEAD names in the tree at `root`. */
export const headCommit = (root: string) =>
  git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"]).pipe(
    Effect.catchIf(
      (error) => !error.cleanupUnconfirmed,
      () =>
        workspaceRefusal("source", "The repository has no commits on its current branch.", {
          path: root,
          rule: "isolated workspaces need HEAD to name a commit",
          remedy: `Create the first commit or check out a branch that has one, ${SHARED_CHECKOUT_REMEDY}.`,
        }),
    ),
    Effect.flatMap(oid),
  );

/**
 * Resolves the checkout holding `cwd`, which may be a main or linked worktree or a submodule,
 * and refuses repositories a workspace can't be a full linked worktree of.
 */
export const inspectSource = (cwd: string) =>
  Effect.gen(function* () {
    const resolved = yield* workspaceIO("source", () => fs.realpath(cwd));
    const sourceCwd = yield* checkDirectory(resolved);
    const [sourceRoot = "", gitDirectory = "", repository = ""] = yield* revParse(
      sourceCwd,
      ["--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
      3,
    ).pipe(
      Effect.catchIf(
        (error) => !error.cleanupUnconfirmed,
        (error) => unsupportedRepository(sourceCwd, error),
      ),
    );
    yield* checkDirectory(sourceRoot);
    yield* checkDirectory(gitDirectory);
    yield* checkDirectory(repository);
    const subdirectory = path.relative(sourceRoot, sourceCwd);
    if (
      subdirectory === ".." ||
      subdirectory.startsWith(`..${path.sep}`) ||
      path.isAbsolute(subdirectory)
    )
      return yield* workspaceRefusal(
        "source",
        "The session directory isn't inside its Git checkout.",
        {
          path: sourceCwd,
          rule: `the session directory must be inside the checkout at ${sourceRoot}`,
          remedy: `Start Pi inside the checkout, ${SHARED_CHECKOUT_REMEDY}.`,
        },
      );
    yield* headCommit(sourceRoot);
    // `git sparse-checkout disable` keeps the pattern file, so only the setting is authoritative.
    const sparse = yield* git(sourceRoot, [
      "config",
      "--type=bool",
      "--default=false",
      "--get",
      "core.sparseCheckout",
    ]);
    if (sparse.trim() === "true")
      return yield* workspaceRefusal("source", "Sparse checkouts can't be snapshotted.", {
        path: sourceRoot,
        rule: "isolated workspaces need every tracked file checked out (core.sparseCheckout is on)",
        remedy: `Run git sparse-checkout disable, ${SHARED_CHECKOUT_REMEDY}.`,
      });
    return { sourceRoot, sourceCwd, subdirectory, repository } satisfies SourceCheckout;
  });

/**
 * What integration must find unchanged in a source tree: its HEAD (commit and branch) and the
 * staged entries, not the index file, which `git status` rewrites to refresh stat data.
 */
export const sourceIdentity = (root: string) =>
  Effect.gen(function* () {
    const headPath = yield* gitPath(root, "HEAD");
    const head = yield* headCommit(root);
    const branch = yield* workspaceIO("source", () => fs.readFile(headPath, "utf8"));
    const staged = yield* git(root, ["ls-files", "--stage", "-v", "-z"]);
    return {
      head: `${head}\n${branch}`,
      index: nodeCreateHash("sha256").update(staged).digest("hex"),
    };
  });

/**
 * Refuses when the real index of the tree at `root` marks a path in `paths` skip-worktree or
 * assume-unchanged. Git then reads the indexed blob instead of the file, so captures can't see a
 * local edit there and integration would overwrite it.
 */
export const refuseHiddenLocalEdits = (
  root: string,
  operation: string,
  paths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const selected = new Set(paths);
    // `ls-files -v` tags skip-worktree entries `S` and assume-unchanged ones in lowercase.
    const hidden = (yield* gitFields(root, ["ls-files", "-v", "-z"])).flatMap((entry) => {
      const tag = entry.slice(0, 1);
      const name = entry.slice(2);
      return (tag === "S" || tag !== tag.toUpperCase()) && selected.has(name) ? [name] : [];
    });
    if (hidden.length === 0) return undefined;
    return yield* new WorkspaceError({
      operation,
      code: "workspace_local_override",
      message:
        hidden.length === 1
          ? "The parent index hides local edits to a file the proposal changes."
          : `The parent index hides local edits to ${hidden.length} files the proposal changes.`,
      detail: [
        `Hidden: ${listedPaths(hidden)}`,
        "Rule: Git skips the files of skip-worktree and assume-unchanged entries (`git ls-files -v` tags them `S` or lowercase), so their local edits can't be checked and integration would overwrite them.",
        "Nothing was changed.",
        `Remedy: in ${root}, clear the bit with \`git update-index --no-skip-worktree -- <path>\` or \`git update-index --no-assume-unchanged -- <path>\`, then prepare again; or revise the workspace so the writer leaves these files unchanged.`,
      ].join("\n"),
    });
  });
