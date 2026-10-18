import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { clipText, SafeFile } from "pi-cosmic-core";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  checkDirectory,
  git,
  gitFields,
  repositoryGitFields,
  workspaceIO,
  workspaceIOIfPresent,
  workspaceRefusal,
  writeWorkspaceFile,
} from "./git-worktree-process.ts";
import { treeEntries } from "./git-capture.ts";

/** The file at a source checkout's top level naming untracked files isolated trees receive. */
const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
/** Most patterns `.worktreeinclude` may hold. */
const MAX_WORKTREE_INCLUDE_PATTERNS = 64;
/** Longest pattern `.worktreeinclude` may hold. */
const MAX_WORKTREE_INCLUDE_PATTERN_CHARS = 1_024;
const MAX_WORKTREE_INCLUDE_BYTES = 64 * 1024;
/** Most files `.worktreeinclude` may copy into one tree. */
const MAX_INCLUDED_FILES = 256;
/** Most bytes `.worktreeinclude` may copy into one tree. */
const MAX_INCLUDED_BYTES = 64 * 1024 * 1024;

const tooMuchIncluded = (operation: string, files: number, bytes: number) =>
  workspaceRefusal(operation, ".worktreeinclude matches too many files to copy.", {
    rule: `.worktreeinclude copies at most ${MAX_INCLUDED_FILES} files and ${MAX_INCLUDED_BYTES / 1024 / 1024} MiB into each isolated tree; it matched ${files} files of ${Math.ceil(bytes / 1024)} KiB`,
    remedy:
      "Narrow the patterns in the checkout's .worktreeinclude to small local files such as .env. Install dependencies with a WorktreeCreate hook instead.",
  });

const unreadableInclude = (file: string, rule: string) =>
  workspaceRefusal("create", "The checkout's .worktreeinclude can't be used.", {
    path: file,
    rule,
    remedy:
      "Fix or remove .worktreeinclude at the checkout's top level, then start the writer again.",
  });

/**
 * The gitignore-syntax patterns of a `.worktreeinclude` text: blank lines and `#` comments are
 * skipped, and unescaped trailing spaces dropped, as in a `.gitignore`.
 */
const parseWorktreeInclude = (text: string): ReadonlyArray<string> =>
  text.split("\n").flatMap((raw) => {
    const line = raw.replace(/\r$/u, "").replace(/(?<!\\) +$/u, "");
    return line === "" || line.startsWith("#") ? [] : [line];
  });

/**
 * The patterns of `root`'s `.worktreeinclude`, or none when it has no such file. A file that
 * isn't a regular file, is too large, or holds too many, too long, or control-character
 * patterns refuses.
 */
export const readWorktreeInclude = (root: string) =>
  Effect.gen(function* () {
    const file = path.join(root, WORKTREE_INCLUDE_FILE);
    const stat = yield* workspaceIOIfPresent("create", () => fs.lstat(file));
    if (!stat) return [];
    const limits = `.worktreeinclude is a regular file of at most ${MAX_WORKTREE_INCLUDE_BYTES / 1024} KiB with at most ${MAX_WORKTREE_INCLUDE_PATTERNS} patterns of at most ${MAX_WORKTREE_INCLUDE_PATTERN_CHARS} characters, without control characters`;
    const safe = yield* SafeFile;
    const read = yield* safe
      .readContainedRegularFile(file, root, MAX_WORKTREE_INCLUDE_BYTES)
      .pipe(Effect.mapError(() => unreadableInclude(file, limits)));
    const patterns = parseWorktreeInclude(new TextDecoder().decode(read.bytes));
    if (
      patterns.length > MAX_WORKTREE_INCLUDE_PATTERNS ||
      patterns.some(
        (pattern) => pattern.length > MAX_WORKTREE_INCLUDE_PATTERN_CHARS || /\p{Cc}/u.test(pattern),
      )
    )
      return yield* unreadableInclude(file, limits);
    return patterns;
  });

export const describeWorktreeInclude = (patterns: ReadonlyArray<string>) =>
  clipText(patterns.join(", "), 400);

/**
 * The `.worktreeinclude` patterns of the checkout holding `cwd`, or undefined outside a Git
 * checkout; the file is read the way workspace creation reads it.
 */
