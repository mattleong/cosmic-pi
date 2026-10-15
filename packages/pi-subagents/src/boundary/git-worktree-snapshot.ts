import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { SafeFile } from "pi-cosmic-core";
import {
  dependencyWorkspacePath,
  eligibleUntrackedSource,
  MAX_WORKSPACE_BYTES,
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_FILES,
  safeWorkspacePath,
  sensitiveWorkspaceContent,
} from "../workspace/policy.ts";
import { nodeCreateHash, nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import {
  checkDirectory,
  git,
  gitFields,
  oid,
  workspaceFailure,
  workspaceIO,
  workspaceIOIfPresent,
  workspaceRefusal,
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
  /** Every path left out: tracked dependency/build files and ineligible untracked files. */
  readonly excludedPaths: ReadonlyArray<string>;
  /** The tracked subset of excludedPaths. */
  readonly omittedTrackedPaths: ReadonlyArray<string>;
}

const SHARED_CHECKOUT_REMEDY = "or use the shared-checkout writer workspace";

const sourceRevParse = (cwd: string, args: ReadonlyArray<string>, count: number) =>
  git(cwd, ["rev-parse", "--path-format=absolute", ...args]).pipe(
    Effect.flatMap((output) => {
      const lines = output.replace(/\n$/u, "").split("\n");
      return lines.length === count && lines.every((line) => line !== "" && !/\p{Cc}/u.test(line))
        ? Effect.succeed(lines)
        : Effect.fail(workspaceFailure("source", "Git reported unusable repository paths."));
    }),
  );

export const inspectSource = (cwd: string) =>
  Effect.gen(function* () {
    const resolved = yield* workspaceIO("source", () => fs.realpath(cwd));
    const sourceCwd = yield* checkDirectory(resolved);
    const [sourceRoot = "", gitDirectory = "", sparseFile = ""] = yield* sourceRevParse(
      sourceCwd,
      ["--show-toplevel", "--absolute-git-dir", "--git-path", "info/sparse-checkout"],
      3,
    );
    yield* checkDirectory(sourceRoot);
    yield* checkDirectory(gitDirectory);
    const subdirectory = path.relative(sourceRoot, sourceCwd);
    if (subdirectory.startsWith("..") || path.isAbsolute(subdirectory))
      return yield* workspaceRefusal(
        "source",
        "The session directory isn't inside its Git checkout.",
        {
          path: sourceCwd,
          rule: `the session directory must be inside the checkout at ${sourceRoot}`,
          remedy: "Start Pi inside the checkout, " + SHARED_CHECKOUT_REMEDY,
        },
      );
    const sparse = yield* workspaceIOIfPresent("source", () =>
      fs.access(sparseFile).then(() => true),
    );
    if (sparse)
      return yield* workspaceRefusal("source", "Sparse checkouts can't be snapshotted.", {
        path: sparseFile,
        rule: "isolated workspaces need every tracked file checked out",
        remedy: `Run git sparse-checkout disable, ${SHARED_CHECKOUT_REMEDY}.`,
      });
    return { sourceRoot, sourceCwd, subdirectory };
  });

interface FileStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly nlink: number;
  readonly size: number;
  readonly mode: number;
  readonly ino: number;
  readonly dev: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

const unsupportedFileRefusal = (relative: string, stat: FileStat) => {
  const refuse = (message: string, rule: string, remedy: string) =>
    workspaceRefusal("snapshot", message, { path: relative, rule, remedy });
  if (stat.isSymbolicLink())
    return refuse(
      "A symlink can't be copied into the isolated workspace.",
      "only tracked symlinks to a captured regular file in the repository are supported",
      `Track the link in Git, replace it with a regular file, add it to .gitignore, ${SHARED_CHECKOUT_REMEDY}.`,
    );
  if (!stat.isFile())
    return refuse(
      "A special file can't be copied into the isolated workspace.",
      "only regular files and tracked internal symlinks are supported",
      `Remove the special file or add it to .gitignore, ${SHARED_CHECKOUT_REMEDY}.`,
    );
  if (stat.nlink !== 1)
    return refuse(
      "A hard-linked file can't be copied into the isolated workspace.",
      "files must have exactly one hard link",
      `Replace the hard link with a separate copy or add it to .gitignore, ${SHARED_CHECKOUT_REMEDY}.`,
    );
  if (stat.size > MAX_WORKSPACE_FILE_BYTES)
    return refuse(
      "A file is too large for the isolated workspace.",
      "each file must be at most 4 MiB",
      `Add large or generated files to .gitignore, ${SHARED_CHECKOUT_REMEDY}.`,
    );
  if ((stat.mode & 0o7000) !== 0)
    return refuse(
      "A file with setuid, setgid, or sticky bits can't be copied into the isolated workspace.",
      "setuid, setgid, and sticky mode bits are unsupported",
      `Clear those bits with chmod ug-s,-t, ${SHARED_CHECKOUT_REMEDY}.`,
    );
  return undefined;
};

const changedWhileReading = (before: FileStat, after: FileStat) =>
  before.ino !== after.ino ||
  before.dev !== after.dev ||
  before.mtimeMs !== after.mtimeMs ||
  before.ctimeMs !== after.ctimeMs ||
  before.mode !== after.mode ||
  after.nlink !== 1;

const unstableFileRefusal = (relative: string) =>
  workspaceRefusal("snapshot", "A file changed while it was being copied.", {
    path: relative,
    rule: "files must stay unchanged and inside the checkout while they are copied",
    remedy: "Try again once tools stop writing to the file.",
  });

const requireUtf8Text = (relative: string, bytes: Uint8Array) =>
  bytes.subarray(0, 8000).includes(0)
    ? Effect.void
    : Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () =>
          workspaceRefusal("snapshot", "A text file isn't valid UTF-8.", {
            path: relative,
            rule: "text must be UTF-8; binary files need a NUL byte in their first 8,000 bytes",
            remedy: `Convert the file to UTF-8 or add it to .gitignore if it is generated, ${SHARED_CHECKOUT_REMEDY}.`,
          }),
      });

