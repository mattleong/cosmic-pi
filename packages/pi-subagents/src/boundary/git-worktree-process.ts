import * as Effect from "effect/Effect";
import { runBoundedProcessNode } from "pi-cosmic-core";
import { WorkspaceError } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";

export const workspaceFailure = (operation: string, message: string) =>
  new WorkspaceError({ operation, message });
export const workspaceIO = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () =>
      workspaceFailure(
        operation,
        "Workspace filesystem operation failed; retained artifacts may require recovery.",
      ),
  });
/** Like workspaceIO, but a missing path (ENOENT) yields undefined. */
export const workspaceIOIfPresent = <A>(operation: string, run: () => Promise<A>) =>
  workspaceIO(operation, () =>
    run().catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }),
  );

// Deliberately construct, never spread, the environment. No inherited Git selectors,
// config, pager, credentials, alternate object directories, hooks or shell helpers.
export const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: Uint8Array;
    readonly index?: string;
  },
) =>
  runBoundedProcessNode({
    executable: "/usr/bin/git",
    args: [
      "--no-pager",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "diff.external=",
      "-c",
      "protocol.allow=never",
      "-c",
      "core.fsync=all",
      "-c",
      "core.fsyncMethod=fsync",
      ...args,
    ],
    cwd,
    environment: {
      GIT_INDEX_FILE: options?.index,
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Pi workspace",
      GIT_AUTHOR_EMAIL: "workspace@invalid",
      GIT_COMMITTER_NAME: "Pi workspace",
      GIT_COMMITTER_EMAIL: "workspace@invalid",
    },
    ...(options?.stdin && { stdin: options.stdin }),
    stdoutLimitBytes: 48 * 1024 * 1024,
    stderrLimitBytes: 8192,
    timeoutMillis: 30_000,
    cleanupTimeoutMillis: 2000,
    detached: true,
    sweepProcessTreeOnExit: true,
  }).pipe(
    Effect.mapError(
      () =>
        new WorkspaceError({
          operation: "git",
          message: "Git execution failed; no automatic retry is safe.",
          cleanupUnconfirmed: true,
        }),
    ),
    Effect.flatMap((result) =>
      result.code === 0 && !result.timedOut && !result.overflowed && !result.cleanupUnconfirmed
        ? Effect.succeed(result.stdout)
        : Effect.fail(
            new WorkspaceError({
              operation: "git",
              message: "Git operation failed or cleanup is uncertain; artifacts were retained.",
              cleanupUnconfirmed: result.cleanupUnconfirmed,
            }),
          ),
    ),
  );

/** The NUL-separated fields of a `-z` Git listing, without the empty trailing one. */
export const gitFields = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(Effect.map((output) => output.split("\0").filter(Boolean)));

/** A registry directory that another user owns, or that group or others can reach. */
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
  /^[a-f0-9]{40}\n?$/u.test(text)
    ? Effect.succeed(text.trim())
    : Effect.fail(workspaceFailure("git", "Unsupported Git object identifier."));

/** Reject every symlink component, even one that resolves inside the same root. */
export const checkDirectory = (directory: string, allowMissing = false) =>
  Effect.gen(function* () {
    const absolute = path.resolve(directory);
    const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
    let current = path.parse(absolute).root;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = yield* (allowMissing ? workspaceIOIfPresent : workspaceIO)("path", () =>
        fs.lstat(current),
      );
      if (!stat) return absolute;
      if (!stat.isDirectory() || stat.isSymbolicLink())
        return yield* workspaceFailure(
          "path",
          "Symlink or non-directory path component is unsupported.",
        );
    }
    return absolute;
  });
