import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { clipText, runBoundedProcessNode, sanitizeDiagnosticContent } from "pi-cosmic-core";
import { DEFAULT_WORKSPACE_SETUP_TIMEOUT_SECONDS, type WorkspaceSetup } from "../config/schema.ts";
import { isGitLocalEnvironmentKey } from "./git-local-environment.ts";

export class WorkspaceSetupError extends Schema.TaggedError<WorkspaceSetupError>()(
  "WorkspaceSetupError",
  {
    message: Schema.String,
    cleanupUnconfirmed: Schema.optional(Schema.Boolean),
  },
) {}

// Generous bounds: installers can be verbose, and overflowing kills the command.
const STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 2 * 1024 * 1024;
const CLEANUP_TIMEOUT_MILLIS = 5_000;
const DIAGNOSTIC_CHARS = 400;

const setupEnvironment = (source: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => value !== undefined && !isGitLocalEnvironmentKey(key),
    ),
  );

const outputTail = (stdout: string, stderr: string): string => {
  const text = sanitizeDiagnosticContent(stderr.trim() || stdout.trim()).trim();
  const tail = text.length > DIAGNOSTIC_CHARS ? text.slice(-DIAGNOSTIC_CHARS) : text;
  return tail.split("\n").findLast(Boolean) ?? "";
};

export const describeWorkspaceSetup = (setup: WorkspaceSetup): string =>
  clipText(setup.command.join(" "), 80);

/**
 * Runs a trusted project's setup command in its own process group with the user's environment,
 * minus Git variables that would redirect it to the parent repository.
 */
export const runWorkspaceSetup = (
  setup: WorkspaceSetup,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<void, WorkspaceSetupError> => {
  const [executable, ...args] = setup.command;
  const command = describeWorkspaceSetup(setup);
  if (executable === undefined)
    return Effect.fail(new WorkspaceSetupError({ message: "Workspace setup has no command." }));
  const timeoutSeconds = setup.timeoutSeconds ?? DEFAULT_WORKSPACE_SETUP_TIMEOUT_SECONDS;
  return runBoundedProcessNode({
    executable,
    args,
    cwd,
    environment: setupEnvironment(environment),
    stdoutLimitBytes: STDOUT_LIMIT_BYTES,
    stderrLimitBytes: STDERR_LIMIT_BYTES,
    timeoutMillis: timeoutSeconds * 1000,
    cleanupTimeoutMillis: CLEANUP_TIMEOUT_MILLIS,
    detached: true,
    sweepProcessTreeOnExit: true,
  }).pipe(
    Effect.mapError(
      () =>
        new WorkspaceSetupError({
          message: `Workspace setup \`${command}\` couldn't start.`,
          cleanupUnconfirmed: true,
        }),
    ),
    Effect.flatMap((result) => {
      if (result.code === 0 && !result.timedOut && !result.overflowed && !result.cleanupUnconfirmed)
        return Effect.void;
      const reason = result.timedOut
        ? `timed out after ${timeoutSeconds}s`
        : result.overflowed
          ? "produced too much output"
          : result.cleanupUnconfirmed
            ? "left processes that couldn't be confirmed stopped"
            : `exited with ${result.code === null ? `signal ${result.signal ?? "unknown"}` : `code ${result.code}`}`;
      const tail = outputTail(result.stdout, result.stderr);
      return Effect.fail(
        new WorkspaceSetupError({
          message: `Workspace setup \`${command}\` ${reason}${tail ? `: ${tail}` : "."}`,
          cleanupUnconfirmed: result.cleanupUnconfirmed,
        }),
      );
    }),
  );
};
