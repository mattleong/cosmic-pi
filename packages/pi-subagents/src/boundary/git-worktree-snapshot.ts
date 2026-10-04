import * as Effect from "effect/Effect";
import { SafeFile } from "pi-cosmic-core";
import {
  eligibleUntrackedSource,
  excludedWorkspacePath,
  MAX_WORKSPACE_BYTES,
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_FILES,
  safeWorkspacePath,
  sensitiveWorkspaceContent,
} from "../workspace/policy.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  checkDirectory,
  git,
  oid,
  workspaceFailure,
  workspaceIO,
  workspaceIOIfPresent,
} from "./git-worktree-process.ts";
import { newWorkspaceId } from "./git-worktree-store.ts";
import { readWorkspaceSymlink } from "./git-worktree-symlink.ts";

export interface SnapshotEntry {
  readonly path: string;
  readonly oid: string;
  readonly mode: string;
  readonly permissions: number;
  readonly bytes: Uint8Array;
}
export interface WorkspaceSnapshot {
  readonly entries: ReadonlyArray<SnapshotEntry>;
  readonly tree: string;
  readonly commit: string;
  readonly excludedPaths: ReadonlyArray<string>;
}
export const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

export const inspectSource = (cwd: string) =>
  Effect.gen(function* () {
    if (process.platform === "win32")
      return yield* workspaceFailure(
        "source",
        "Git workspaces require POSIX filesystem semantics.",
      );
    const sourceCwd = yield* checkDirectory(cwd);
    const sourceRoot = (yield* git(sourceCwd, ["rev-parse", "--show-toplevel"])).trim();
    yield* checkDirectory(sourceRoot);
    const subdirectory = path.relative(sourceRoot, sourceCwd);
    if (
      subdirectory.startsWith("..") ||
      path.isAbsolute(subdirectory) ||
      /\p{Cc}/u.test(sourceRoot)
    )
      return yield* workspaceFailure(
        "source",
        "Invocation directory must be contained in the source checkout.",
      );
    // Linked source worktrees, bare repositories, sparse indexes and submodules are not supported.
    yield* checkDirectory(path.join(sourceRoot, ".git"));
    const sparse = yield* workspaceIOIfPresent("source", () =>
      fs.access(path.join(sourceRoot, ".git", "info", "sparse-checkout")).then(() => true),
    );
    if (sparse) return yield* workspaceFailure("source", "Sparse checkouts are unsupported.");
    return { sourceRoot, sourceCwd, subdirectory };
  });

export const readWorkspaceFile = (
  root: string,
  relative: string,
  snapshotPaths?: { readonly links: ReadonlySet<string>; readonly files: ReadonlySet<string> },
) =>
  Effect.gen(function* () {
    if (!safeWorkspacePath(relative))
      return yield* workspaceFailure("snapshot", "Unsafe workspace path.");
    const full = path.join(root, relative);
    yield* checkDirectory(path.dirname(full), true);
    const before = yield* workspaceIOIfPresent("snapshot", () => fs.lstat(full));
    if (!before) return undefined;
    if (before.isSymbolicLink() && snapshotPaths?.links.has(relative))
      return yield* readWorkspaceSymlink(root, relative, snapshotPaths.files);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > MAX_WORKSPACE_FILE_BYTES ||
      (before.mode & 0o7000) !== 0
    )
      return yield* workspaceFailure(
        "snapshot",
        "Symlinks, hardlinks, special files, special modes and oversized files are unsupported.",
      );
    const safe = yield* SafeFile;
    const { bytes } = yield* safe
      .readContainedRegularFile(full, root, MAX_WORKSPACE_FILE_BYTES)
      .pipe(
        Effect.mapError(() =>
          workspaceFailure("snapshot", "Unable to read stable workspace file."),
        ),
      );
    const after = yield* workspaceIO("snapshot", () => fs.lstat(full));
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      after.nlink !== 1
    )
      return yield* workspaceFailure("snapshot", "Workspace file changed while reading.");
    // Git only checks the first 8000 bytes for NUL when choosing binary patches.
    // Textual diff stdout is UTF-8, so reject invalid UTF-8 that Git would call text.
    if (!bytes.subarray(0, 8000).includes(0))
      yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () =>
          workspaceFailure(
            "snapshot",
            "Non-UTF-8 text is unsupported; binary files require a NUL in the first 8000 bytes.",
          ),
      });
    if (sensitiveWorkspaceContent(bytes))
      return yield* workspaceFailure(
        "snapshot",
        "Input matched the conservative sensitive-content policy; snapshot refused.",
      );
    return {
      bytes,
      mode: (before.mode & 0o111) !== 0 ? "100755" : "100644",
      permissions: before.mode & 0o777,
    };
  });

