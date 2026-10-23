import * as Effect from "effect/Effect";
import {
  hasControlCharacter,
  runBoundedProcessNode,
  nodeFsConstants,
  nodeFsPromises as fs,
  nodePath as path,
} from "pi-cosmic-core";
import { WorkspaceError } from "../workspace/model.ts";
import { isGitLocalEnvironmentKey } from "./git-local-environment.ts";

/** Oldest Git with every option isolated workspaces use (`rev-parse --path-format`). */
export const MINIMUM_GIT_VERSION = [2, 31] as const;

interface GitInstallation {
  readonly executable: string;
  readonly version: string;
}

const PREFERRED_GIT = "/usr/bin/git";

const unavailable = (message: string, detail?: string) =>
  WorkspaceError.make({ operation: "git", message, ...(detail !== undefined && { detail }) });

const usablePath = (value: string): boolean =>
  path.isAbsolute(value) && value.length <= 4096 && !hasControlCharacter(value);

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
const locateGit = Effect.fn("GitInstallation.locateGit")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const searched = [
    PREFERRED_GIT,
    ...(environment.PATH ?? "")
      .split(path.delimiter)
      .filter(usablePath)
      .map((directory) => path.join(directory, "git")),
  ];
  for (const candidate of new Set(searched)) if (yield* executableFile(candidate)) return candidate;
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

const runGit = (executable: string, args: ReadonlyArray<string>, environment: NodeJS.ProcessEnv) =>
  runBoundedProcessNode({
    executable,
    args,
    environment: userEnvironment(environment),
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

const resolveGitInstallation = Effect.fn("GitInstallation.resolveGitInstallation")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<GitInstallation, WorkspaceError> {
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
  return { executable, version: match.slice(1).filter(Boolean).join(".") };
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