export const readWorkspaceFile = (
  root: string,
  relative: string,
  snapshotPaths?: { readonly links: ReadonlySet<string>; readonly files: ReadonlySet<string> },
) =>
  Effect.gen(function* () {
    if (!safeWorkspacePath(relative))
      return yield* workspaceRefusal("snapshot", "A file path can't be used in the snapshot.", {
        path: relative,
        rule: "paths must be relative and free of control characters, backslashes, colons, '.', '..', and '.git' segments",
        remedy: `Rename the file or add it to .gitignore, ${SHARED_CHECKOUT_REMEDY}.`,
      });
    const full = path.join(root, relative);
    yield* checkDirectory(path.dirname(full), true);
    const before = yield* workspaceIOIfPresent("snapshot", () => fs.lstat(full));
    if (!before) return undefined;
    if (before.isSymbolicLink() && snapshotPaths?.links.has(relative))
      return yield* readWorkspaceSymlink(root, relative, snapshotPaths.files);
    const unsupported = unsupportedFileRefusal(relative, before);
    if (unsupported) return yield* unsupported;
    const safe = yield* SafeFile;
    const { bytes } = yield* safe
      .readContainedRegularFile(full, root, MAX_WORKSPACE_FILE_BYTES)
      .pipe(Effect.mapError(() => unstableFileRefusal(relative)));
    const after = yield* workspaceIO("snapshot", () => fs.lstat(full));
    if (changedWhileReading(before, after)) return yield* unstableFileRefusal(relative);
    yield* requireUtf8Text(relative, bytes);
    return {
      bytes,
      mode: (before.mode & 0o111) !== 0 ? "100755" : "100644",
      permissions: before.mode & 0o777,
    };
  });

type HashAlgorithm = "sha1" | "sha256";

/** Git's object id for a blob, computed in-process. */
export const blobId = (bytes: Uint8Array, algorithm: HashAlgorithm = "sha1"): string =>
  nodeCreateHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

interface IndexEntry {
  readonly mode: string;
  readonly oid: string;
  readonly algorithm: HashAlgorithm;
}

const INDEX_LINE = /^([A-Za-z]) (\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) (\d)\t(.+)$/su;