export const checkoutWorktreeInclude = (cwd: string) =>
  git(cwd, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.option,
    Effect.flatMap((root) =>
      Option.isNone(root) ? Effect.succeed(undefined) : readWorktreeInclude(root.value.trim()),
    ),
  );

/** The regular file at `name` below `root`, or undefined for anything else or nothing. */
const includedFileSize = (root: string, name: string) =>
  Effect.gen(function* () {
    const stat = yield* workspaceIOIfPresent("include", () => fs.lstat(path.join(root, name)));
    return stat?.isFile() ? stat.size : undefined;
  });

/**
 * Untracked regular files below `root` that `patterns` match and `baseline` doesn't carry, which
 * are ignored or credential-named ones. Git matches the patterns with gitignore syntax against
 * paths from the tree's top; symlinks, nested repositories, and other special files are skipped.
 */
export const matchIncludedFiles = (
  root: string,
  repository: string,
  baseline: string,
  patterns: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const listed = yield* gitFields(root, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      ...patterns.map((pattern) => `--exclude=${pattern}`),
    ]);
    const carried = yield* treeEntries(repository, baseline);
    const matched: string[] = [];
    let bytes = 0;
    for (const name of listed) {
      if (name.endsWith("/") || carried.has(name)) continue;
      const size = yield* includedFileSize(root, name);
      if (size === undefined) continue;
      matched.push(name);
      bytes += size;
    }
    if (matched.length > MAX_INCLUDED_FILES || bytes > MAX_INCLUDED_BYTES)
      return yield* tooMuchIncluded("create", matched.length, bytes);
    return matched.toSorted();
  });

/** The subset of `paths` the stored tree `tree` holds. */
const heldPaths = (repository: string, tree: string, paths: ReadonlyArray<string>) =>
  paths.length === 0
    ? Effect.succeed(new Set<string>())
    : repositoryGitFields(repository, [
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        "--full-tree",
        tree,
        "--",
        ...paths.map((name) => `:(literal)${name}`),
      ]).pipe(Effect.map((names) => new Set(names)));

/**
 * The included paths a capture of a tree checked out at `tree` leaves out: every one the tree
 * doesn't carry. Only a test tree whose parent files started tracking an included path carries it.
 */
export const includedLeftOut = (
  repository: string,
  tree: string,
  includedPaths: ReadonlyArray<string> | undefined,
) =>
  Effect.gen(function* () {
    if (includedPaths === undefined || includedPaths.length === 0) return [];
    const held = yield* heldPaths(repository, tree, includedPaths);
    return includedPaths.filter((name) => !held.has(name));
  });

/**
 * Copies each of `paths` that is a regular file below `from` to the same path below `to`, with
 * its permission bits, and returns the copied ones. A path that is gone, no longer a regular
 * file, or already present in `to` (such as one the tree's checkout tracks) is skipped; parent
 * directories are created, never followed through a symlink.
 */
export const copyIncludedFiles = (
  operation: string,
  from: string,
  to: string,
  paths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (paths.length > MAX_INCLUDED_FILES)
      return yield* tooMuchIncluded(operation, paths.length, 0);
    const safe = yield* SafeFile;
    const copied: string[] = [];
    let bytes = 0;
    for (const name of paths) {
      const source = path.join(from, name);
      const target = path.join(to, name);
      const stat = yield* workspaceIOIfPresent(operation, () => fs.lstat(source));
      if (!stat?.isFile()) continue;
      if (yield* workspaceIOIfPresent(operation, () => fs.lstat(target))) continue;
      const read = yield* safe
        .readContainedRegularFile(source, from, MAX_INCLUDED_BYTES - bytes)
        .pipe(Effect.option);
      if (Option.isNone(read)) {
        // Either it grew past the remaining budget or it changed into something else meanwhile.
        if (bytes + stat.size > MAX_INCLUDED_BYTES)
          return yield* tooMuchIncluded(operation, paths.length, bytes + stat.size);
        continue;
      }
      bytes += read.value.bytes.byteLength;
      yield* checkDirectory(path.dirname(target), true);
      yield* workspaceIO(operation, () => fs.mkdir(path.dirname(target), { recursive: true }));
      yield* writeWorkspaceFile(target, read.value.bytes, stat.mode & 0o777);
      copied.push(name);
    }
    return copied;
  });
