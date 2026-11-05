import * as Effect from "effect/Effect";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Match from "effect/Match";
import { hasControlCharacter } from "pi-cosmic-core/security";
import { runBoundedProcessNode } from "pi-cosmic-core/platform/process";
import {
  nodeFsConstants,
  nodeFsPromises as fs,
  nodePath as path,
} from "pi-cosmic-core/platform/node-builtins";
import { WorkspaceError } from "../workspace/model.ts";
import { withoutGitLocalEnvironment } from "./git-local-environment.ts";
import { homeDisplayPath } from "../ui/display-path.ts";

/** Oldest Git with every option isolated workspaces use (`rev-parse --path-format`). */
export const MINIMUM_GIT_VERSION = [2, 31] as const;

interface GitInstallation {
  readonly executable: string;
  readonly version: string;
}

/** The Git a check found, or why it found none it can use. */
export type GitInstallationProbe =
  | { readonly kind: "found"; readonly installation: GitInstallation }
  | { readonly kind: "missing" }
  | { readonly kind: "unversioned"; readonly executable: string };

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
): Effect.fn.Return<string | undefined> {
  const searched = [
    PREFERRED_GIT,
    ...Arr.map(
      Arr.filter(Str.split(environment.PATH ?? "", path.delimiter), usablePath),
      (directory) => path.join(directory, "git"),
    ),
  ];
  for (const candidate of new Set(searched)) if (yield* executableFile(candidate)) return candidate;
  return undefined;
});

const runGit = (executable: string, args: ReadonlyArray<string>, environment: NodeJS.ProcessEnv) =>
  runBoundedProcessNode({
    executable,
    args,
    environment: withoutGitLocalEnvironment(environment),
    stdoutLimitBytes: 8192,
    stderrLimitBytes: 8192,
    timeoutMillis: 10_000,
    cleanupTimeoutMillis: 2000,
    detached: true,
    sweepProcessTreeOnExit: true,
  });

const VERSION = /^git version (\d+)\.(\d+)(?:\.(\d+))?/u;

export const gitVersionSupported = (version: string): boolean => {
  const [major, minor = 0] = Arr.map(Str.split(version, "."), Number);
  const [requiredMajor, requiredMinor] = MINIMUM_GIT_VERSION;
  return major > requiredMajor || (major === requiredMajor && minor >= requiredMinor);
};

const probeGitInstallation = Effect.fn("GitInstallation.probeGitInstallation")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<GitInstallationProbe> {
  const executable = yield* locateGit(environment);
  if (executable === undefined) return { kind: "missing" };
  const output = yield* runGit(executable, ["--version"], environment).pipe(
    Effect.map((result) => (result.code === 0 ? result.stdout : "")),
    Effect.orElseSucceed(() => ""),
  );
  const match = VERSION.exec(output);
  if (!match) return { kind: "unversioned", executable };
  return {
    kind: "found",
    installation: { executable, version: Arr.join(Arr.filter(match.slice(1), Boolean), ".") },
  };
});

let resolved: GitInstallation | undefined;

/** Found once per process; a probe that found no usable Git is retried on the next use. */
export const gitInstallationProbe: Effect.Effect<GitInstallationProbe> = Effect.suspend(() =>
  resolved
    ? Effect.succeed({ kind: "found", installation: resolved } as const)
    : probeGitInstallation(process.env).pipe(
        Effect.tap((probe) =>
          Effect.sync(() => {
            if (probe.kind === "found") resolved = probe.installation;
          }),
        ),
      ),
);

export const gitInstallation: Effect.Effect<GitInstallation, WorkspaceError> =
  gitInstallationProbe.pipe(
    Effect.flatMap((probe) =>
      Match.value(probe).pipe(
        Match.when({ kind: "found" }, ({ installation }) => Effect.succeed(installation)),
        Match.when({ kind: "missing" }, () =>
          Effect.fail(
            unavailable(
              "Git isn't installed, so isolated writer workspaces are unavailable.",
              `Searched ${PREFERRED_GIT} and every absolute directory on PATH. Install Git ${Arr.join(Arr.map(MINIMUM_GIT_VERSION, String), ".")} or later, or use the shared-checkout writer workspace.`,
            ),
          ),
        ),
        Match.when({ kind: "unversioned" }, ({ executable }) =>
          Effect.fail(
            unavailable(
              "Git didn't report its version, so isolated writer workspaces are unavailable.",
              `Executable: ${homeDisplayPath(executable)}`,
            ),
          ),
        ),
        Match.exhaustive,
      ),
    ),
  );

export const supportedGitInstallation = gitInstallation.pipe(
  Effect.filterOrFail(
    (installation) => gitVersionSupported(installation.version),
    (installation) =>
      unavailable(
        `Git ${installation.version} is too old for isolated writer workspaces.`,
        `Executable: ${homeDisplayPath(installation.executable)}\nIsolated writers need Git ${Arr.join(Arr.map(MINIMUM_GIT_VERSION, String), ".")} or later. Upgrade Git, or use the shared-checkout writer workspace.`,
      ),
  ),
);