const indexEntryRefusal = (name: string, tag: string, mode: string, stage: string) => {
  if (stage !== "0")
    return workspaceRefusal("snapshot", "The checkout has unresolved merge conflicts.", {
      path: name,
      rule: "unmerged index entries are unsupported",
      remedy: "Resolve the conflicts and stage the results.",
    });
  if (mode === "160000")
    return workspaceRefusal("snapshot", "The checkout contains a Git submodule.", {
      path: name,
      rule: "submodules inside the repository are unsupported",
      remedy: `Remove the submodule, ${SHARED_CHECKOUT_REMEDY}.`,
    });
  if (tag !== "H")
    return workspaceRefusal(
      "snapshot",
      "A file is marked skip-worktree or assume-unchanged in the Git index.",
      {
        path: name,
        rule: "sparse, skip-worktree, and assume-unchanged index entries are unsupported",
        remedy: `Clear the flag with git update-index --no-skip-worktree --no-assume-unchanged, ${SHARED_CHECKOUT_REMEDY}.`,
      },
    );
  return workspaceRefusal("snapshot", "The Git index has an unsupported entry.", {
    path: name,
    rule: "only regular files and symlinks are supported in the index",
    remedy: "Use the shared-checkout writer workspace for this repository.",
  });
};

// `ls-files -s -v` lines: "<tag> <mode> <oid> <stage>\t<path>"; "H" is an ordinary cached entry.
const readIndex = (lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const entries = new Map<string, IndexEntry>();
    for (const line of lines) {
      const match = INDEX_LINE.exec(line);
      const [, tag = "", mode = "", hash = "", stage = "", name = line] = match ?? [];
      if (!match || tag !== "H" || stage !== "0" || !["100644", "100755", "120000"].includes(mode))
        return yield* indexEntryRefusal(name, tag, mode, stage);
      entries.set(name, { mode, oid: hash, algorithm: hash.length === 64 ? "sha256" : "sha1" });
    }
    return entries;
  });

/** Whether the bytes are exactly the index's blob, which the source repository already stores. */
const stagedContent = (entry: IndexEntry | undefined, bytes: Uint8Array, sha1: string) =>
  entry?.oid === (entry?.algorithm === "sha256" ? blobId(bytes, "sha256") : sha1);

type CapturedFile = SnapshotEntry & { readonly symlinkTarget?: string };

const credentialRefusal = (relative: string, bytes: Uint8Array) => {
  const match = sensitiveWorkspaceContent(bytes);
  return match
    ? workspaceRefusal("snapshot", "Unstaged content looks like it contains a credential.", {
        path: relative,
        rule: `content not in the Git index must not contain ${match.rule} (line ${match.line})`,
        remedy:
          "Remove the credential and keep local secrets in ignored files; stage the file with git add if the value is a deliberate test fixture.",
      })
    : undefined;
};

const quotedImportPath = (name: string) => `"${name.replace(/["\\]/gu, "\\$&")}"`;

// One fast-import stream writes every blob and a parentless commit, replacing a Git process per
// file. Blobs come from the bytes already read and checked, so no filter or attribute applies.
const importSnapshot = (
  repository: string,
  reference: string,
  files: ReadonlyArray<CapturedFile>,
) =>
  Effect.gen(function* () {
    const nonce = yield* newWorkspaceId;
    const seconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [encoder.encode("feature done\n")];
    for (const [index, file] of files.entries()) {
      chunks.push(
        encoder.encode(`blob\nmark :${index + 1}\ndata ${file.bytes.byteLength}\n`),
        file.bytes,
        encoder.encode("\n"),
      );
    }
    const message = encoder.encode(`Private workspace snapshot ${nonce}\n`);
    const ref = `refs/pi/${reference}`;
    chunks.push(
      encoder.encode(
        `reset ${ref}\ncommit ${ref}\ncommitter Pi workspace <workspace@invalid> ${seconds} +0000\ndata ${message.byteLength}\n`,
      ),
      message,
      encoder.encode(
        `\n${files.map((file, index) => `M ${file.mode} :${index + 1} ${quotedImportPath(file.path)}\n`).join("")}\ndone\n`,
      ),
    );
    yield* git(repository, ["fast-import", "--quiet", "--force", "--date-format=raw"], {
      stdin: Buffer.concat(chunks),
    });
    const [commit = "", tree = ""] = (yield* git(repository, ["rev-parse", ref, `${ref}^{tree}`]))
      .replace(/\n$/u, "")
      .split("\n");
    return { commit: yield* oid(commit), tree: yield* oid(tree) };
  });

