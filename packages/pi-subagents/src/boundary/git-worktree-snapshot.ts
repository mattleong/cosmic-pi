import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SafeFile } from "pi-cosmic-core";
import {
  capturablePrivatePath,
  credentialWorkspacePath,
  dependencyWorkspacePath,
  eligibleUntrackedSource,
  MAX_WORKSPACE_BYTES,
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_FILES,
  safeWorkspacePath,
  sensitiveWorkspaceContent,
} from "../workspace/policy.ts";
import type { WorkspaceError } from "../workspace/model.ts";
import { repositoryExcludesFile } from "./git-installation.ts";
import { nodeErrorCode } from "./harness-shared.ts";
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
  writeWorkspaceFile,
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
/** A tree's capturable files, read and checked but not stored; `tree` is their Git tree id. */
export interface WorkspaceTreeRead {
  readonly entries: ReadonlyArray<SnapshotEntry>;
  readonly tree: string;
  /** Every path left out: tracked dependency/build files and ineligible untracked files. */
  readonly excludedPaths: ReadonlyArray<string>;
  /** The tracked subset of excludedPaths. */
  readonly omittedTrackedPaths: ReadonlyArray<string>;
}
export interface WorkspaceSnapshot extends WorkspaceTreeRead {
  readonly commit: string;
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

// Git reports these states only as a failed rev-parse; probe so the refusal names the cause.
const unsupportedRepository = (sourceCwd: string, failure: WorkspaceError) =>
  Effect.gen(function* () {
    const probe = yield* Effect.option(
      git(sourceCwd, ["rev-parse", "--is-bare-repository", "--is-inside-git-dir"]),
    );
    if (Option.isNone(probe))
      return yield* workspaceRefusal("source", "The session directory isn't in a Git checkout.", {
        path: sourceCwd,
        rule: "isolated workspaces snapshot a Git checkout that Git accepts for the current user",
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

const headCommit = (root: string) =>
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

export const inspectSource = (cwd: string) =>
  Effect.gen(function* () {
    const resolved = yield* workspaceIO("source", () => fs.realpath(cwd));
    const sourceCwd = yield* checkDirectory(resolved);
    const [sourceRoot = "", gitDirectory = ""] = yield* sourceRevParse(
      sourceCwd,
      ["--show-toplevel", "--absolute-git-dir"],
      2,
    ).pipe(
      Effect.catchIf(
        (error) => !error.cleanupUnconfirmed,
        (error) => unsupportedRepository(sourceCwd, error),
      ),
    );
    yield* checkDirectory(sourceRoot);
    yield* checkDirectory(gitDirectory);
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
          remedy: "Start Pi inside the checkout, " + SHARED_CHECKOUT_REMEDY,
        },
      );
    yield* headCommit(sourceRoot);
    // `git sparse-checkout disable` keeps the pattern file, so only the setting is authoritative;
    // the index check separately refuses skip-worktree entries a sparse checkout left behind.
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
    return { sourceRoot, sourceCwd, subdirectory };
  });

const IGNORE_FILE_RULE =
  "Git ignore files (core.excludesFile and info/exclude) must be readable, because Git silently skips rules it can't read";

/** The bytes of an ignore file Git would read, or undefined where Git finds none. */
const readIgnoreFile = (file: string) => {
  const unreadable = () =>
    workspaceRefusal("snapshot", "A Git ignore file couldn't be read.", {
      path: file,
      rule: `${IGNORE_FILE_RULE}; each must be a readable file of at most 4 MiB`,
      remedy: `Make the file readable, or remove it or the setting that names it, ${SHARED_CHECKOUT_REMEDY}.`,
    });
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        fs.open(file, "r").catch((cause: unknown) => {
          const code = nodeErrorCode(cause);
          if (code === "ENOENT" || code === "ENOTDIR") return undefined;
          throw cause;
        }),
      catch: unreadable,
    }),
    (handle) =>
      handle === undefined
        ? Effect.succeed(undefined)
        : Effect.tryPromise({ try: () => handle.stat(), catch: unreadable }).pipe(
            Effect.filterOrFail((stat) => stat.size <= MAX_WORKSPACE_FILE_BYTES, unreadable),
            Effect.andThen(Effect.tryPromise({ try: () => handle.readFile(), catch: unreadable })),
          ),
    (handle) =>
      handle === undefined
        ? Effect.void
        : workspaceIO("close", () => handle.close()).pipe(Effect.ignore),
  );
};

