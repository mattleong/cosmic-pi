import * as Effect from "effect/Effect";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import {
  runBoundedProcessNode,
  type BoundedProcessError,
  type BoundedProcessResult,
} from "pi-cosmic-core/platform/process";
import { nodeFsPromises as fs, nodePath as path } from "pi-cosmic-core/platform/node-builtins";
import { WorkspaceError } from "../workspace/model.ts";
import { gitInstallation } from "./git-installation.ts";
import { isGitLocalEnvironmentKey } from "./git-local-environment.ts";
import { nodeErrorCode } from "./harness-shared.ts";

export const workspaceFailure = (operation: string, message: string) =>
  WorkspaceError.make({ operation, message });

interface WorkspaceRefusalReason {
  /** Relative to the tree being captured, when one file caused the refusal. */
  readonly path?: string;
  readonly rule: string;
  readonly remedy: string;
  /** The remedy is a step for the parent agent, which the user's view leaves out. */
  readonly agentRemedy?: boolean;
}

/** A refusal whose detail names the path, the rule that fired, and how to resolve it. */
export const workspaceRefusal = (
  operation: string,
  message: string,
  reason: WorkspaceRefusalReason,
) =>
  WorkspaceError.make({
    operation,
    message,
    detail: Arr.join(
      [
        ...(reason.path === undefined ? [] : [`Path: ${JSON.stringify(reason.path)}`]),
        `Rule: ${reason.rule}`,
        ...(reason.agentRemedy === true ? [] : [`Remedy: ${reason.remedy}`]),
      ],
      "\n",
    ),
    ...(reason.agentRemedy === true && { remedy: reason.remedy }),
  });
export const workspaceIO = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => workspaceFailure(operation, "A workspace filesystem operation failed."),
  });
export const workspaceIOIfPresent = <A>(operation: string, run: () => Promise<A>) =>
  workspaceIO(operation, () =>
    run().catch((cause: unknown) => {
      if (nodeErrorCode(cause) === "ENOENT") return undefined;
      throw cause;
    }),
  );

const MAX_GIT_DETAIL_LINES = 12;
const MAX_GIT_DETAIL_CHARS = 2000;

/** The last lines of Git's stderr, without control characters, for a failure's detail. */
export const gitStderrLines = (stderr: string) =>
  Arr.map(
    Arr.filter(
      Arr.map(Str.split(stderr, "\n"), (line) =>
        Str.trimEnd(Fn.pipe(line, Str.replace(/\p{Cc}/gu, " "))),
      ),
      (line) => line !== "",
    ).slice(-MAX_GIT_DETAIL_LINES),
    (line) => Fn.pipe(line, Str.slice(0, MAX_GIT_DETAIL_CHARS)),
  );

// The subcommand, past any leading `-c name=value` overrides and repository selection.
const gitSubcommand = (args: ReadonlyArray<string>) => {
  let index = 0;
  for (;;) {
    if (args[index] === "-c") index += 2;
    else if (Fn.pipe(args[index] ?? "", Str.startsWith("--git-dir="))) index += 1;
    else return args[index] ?? "";
  }
};

export type GitResult = BoundedProcessResult;

interface GitOptions {
  readonly stdin?: Uint8Array;
  /** Extra variables, such as a temporary `GIT_INDEX_FILE` that keeps the real index untouched. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Defaults to two minutes; checkouts of large trees may need longer. */
  readonly timeoutMillis?: number;
}

// Workspaces run in the user's repository with the user's system and global configuration, so
// filters such as Git LFS behave like a normal checkout. Only what could run user code
// unexpectedly, sign, rewrite the repository in the background, or recurse into submodules is
// switched off; repository-local variables never aim a call elsewhere. A split index would write
// a shared index for each temporary index into the user's Git directory.
const HARDENED_CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.splitIndex=false",
  "commit.gpgSign=false",
  "submodule.recurse=false",
  "gc.auto=0",
  "diff.external=",
];

const gitEnvironment = (options: GitOptions | undefined) => ({
  ...Rec.fromEntries(
    Arr.flatMap(Rec.toEntries(process.env), ([key, value]) =>
      value === undefined || isGitLocalEnvironmentKey(key) ? [] : [[key, value] as const],
    ),
  ),
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Pi workspace",
  GIT_AUTHOR_EMAIL: "workspace@invalid",
  GIT_COMMITTER_NAME: "Pi workspace",
  GIT_COMMITTER_EMAIL: "workspace@invalid",
  ...options?.environment,
});

