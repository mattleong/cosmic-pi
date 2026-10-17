import * as Effect from "effect/Effect";
import { hasControlCharacter, runBoundedProcessNode } from "pi-cosmic-core";
import { WorkspaceError } from "../workspace/model.ts";
import { isGitLocalEnvironmentKey } from "./git-local-environment.ts";
import { nodeFsConstants, nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";

/** Oldest Git with every option isolated workspaces use (`rev-parse --path-format`). */
export const MINIMUM_GIT_VERSION = [2, 31] as const;

export interface GitInstallation {
  readonly executable: string;
  readonly version: string;
}

const PREFERRED_GIT = "/usr/bin/git";

const unavailable = (message: string, detail?: string) =>
  new WorkspaceError({ operation: "git", message, ...(detail !== undefined && { detail }) });

const usablePath = (value: string | undefined): value is string =>
  value !== undefined &&
  path.isAbsolute(value) &&
  value.length <= 4096 &&
  !hasControlCharacter(value);

const executableFile = (candidate: string) =>
  Effect.promise(() =>
    fs
      .access(candidate, nodeFsConstants.X_OK)
      .then(() => fs.stat(candidate))
      .then(
        (stat) => stat.isFile(),
        () => false,
      ),
  );

// Prefer the system Git, then the first absolute `git` on the user's PATH (NixOS has no /usr/bin/git).
const locateGit = (environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const searched = [
      PREFERRED_GIT,
      ...(environment.PATH ?? "")
        .split(path.delimiter)
        .filter((directory) => usablePath(directory))
        .map((directory) => path.join(directory, "git")),
    ];
    for (const candidate of new Set(searched))
      if (yield* executableFile(candidate)) return candidate;
    return yield* unavailable(
      "Git isn't installed, so isolated writer workspaces are unavailable.",
      `Searched ${PREFERRED_GIT} and every absolute directory on PATH. Install Git ${MINIMUM_GIT_VERSION.join(".")} or later, or use the shared-checkout writer workspace.`,
    );
  });

const userEnvironment = (environment: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => value !== undefined && !isGitLocalEnvironmentKey(key),
    ),
  );

const runGit = (
  executable: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) =>
  runBoundedProcessNode({
    executable,
    args,
    environment: userEnvironment(environment),
    ...(cwd !== undefined && { cwd }),
    stdoutLimitBytes: 8192,
    stderrLimitBytes: 8192,
    timeoutMillis: 10_000,
    cleanupTimeoutMillis: 2000,
    detached: true,
    sweepProcessTreeOnExit: true,
  });

const VERSION = /^git version (\d+)\.(\d+)(?:\.(\d+))?/u;

export const gitVersionSupported = (version: string): boolean => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [requiredMajor, requiredMinor] = MINIMUM_GIT_VERSION;
  return major > requiredMajor || (major === requiredMajor && minor >= requiredMinor);
};

// Git's own resolution: core.excludesFile from the user's configuration (following include and
// includeIf, and with `repository` the repository's own config, which outranks the global one),
// else $XDG_CONFIG_HOME/git/ignore, else ~/.config/git/ignore.
const userExcludesFile = (
  executable: string,
  environment: NodeJS.ProcessEnv,
  repository?: string,
) =>
  Effect.gen(function* () {
    const refusal = () =>
      unavailable(
        "Git's ignore configuration couldn't be preserved.",
        `Check core.excludesFile in your ${repository === undefined ? "global" : "global and repository"} Git configuration, then retry. Isolated workspaces must retain your ignore rules before copying untracked files.`,
      );
    const result = yield* runGit(
      executable,
      [
        "config",
        ...(repository === undefined ? ["--global"] : []),
        "--includes",
        "--path",
        "--get",
        "core.excludesFile",
      ],
      environment,
      repository,
    ).pipe(Effect.mapError(refusal));
    if (result.timedOut || result.overflowed || result.cleanupUnconfirmed) return yield* refusal();
    if (result.code === 0) {
      const configured = result.stdout.replace(/\n$/u, "");
      if (configured.length > 4096 || hasControlCharacter(configured)) return yield* refusal();
      // Git resolves relative excludes paths from the repository, not the config file or Pi's
      // cwd. Preserve that context by passing the value unchanged to each isolated Git call.
      // An explicitly empty value also overrides Git's default ignore file.
      return configured;
    }
    if (result.code !== 1) return yield* refusal();
    const xdg = environment.XDG_CONFIG_HOME;
    if (usablePath(xdg)) return path.join(xdg, "git", "ignore");
    const home = environment.HOME;
    return usablePath(home) ? path.join(home, ".config", "git", "ignore") : undefined;
  });

export const resolveGitInstallation = (
  environment: NodeJS.ProcessEnv,
): Effect.Effect<GitInstallation, WorkspaceError> =>
  Effect.gen(function* () {
    const executable = yield* locateGit(environment);
    const output = yield* runGit(executable, ["--version"], environment).pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout : "")),
      Effect.orElseSucceed(() => ""),
    );
    const match = VERSION.exec(output);
    if (!match)
      return yield* unavailable(
        "Git didn't report its version, so isolated writer workspaces are unavailable.",
        `Executable: ${executable}`,
      );
    const version = match.slice(1).filter(Boolean).join(".");
    // Each capture resolves its repository's excludes file; checking the global configuration
    // here reports a broken one before any workspace exists.
    yield* userExcludesFile(executable, environment);
    return { executable, version };
  });

let resolved: GitInstallation | undefined;

/** Resolved once per process; a failed resolution is retried on the next use. */
export const gitInstallation: Effect.Effect<GitInstallation, WorkspaceError> = Effect.suspend(() =>
  resolved
    ? Effect.succeed(resolved)
    : resolveGitInstallation(process.env).pipe(
        Effect.tap((installation) =>
          Effect.sync(() => {
            resolved = installation;
          }),
        ),
      ),
);

/**
 * The excludes file Git applies in `repository` for this user: its own core.excludesFile
 * outranks the global one, and includeIf conditions are evaluated against it.
 */
export const repositoryExcludesFile = (
  repository: string,
): Effect.Effect<string | undefined, WorkspaceError> =>
  gitInstallation.pipe(
    Effect.flatMap((installation) =>
      userExcludesFile(installation.executable, process.env, repository),
    ),
  );

export const supportedGitInstallation = gitInstallation.pipe(
  Effect.filterOrFail(
    (installation) => gitVersionSupported(installation.version),
    (installation) =>
      unavailable(
        `Git ${installation.version} is too old for isolated writer workspaces.`,
        `Executable: ${installation.executable}\nIsolated writers need Git ${MINIMUM_GIT_VERSION.join(".")} or later. Upgrade Git, or use the shared-checkout writer workspace.`,
      ),
  ),
);
