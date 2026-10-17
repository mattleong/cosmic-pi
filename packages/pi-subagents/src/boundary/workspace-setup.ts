import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  clipText,
  runBoundedProcessNode,
  sanitizeDiagnosticContent,
  stripTerminalControls,
} from "pi-cosmic-core";
import {
  DEFAULT_WORKSPACE_SETUP_TIMEOUT_SECONDS,
  DEFAULT_WORKSPACE_VERIFY_TIMEOUT_SECONDS,
} from "../config/schema.ts";
import type { WorkspaceTreeCommand } from "../workspace/model.ts";
import { isGitLocalEnvironmentKey } from "./git-local-environment.ts";

export class WorkspaceCommandError extends Schema.TaggedError<WorkspaceCommandError>()(
  "WorkspaceCommandError",
  {
    message: Schema.String,
    /** The end of the command's output, stdout followed by stderr. */
    outputTail: Schema.optional(Schema.String),
    cleanupUnconfirmed: Schema.optional(Schema.Boolean),
  },
) {}

export interface WorkspaceCommandOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** Reports whether the process group was confirmed stopped, including after interruption. */
  readonly onCleanup?: (confirmed: boolean) => void;
}

// Generous bounds: installers and test runners can be verbose, and overflowing kills the command.
const STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 2 * 1024 * 1024;
const CLEANUP_TIMEOUT_MILLIS = 5_000;
const MESSAGE_LINE_CHARS = 400;
const TAIL_LINES = 40;
const TAIL_CHARS = 4_000;

const commandEnvironment = (source: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => value !== undefined && !isGitLocalEnvironmentKey(key),
    ),
  );

// Redaction runs on a window four times the tail, so a credential cut at the window's start lies
// far outside the retained tail.
const tailOf = (text: string): string => {
  const recent = sanitizeDiagnosticContent(stripTerminalControls(text.slice(-4 * TAIL_CHARS)), {
    maximumLength: Number.POSITIVE_INFINITY,
  }).trimEnd();
  const lines = recent.split("\n").slice(-TAIL_LINES).join("\n");
  return lines.length > TAIL_CHARS ? lines.slice(-TAIL_CHARS) : lines;
};

const combinedTail = (stdout: string, stderr: string) =>
  tailOf([stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n"));

const lastLine = (stdout: string, stderr: string) =>
  (
    tailOf(stderr.trim() || stdout.trim())
      .split("\n")
      .findLast(Boolean) ?? ""
  )
    .trim()
    .slice(-MESSAGE_LINE_CHARS);

export const describeWorkspaceSetup = (setup: { readonly command: ReadonlyArray<string> }) =>
  clipText(setup.command.join(" "), 80);

/**
 * Runs a trusted project's command at a tree's root without a shell, in its own process group with
 * the user's environment, minus Git variables that would redirect it to the parent repository.
 */
const runTreeCommand = (
  purpose: "setup" | "verification",
  tree: WorkspaceTreeCommand,
  cwd: string,
  options: WorkspaceCommandOptions,
): Effect.Effect<{ readonly outputTail: string }, WorkspaceCommandError> => {
  const [executable, ...args] = tree.command;
  const command = describeWorkspaceSetup(tree);
  if (executable === undefined)
    return Effect.fail(
      new WorkspaceCommandError({ message: `Workspace ${purpose} has no command.` }),
    );
  const timeoutSeconds =
    tree.timeoutSeconds ??
    (purpose === "setup"
      ? DEFAULT_WORKSPACE_SETUP_TIMEOUT_SECONDS
      : DEFAULT_WORKSPACE_VERIFY_TIMEOUT_SECONDS);
  return runBoundedProcessNode({
    executable,
    args,
    cwd,
    environment: commandEnvironment(options.environment ?? process.env),
    stdoutLimitBytes: STDOUT_LIMIT_BYTES,
    stderrLimitBytes: STDERR_LIMIT_BYTES,
    timeoutMillis: timeoutSeconds * 1000,
    cleanupTimeoutMillis: CLEANUP_TIMEOUT_MILLIS,
    detached: true,
    sweepProcessTreeOnExit: true,
    ...(options.onCleanup !== undefined && { onCleanup: options.onCleanup }),
  }).pipe(
    Effect.mapError((error) => {
      // A command that never spawned left no process behind, so its cleanup is confirmed; this
      // report follows the runner's own, which can't tell that case apart.
      const neverStarted = error.operation === "spawn";
      if (neverStarted) options.onCleanup?.(true);
      return new WorkspaceCommandError({
        message: neverStarted
          ? `Workspace ${purpose} \`${command}\` couldn't start; check that the command exists on PATH.`
          : `Workspace ${purpose} \`${command}\` couldn't be read to completion.`,
        cleanupUnconfirmed: !neverStarted,
      });
    }),
    Effect.flatMap((result) => {
      const outputTail = combinedTail(result.stdout, result.stderr);
      if (result.code === 0 && !result.timedOut && !result.overflowed && !result.cleanupUnconfirmed)
        return Effect.succeed({ outputTail });
      const reason = result.timedOut
        ? `timed out after ${timeoutSeconds}s`
        : result.overflowed
          ? "produced too much output"
          : result.cleanupUnconfirmed
            ? "left processes that couldn't be confirmed stopped"
            : `exited with ${result.code === null ? `signal ${result.signal ?? "unknown"}` : `code ${result.code}`}`;
      const line = lastLine(result.stdout, result.stderr);
      return Effect.fail(
        new WorkspaceCommandError({
          message: `Workspace ${purpose} \`${command}\` ${reason}${line ? `: ${line}` : "."}`,
          outputTail,
          cleanupUnconfirmed: result.cleanupUnconfirmed,
        }),
      );
    }),
  );
};

/** Installs dependencies in a new worker tree or a prepared test tree. */
export const runWorkspaceSetup = (
  setup: WorkspaceTreeCommand,
  cwd: string,
  options: WorkspaceCommandOptions = {},
): Effect.Effect<void, WorkspaceCommandError> =>
  runTreeCommand("setup", setup, cwd, options).pipe(Effect.asVoid);

/** Checks a prepared test tree, returning the end of the command's output. */
export const runWorkspaceVerification = (
  verification: WorkspaceTreeCommand,
  cwd: string,
  options: WorkspaceCommandOptions = {},
): Effect.Effect<{ readonly outputTail: string }, WorkspaceCommandError> =>
  runTreeCommand("verification", verification, cwd, options);