/**
 * Git that never started left nothing behind; any later read failure leaves its detached group
 * unconfirmed, so its artifacts are kept for recovery.
 */
export const gitRunFailure = (error: BoundedProcessError) =>
  error.operation === "spawn"
    ? WorkspaceError.make({
        operation: "git",
        message: "Git couldn't be started.",
        cleanupUnconfirmed: false,
      })
    : WorkspaceError.make({
        operation: "git",
        message: "Git couldn't be run; no automatic retry is safe.",
        cleanupUnconfirmed: true,
      });

/** Runs Git and returns its result whatever its exit status; fails only when Git can't run. */
export const gitResult = (cwd: string, args: ReadonlyArray<string>, options?: GitOptions) =>
  gitInstallation.pipe(
    Effect.flatMap((installation) =>
      runBoundedProcessNode({
        executable: installation.executable,
        args: [
          "--no-pager",
          ...Arr.flatMap(HARDENED_CONFIG, (setting) => ["-c", setting]),
          ...args,
        ],
        cwd,
        environment: gitEnvironment(options),
        ...(options?.stdin && { stdin: options.stdin }),
        stdoutLimitBytes: 48 * 1024 * 1024,
        stderrLimitBytes: 8192,
        timeoutMillis: options?.timeoutMillis ?? 120_000,
        cleanupTimeoutMillis: 2000,
        detached: true,
        sweepProcessTreeOnExit: true,
      }).pipe(Effect.mapError(gitRunFailure)),
    ),
  );

export const gitSucceeded = (result: GitResult) =>
  result.code === 0 && !result.timedOut && !result.overflowed && !result.cleanupUnconfirmed;

/**
 * Says what failed without claiming what happened to workspace artifacts, which the caller
 * decides; only uncertain process cleanup retains them for recovery.
 */
export const gitFailure = (args: ReadonlyArray<string>, result: GitResult) => {
  const command = `git ${gitSubcommand(args)}`;
  const stderr = gitStderrLines(result.stderr);
  const message = result.cleanupUnconfirmed
    ? `A Git process's cleanup is uncertain (${command}); workspace artifacts were retained for recovery.`
    : result.timedOut
      ? `Git timed out (${command}).`
      : result.overflowed
        ? `Git produced more output than a workspace allows (${command}).`
        : `Git failed (${command}).`;
  return WorkspaceError.make({
    operation: "git",
    message,
    ...(stderr.length > 0 && { detail: `Git reported:\n${Arr.join(stderr, "\n")}` }),
    ...(result.cleanupUnconfirmed && { cleanupUnconfirmed: true }),
  });
};

const MAX_LISTED_PATHS = 5;

/** Names up to five paths, then how many more there are. */
export const listedPaths = (paths: ReadonlyArray<string>) =>
  `${Arr.join(
    Arr.map(paths.slice(0, MAX_LISTED_PATHS), (name) => JSON.stringify(name)),
    ", ",
  )}${paths.length > MAX_LISTED_PATHS ? `, and ${paths.length - MAX_LISTED_PATHS} more` : ""}`;

/**
 * The changed paths `git apply --check` reported conflicts for. Git names each in an `error:`
 * line, such as `patch failed: <path>:<line>` or `<path>: already exists in working directory`.
 */
const applyConflictPaths = (stderr: string, changedPaths: ReadonlyArray<string>) => {
  const errors = Arr.filter(Str.split(stderr, "\n"), (line) =>
    Fn.pipe(line, Str.startsWith("error: ")),
  );
  return Arr.filter(changedPaths, (name) =>
    Arr.some(
      errors,
      (line) =>
        Fn.pipe(line, Str.startsWith(`error: ${name}: `)) ||
        Fn.pipe(line, Str.startsWith(`error: patch failed: ${name}:`)),
    ),
  );
};