const infoExcludePath = (repository: string) =>
  sourceRevParse(repository, ["--git-path", "info/exclude"], 1).pipe(
    Effect.map(([file = ""]) => file),
  );

// preserveIgnoreRules records a private repository's excludes file in its own config. Reading it
// back with the isolated Git configuration keeps the user's include, includeIf and global excludes
// resolution away from private repositories and their trees.
const privateExcludesFile = (repository: string) =>
  git(repository, ["config", "--local", "--get", "core.excludesFile"]).pipe(
    Effect.map((value) => value.replace(/\n$/u, "")),
    Effect.catchIf(
      (error) => !error.cleanupUnconfirmed,
      () =>
        workspaceRefusal("snapshot", "A private workspace's ignore rules couldn't be read.", {
          path: repository,
          rule: "a private workspace repository records its source's excludes file as core.excludesFile",
          remedy:
            "Integrate or discard the source workspace and start the writer from the real checkout.",
        }),
    ),
  );

/**
 * The ignore rules Git applies in `root`, after checking that Git can read each file. A private
 * repository or tree uses only the rules recorded in its repository.
 */
const readableIgnoreRules = (root: string, privateRepository = false) =>
  Effect.gen(function* () {
    const excludesFile = privateRepository
      ? yield* privateExcludesFile(root)
      : yield* repositoryExcludesFile(root);
    // An empty value disables the excludes file; a relative one is relative to the checkout.
    if (excludesFile) yield* readIgnoreFile(path.resolve(root, excludesFile));
    const infoExclude = yield* readIgnoreFile(yield* infoExcludePath(root));
    return { excludesFile, infoExclude };
  });

/**
 * Gives a new private repository the ignore rules Git applies in `origin` (the source checkout,
 * or a source workspace's worker tree, whose private repository recorded them), so worker and
 * prepared trees ignore what the source ignores: its info/exclude and its effective excludes
 * file, which repository-local config keeps ahead of the user's global configuration.
 */
export const preserveIgnoreRules = (
  repository: string,
  origin: string,
  options: { readonly privateOrigin?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { excludesFile, infoExclude } = yield* readableIgnoreRules(origin, options.privateOrigin);
    const info = path.join(repository, "info");
    yield* workspaceIO("create", () => fs.mkdir(info, { recursive: true, mode: 0o700 }));
    if (infoExclude) yield* writeWorkspaceFile(path.join(info, "exclude"), infoExclude, 0o600);
    // Recorded even when unset, so the user's includeIf rules can't match the private repository.
    yield* git(repository, ["config", "core.excludesFile", excludesFile ?? ""]);
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

/**
 * Refuses a source file whose lines the index blob doesn't hold include a credential-like
 * literal; an untracked file is scanned whole. Lines the index already holds are stored in the
 * user's repository, so an edit near an existing test fixture passes.
 */
const credentialRefusal = (
  root: string,
  relative: string,
  bytes: Uint8Array,
  staged: IndexEntry | undefined,
) =>
  Effect.gen(function* () {
    const previous = staged && (yield* git(root, ["cat-file", "blob", staged.oid]));
    const match = sensitiveWorkspaceContent(bytes, previous);
    if (!match) return undefined;
    return yield* workspaceRefusal(
      "snapshot",
      "Unstaged content looks like it contains a credential.",
      {
        path: relative,
        rule: `lines not in the Git index must not contain ${match.rule} (line ${match.line})`,
        remedy:
          "Remove the credential and keep local secrets in ignored files; stage the file with git add if the value is a deliberate test fixture.",
      },
    );
  });

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

// On a case-insensitive filesystem a path from the index also opens a file whose name differs
// only in case, so a case-only rename would be captured under its old name and silently lost.
const pathWithoutExactName = (root: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const listings = new Map<string, ReadonlySet<string>>();
    for (const name of paths) {
      let directory = "";
      for (const part of name.split("/")) {
        let entries = listings.get(directory);
        if (!entries) {
          const names = yield* workspaceIO("snapshot", () =>
            fs.readdir(path.join(root, directory)),
          );
          // Compared normalized, as macOS filesystems treat names that differ only in form.
          entries = new Set(names.map((entry) => entry.normalize("NFC")));
          listings.set(directory, entries);
        }
        if (!entries.has(part.normalize("NFC"))) return name;
        directory = directory === "" ? part : `${directory}/${part}`;
      }
    }
    return undefined;
  });

export interface CaptureOptions {
  /** Paths captured even when untracked here, such as the baseline's files. */
  readonly requiredPaths?: ReadonlyArray<string>;
  /**
   * `root` is the user's checkout: copy only source-like untracked files without credential-shaped
   * names, and refuse credential-like content the index doesn't already hold. Private trees hold
   * only what a worker wrote, so they contribute every capturable file.
   */
  readonly userCheckout?: boolean;
  /** `root` is a private workspace tree: apply only the ignore rules its repository records. */
  readonly privateRepository?: boolean;
}

interface TreeNode {
  readonly files: Map<string, { readonly mode: string; readonly oid: string }>;
  readonly directories: Map<string, TreeNode>;
}

const treeNode = (): TreeNode => ({ files: new Map(), directories: new Map() });

// Git orders tree entries by their bytes, comparing a directory as if its name ended in "/".
const hashTree = (node: TreeNode): Buffer => {
  const items = [
    ...[...node.files].map(([name, file]) => ({
      name,
      key: Buffer.from(name),
      mode: file.mode,
      id: Buffer.from(file.oid, "hex"),
    })),
    ...[...node.directories].map(([name, child]) => ({
      name,
      key: Buffer.from(`${name}/`),
      mode: "40000",
      id: hashTree(child),
    })),
  ].toSorted((left, right) => Buffer.compare(left.key, right.key));
  const body = Buffer.concat(
    items.flatMap((item) => [Buffer.from(`${item.mode} ${item.name}\0`), item.id]),
  );
  return nodeCreateHash("sha1").update(`tree ${body.byteLength}\0`).update(body).digest();
};

/** The SHA-1 Git tree id of these files, computed without writing any object. */
export const snapshotTreeId = (
  entries: ReadonlyArray<Pick<SnapshotEntry, "path" | "mode" | "oid">>,
): string => {
  const root = treeNode();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    const name = parts.pop() ?? entry.path;
    let node = root;
    for (const part of parts) {
      let child = node.directories.get(part);
      if (!child) {
        child = treeNode();
        node.directories.set(part, child);
      }
      node = child;
    }
    node.files.set(name, { mode: entry.mode, oid: entry.oid });
  }
  return hashTree(root).toString("hex");
};