export interface CaptureOptions {
  /** Paths captured even when untracked here, such as the baseline's files. */
  readonly requiredPaths?: ReadonlyArray<string>;
  /** Refuse credential-like content the index doesn't already hold (source checkouts only). */
  readonly scanNewContent?: boolean;
}

export const captureSnapshot = (
  root: string,
  repository: string,
  reference: string,
  options: CaptureOptions = {},
) =>
  Effect.gen(function* () {
    const index = yield* readIndex(yield* gitFields(root, ["ls-files", "--stage", "-v", "-z"]));
    const untracked = yield* gitFields(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const known = new Set([...index.keys(), ...(options.requiredPaths ?? [])]);
    const unknown = untracked.filter((name) => !known.has(name));
    const candidates = [...new Set([...known, ...unknown.filter(eligibleUntrackedSource)])]
      .filter((name) => !dependencyWorkspacePath(name))
      .toSorted();
    const omittedTrackedPaths = [...known].filter(dependencyWorkspacePath).toSorted();
    const excludedPaths = [
      ...new Set([
        ...omittedTrackedPaths,
        ...unknown.filter((name) => !eligibleUntrackedSource(name)),
      ]),
    ].toSorted();
    if (candidates.length > MAX_WORKSPACE_FILES)
      return yield* workspaceRefusal("snapshot", "The checkout has too many files to snapshot.", {
        rule: `at most ${MAX_WORKSPACE_FILES} files (found ${candidates.length})`,
        remedy: `Add generated or vendored files to .gitignore, ${SHARED_CHECKOUT_REMEDY}.`,
      });
    const links = new Set<string>();
    for (const [name, entry] of index) if (entry.mode === "120000") links.add(name);
    const includedPaths = new Set(candidates);
    const files: CapturedFile[] = [];
    let size = 0;
    for (const name of candidates) {
      const file = yield* readWorkspaceFile(root, name, { links, files: includedPaths });
      if (!file) continue;
      size += file.bytes.length;
      if (size > MAX_WORKSPACE_BYTES)
        return yield* workspaceRefusal("snapshot", "The checkout is too large to snapshot.", {
          path: name,
          rule: "at most 32 MiB of files in total",
          remedy: `Add large or generated files to .gitignore, ${SHARED_CHECKOUT_REMEDY}.`,
        });
      const id = blobId(file.bytes);
      if (options.scanNewContent && file.mode !== "120000") {
        const refusal = stagedContent(index.get(name), file.bytes, id)
          ? undefined
          : credentialRefusal(name, file.bytes);
        if (refusal) return yield* refusal;
      }
      files.push({ path: name, oid: id, ...file });
    }
    const regularPaths = new Set<string>();
    for (const file of files) if (file.mode !== "120000") regularPaths.add(file.path);
    const dangling = files.find(
      (file) => file.symlinkTarget !== undefined && !regularPaths.has(file.symlinkTarget),
    );
    if (dangling)
      return yield* workspaceRefusal("snapshot", "A symlink's target wasn't captured.", {
        path: dangling.path,
        rule: "tracked symlinks must point to a regular file captured in the same snapshot",
        remedy: `Point the link at a tracked regular file in the repository, ${SHARED_CHECKOUT_REMEDY}.`,
      });
    const { commit, tree } = yield* importSnapshot(repository, reference, files);
    return {
      entries: files,
      tree,
      commit,
      excludedPaths,
      omittedTrackedPaths,
    } satisfies WorkspaceSnapshot;
  });

export const sourceIdentity = (root: string) =>
  Effect.gen(function* () {
    const [gitDirectory = "", indexPath = "", headPath = "", head = ""] = yield* sourceRevParse(
      root,
      ["--absolute-git-dir", "--git-path", "index", "--git-path", "HEAD", "HEAD"],
      4,
    );
    yield* oid(head);
    const branch = yield* workspaceIO("source", () => fs.readFile(headPath, "utf8"));
    const safe = yield* SafeFile;
    const { bytes } = yield* safe
      .readContainedRegularFile(indexPath, gitDirectory, MAX_WORKSPACE_BYTES)
      .pipe(
        Effect.mapError(() => workspaceFailure("source", "Cannot preserve source index identity.")),
      );
    return { head: `${head}\n${branch}`, index: Buffer.from(bytes).toString("base64") };
  });
