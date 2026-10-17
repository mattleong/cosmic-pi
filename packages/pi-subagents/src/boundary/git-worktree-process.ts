import * as Effect from "effect/Effect";
import { runBoundedProcessNode } from "pi-cosmic-core";
import { WorkspaceError } from "../workspace/model.ts";
import { gitInstallation } from "./git-installation.ts";
import { nodeErrorCode } from "./harness-shared.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";

export const workspaceFailure = (operation: string, message: string) =>
  new WorkspaceError({ operation, message });

export interface WorkspaceRefusalReason {
  /** Relative to the tree being captured, when one file caused the refusal. */
  readonly path?: string;
  readonly rule: string;
  readonly remedy: string;
}

/** A refusal whose detail names the path, the rule that fired, and how to resolve it. */
export const workspaceRefusal = (
  operation: string,
  message: string,
  reason: WorkspaceRefusalReason,
) =>
  new WorkspaceError({
    operation,
    message,
    detail: [
      ...(reason.path === undefined ? [] : [`Path: ${JSON.stringify(reason.path)}`]),
      `Rule: ${reason.rule}`,
      `Remedy: ${reason.remedy}`,
    ].join("\n"),
  });
export const workspaceIO = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () =>
      workspaceFailure(
        operation,
        "Workspace filesystem operation failed; retained artifacts may require recovery.",
      ),
  });
export const workspaceIOIfPresent = <A>(operation: string, run: () => Promise<A>) =>
  workspaceIO(operation, () =>
    run().catch((cause: unknown) => {
      if (nodeErrorCode(cause) === "ENOENT") return undefined;
      throw cause;
    }),
  );

export const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: { readonly stdin?: Uint8Array },
) =>
  gitInstallation.pipe(
    Effect.flatMap((installation) =>
      runBoundedProcessNode({
        executable: installation.executable,
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
          PATH: [...new Set([path.dirname(installation.executable), "/usr/bin", "/bin"])].join(
            path.delimiter,
          ),
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
      ),
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

export const gitFields = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(Effect.map((output) => output.split("\0").filter(Boolean)));

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
    ? Effect.succeed(text.trim())
    : Effect.fail(workspaceFailure("git", "Unsupported Git object identifier."));

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