export const captureSnapshot = (
  root: string,
  repository: string,
  index: string,
  reference: string,
  requiredPaths: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const stages = (yield* git(root, ["ls-files", "--stage", "-z"])).split("\0").filter(Boolean);
    const tracked: string[] = [];
    const links = new Set<string>();
    for (const line of stages) {
      const match = /^(100644|100755|120000) ([a-f0-9]{40}) 0\t(.+)$/su.exec(line);
      if (!match)
        return yield* workspaceFailure(
          "snapshot",
          "Unmerged indexes and submodules are unsupported.",
        );
      tracked.push(match[3]!);
      if (match[1] === "120000") links.add(match[3]!);
    }
    const flags = (yield* git(root, ["ls-files", "-v", "-z"])).split("\0").filter(Boolean);
    if (flags.some((entry) => entry[0] !== "H"))
      return yield* workspaceFailure(
        "snapshot",
        "Sparse, assume-unchanged or unsupported index state.",
      );
    const untracked = (yield* git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean);
    const candidates = [
      ...new Set([...requiredPaths, ...tracked, ...untracked.filter(eligibleUntrackedSource)]),
    ].sort();
    const excludedPaths = [
      ...new Set([
        ...tracked.filter(excludedWorkspacePath),
        ...untracked.filter((name) => !eligibleUntrackedSource(name)),
      ]),
    ].sort();
    if (candidates.length > MAX_WORKSPACE_FILES)
      return yield* workspaceFailure(
        "snapshot",
        "Workspace file count exceeds the snapshot limit.",
      );
    const files: Array<Omit<SnapshotEntry, "oid"> & { readonly symlinkTarget?: string }> = [];
    const includedPaths = new Set(candidates.filter((name) => !excludedWorkspacePath(name)));
    let size = 0;
    for (const name of candidates) {
      if (!safeWorkspacePath(name))
        return yield* workspaceFailure("snapshot", "Unsafe workspace path.");
      if (excludedWorkspacePath(name)) continue;
      if (/(?:^|\/)\.gitattributes$/u.test(name))
        return yield* workspaceFailure(
          "snapshot",
          "Git attributes are unsupported; filters and checkout conversions must not execute.",
        );
      const file = yield* readWorkspaceFile(root, name, { links, files: includedPaths });
      if (!file) continue;
      size += file.bytes.length;
      if (size > MAX_WORKSPACE_BYTES)
        return yield* workspaceFailure("snapshot", "Workspace exceeds the byte limit.");
      files.push({ path: name, ...file });
    }
    const regularPaths = new Set(
      files.filter((file) => file.mode !== "120000").map((file) => file.path),
    );
    if (
      files.some(
        (file) => file.symlinkTarget !== undefined && !regularPaths.has(file.symlinkTarget),
      )
    )
      return yield* workspaceFailure(
        "snapshot",
        "Workspace link target was not captured as a regular file.",
      );
    // All path/content checks complete before any blob is written. No git add, ever.
    yield* git(repository, ["read-tree", "--empty"], { index });
    const entries: SnapshotEntry[] = [];
    for (const file of files) {
      const hash = yield* git(repository, ["hash-object", "-w", "--stdin", "--no-filters"], {
        stdin: file.bytes,
      }).pipe(Effect.flatMap(oid));
      yield* git(repository, ["update-index", "--add", "--cacheinfo", file.mode, hash, file.path], {
        index,
      });
      entries.push({ ...file, oid: hash });
    }
    const tree = yield* git(repository, ["write-tree"], { index }).pipe(Effect.flatMap(oid));
    const nonce = yield* newWorkspaceId();
    const commit = yield* git(repository, [
      "commit-tree",
      tree,
      "-m",
      `Private workspace snapshot ${nonce}`,
    ]).pipe(Effect.flatMap(oid));
    yield* git(repository, ["update-ref", `refs/pi/${reference}`, commit]);
    return { entries, tree, commit, excludedPaths } satisfies WorkspaceSnapshot;
  });

/**
 * Whether a settled worker at `root` holds nothing beyond its baseline: its snapshot has the
 * baseline's tree and leaves no file out, and its tree has no file the index doesn't track,
 * ignored ones included. The worker was checked out from the baseline snapshot, which holds none
 * of those, so a writer made each one. Empty directories hold no work: no revision carries them.
 */
export const workerMatchesBaseline = (
  root: string,
  snapshot: WorkspaceSnapshot,
  baselineTree: string,
) =>
  Effect.gen(function* () {
    if (snapshot.tree !== baselineTree || snapshot.excludedPaths.length > 0) return false;
    const untracked = yield* git(root, [
      "ls-files",
      "--others",
      "--directory",
      "--no-empty-directory",
      "-z",
    ]);
    return untracked.length === 0;
  });

export const sourceIdentity = (root: string) =>
  Effect.gen(function* () {
    const head = yield* git(root, ["rev-parse", "--verify", "HEAD"]).pipe(Effect.flatMap(oid));
    const branch = yield* workspaceIO("source", () =>
      fs.readFile(path.join(root, ".git", "HEAD"), "utf8"),
    );
    const indexPath = path.join(root, ".git", "index");
    const safe = yield* SafeFile;
    const { bytes } = yield* safe
      .readContainedRegularFile(indexPath, root, MAX_WORKSPACE_BYTES)
      .pipe(
        Effect.mapError(() => workspaceFailure("source", "Cannot preserve source index identity.")),
      );
    return { head: `${head}\n${branch}`, index: Buffer.from(bytes).toString("base64") };
  });
