import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SafeFile } from "pi-cosmic-core";
import type { WorkspaceInclude } from "../config/schema.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  checkDirectory,
  gitFields,
  repositoryGitFields,
  workspaceIO,
  workspaceIOIfPresent,
  workspaceRefusal,
  writeWorkspaceFile,
} from "./git-worktree-process.ts";
import { treeEntries } from "./git-capture.ts";

/** Most files `workspaceInclude` may copy into one tree. */
export const MAX_INCLUDED_FILES = 256;
/** Most bytes `workspaceInclude` may copy into one tree. */
export const MAX_INCLUDED_BYTES = 64 * 1024 * 1024;

const tooMuchIncluded = (operation: string, files: number, bytes: number) =>
  workspaceRefusal(operation, "workspaceInclude matches too many files to copy.", {
    rule: `workspaceInclude copies at most ${MAX_INCLUDED_FILES} files and ${MAX_INCLUDED_BYTES / 1024 / 1024} MiB into each isolated tree; it matched ${files} files of ${Math.ceil(bytes / 1024)} KiB`,
    remedy:
      "Narrow the workspaceInclude patterns in the project's .pi/pi-subagents.json to small local files such as .env, then /reload. Install dependencies with workspaceSetup instead.",
  });

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
  patterns: WorkspaceInclude,
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