/**
 * Reads and checks every capturable file in `root` and computes their tree id in-process. A
 * verification compares that id with a stored tree without writing objects; captureSnapshot
 * also stores the files.
 */
export const readSnapshot = (root: string, options: CaptureOptions = {}) =>
  Effect.gen(function* () {
    const index = yield* readIndex(yield* gitFields(root, ["ls-files", "--stage", "-v", "-z"]));
    const { excludesFile } = yield* readableIgnoreRules(root, options.privateRepository);
    // The isolated Git reads no global configuration, so the user's excludes file is explicit.
    const untracked = yield* gitFields(root, [
      ...(excludesFile === undefined ? [] : ["-c", `core.excludesFile=${excludesFile}`]),
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const capturable = options.userCheckout ? eligibleUntrackedSource : capturablePrivatePath;
    // A required path the checkout no longer tracks keeps the credential-name rule there.
    const required = (options.requiredPaths ?? []).filter(
      (name) => !options.userCheckout || index.has(name) || !credentialWorkspacePath(name),
    );
    const known = new Set([...index.keys(), ...required]);
    const unknown = untracked.filter((name) => !known.has(name));
    // A tracked link may stand in for a whole dependency directory.
    const omitted = (name: string) =>
      dependencyWorkspacePath(name, index.get(name)?.mode === "120000");
    const candidates = [...new Set([...known, ...unknown.filter(capturable)])]
      .filter((name) => !omitted(name))
      .toSorted();
    const omittedTrackedPaths = [...known].filter(omitted).toSorted();
    const excludedPaths = [
      ...new Set([...omittedTrackedPaths, ...unknown.filter((name) => !capturable(name))]),
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
      const staged = index.get(name);
      if (options.userCheckout && file.mode !== "120000" && !stagedContent(staged, file.bytes, id))
        yield* credentialRefusal(root, name, file.bytes, staged);
      files.push({ path: name, oid: id, ...file });
    }
    const inexact = yield* pathWithoutExactName(
      root,
      files.map((file) => file.path),
    );
    if (inexact !== undefined)
      return yield* workspaceRefusal(
        "snapshot",
        "A file's name on disk differs in letter case from its Git path.",
        {
          path: inexact,
          rule: "on case-insensitive filesystems each captured path must match its on-disk name exactly, so case-only renames are unsupported",
          remedy: `Use the path's exact case: rename source files with git mv, and in a worker keep the original case and rename after integration, ${SHARED_CHECKOUT_REMEDY}.`,
        },
      );
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
    return {
      entries: files,
      tree: snapshotTreeId(files),
      excludedPaths,
      omittedTrackedPaths,
    } satisfies WorkspaceTreeRead;
  });

/** Stores a tree already read as a parentless commit at `reference`. */
export const storeSnapshot = (read: WorkspaceTreeRead, repository: string, reference: string) =>
  Effect.gen(function* () {
    const { commit, tree } = yield* importSnapshot(repository, reference, read.entries);
    // Verifications trust the in-process id, so every stored tree confirms it.
    if (tree !== read.tree)
      return yield* workspaceFailure(
        "snapshot",
        "Git stored a different tree than the snapshot computed; the capture was refused.",
      );
    return { ...read, commit } satisfies WorkspaceSnapshot;
  });

/** Reads `root` like readSnapshot and stores its files as a parentless commit at `reference`. */
export const captureSnapshot = (
  root: string,
  repository: string,
  reference: string,
  options: CaptureOptions = {},
) =>
  readSnapshot(root, options).pipe(
    Effect.flatMap((read) => storeSnapshot(read, repository, reference)),
  );

// `git diff` sections start with this header; diff content lines never do, because each starts
// with a space, "+", "-", "\\", or (in binary patches) base85, which has no space.
const DIFF_SECTION = Buffer.from("diff --git ");

const diffSections = (bytes: Uint8Array) => {
  const buffer = Buffer.from(bytes);
  const starts: number[] = [];
  for (let at = buffer.indexOf(DIFF_SECTION); at !== -1; at = buffer.indexOf(DIFF_SECTION, at + 1))
    if (at === 0 || buffer[at - 1] === 0x0a) starts.push(at);
  return starts.map((start, index) => buffer.subarray(start, starts[index + 1] ?? buffer.length));
};

const validUtf8 = (bytes: Uint8Array) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/**
 * Decodes a revision's patch, which reviews page as text. Git treats a file without a NUL in its
 * first 8,000 bytes as text and copies its bytes into the patch, so a changed file whose old or
 * new content isn't UTF-8 can't be represented; the refusal names each such file.
 */
export const decodeRevisionDiff = (bytes: Uint8Array, changedPaths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (validUtf8(bytes)) return new TextDecoder().decode(bytes);
    const sections = diffSections(bytes);
    // `git diff` and `git diff --name-only` list the same paths in the same order.
    const invalid =
      sections.length === changedPaths.length
        ? changedPaths.filter((_name, index) => !validUtf8(sections[index] ?? new Uint8Array()))
        : [];
    const listed = invalid.slice(0, 5).map((name) => JSON.stringify(name));
    return yield* workspaceRefusal(
      "freeze",
      invalid.length === 1
        ? "A changed text file isn't valid UTF-8."
        : "Changed text files aren't valid UTF-8.",
      {
        ...(invalid.length === 1 && { path: invalid[0] }),
        rule: `the proposal's changed files must be UTF-8 text or binary (a NUL byte in their first 8,000 bytes), before and after the change${
          invalid.length > 1
            ? `; affected: ${listed.join(", ")}${invalid.length > 5 ? `, and ${invalid.length - 5} more` : ""}`
            : ""
        }`,
        remedy:
          "Revise the workspace so the writer restores or converts the file to UTF-8, or discard it and make this change in a shared-checkout writer.",
      },
    );
  });

export const sourceIdentity = (root: string) =>
  Effect.gen(function* () {
    const [headPath = ""] = yield* sourceRevParse(root, ["--git-path", "HEAD"], 1);
    const head = yield* headCommit(root);
    const branch = yield* workspaceIO("source", () => fs.readFile(headPath, "utf8"));
    // The staged entries, not the index file: `git status` rewrites the file to refresh stat data
    // without changing what is staged.
    const staged = yield* git(root, ["ls-files", "--stage", "-v", "-z"]);
    return {
      head: `${head}\n${branch}`,
      index: nodeCreateHash("sha256").update(staged).digest("hex"),
    };
  });