/** The reviewed patch doesn't apply to the parent's current files. */
export const applyConflict = (result: GitResult, changedPaths: ReadonlyArray<string>) => {
  const paths = applyConflictPaths(result.stderr, changedPaths);
  const stderr = gitStderrLines(result.stderr);
  return WorkspaceError.make({
    operation: "prepare",
    code: "workspace_conflict",
    message:
      paths.length === 1
        ? "The proposal conflicts with a parent file."
        : paths.length > 1
          ? `The proposal conflicts with ${paths.length} parent files.`
          : "The proposal conflicts with the parent's files.",
    detail: Arr.join(
      [
        ...(paths.length > 0 ? [`Conflicting: ${listedPaths(paths)}`] : []),
        ...(stderr.length > 0 ? [`Git reported:\n${Arr.join(stderr, "\n")}`] : []),
        "Nothing was changed, and the preparation tree was removed.",
      ],
      "\n",
    ),
    remedy:
      "reconcile the conflicting parent files and prepare again, or discard this workspace and start a writer from the current checkout.",
  });
};

export const git = (cwd: string, args: ReadonlyArray<string>, options?: GitOptions) =>
  gitResult(cwd, args, options).pipe(
    Effect.flatMap((result) =>
      gitSucceeded(result) ? Effect.succeed(result.stdout) : Effect.fail(gitFailure(args, result)),
    ),
  );

export const gitFields = (cwd: string, args: ReadonlyArray<string>, options?: GitOptions) =>
  git(cwd, args, options).pipe(
    Effect.map((output) => Arr.filter(Str.split(output, "\0"), Boolean)),
  );

// As a bare repository, so a command that would touch a working tree fails instead of treating
// the Git directory as one.
const inRepository = (repository: string, args: ReadonlyArray<string>) => [
  "-c",
  "core.bare=true",
  `--git-dir=${repository}`,
  ...args,
];

/** Runs Git on the repository's common directory alone, never on a working tree. */
export const repositoryGit = (
  repository: string,
  args: ReadonlyArray<string>,
  options?: GitOptions,
) => git(repository, inRepository(repository, args), options);
export const repositoryGitResult = (
  repository: string,
  args: ReadonlyArray<string>,
  options?: GitOptions,
) => gitResult(repository, inRepository(repository, args), options);
export const repositoryGitFields = (
  repository: string,
  args: ReadonlyArray<string>,
  options?: GitOptions,
) =>
  repositoryGit(repository, args, options).pipe(
    Effect.map((output) => Arr.filter(Str.split(output, "\0"), Boolean)),
  );

export const isSharedOrForeign = (stat: { readonly mode: number; readonly uid: number }) =>
  (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid());

export const writeWorkspaceFile = (target: string, bytes: Uint8Array, mode: number) =>
  Effect.acquireUseRelease(
    workspaceIO("write", () => fs.open(target, "wx", mode)),
    (file) =>
      Effect.gen(function* () {
        yield* workspaceIO("write", () => file.writeFile(bytes));
        yield* workspaceIO("write", () => file.chmod(mode));
        yield* workspaceIO("write", () => file.sync());
      }),
    (file) => workspaceIO("close", () => file.close()).pipe(Effect.ignore),
  );

export const oid = (text: string) =>
  /^(?:[a-f0-9]{40}|[a-f0-9]{64})\n?$/u.test(text)
    ? Effect.succeed(Str.trim(text))
    : Effect.fail(workspaceFailure("git", "Unsupported Git object identifier."));

export const checkDirectory = Effect.fn("GitWorktreeProcess.checkDirectory")(function* (
  directory: string,
  allowMissing: boolean = false,
) {
  const absolute = path.resolve(directory);
  const parts = Arr.filter(
    Str.split(Fn.pipe(absolute, Str.slice(path.parse(absolute).root.length)), path.sep),
    Boolean,
  );
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = yield* (allowMissing ? workspaceIOIfPresent : workspaceIO)("path", () =>
      fs.lstat(current),
    );
    if (!stat) return absolute;
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return yield* workspaceRefusal(
        "path",
        "Symlink or non-directory path component is unsupported.",
        {
          path: current,
          rule: "every directory leading to a workspace file must be a real directory, never a symlink or file",
          remedy:
            "Replace the symlink or file with a real directory, or use the shared-checkout writer workspace.",
        },
      );
  }
  return absolute;
});
