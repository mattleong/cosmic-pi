import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  clipText,
  runBoundedProcessNode,
  sanitizeDiagnosticContent,
  stripTerminalControls,
} from "pi-cosmic-core";
import {
  DEFAULT_WORKTREE_HOOK_TIMEOUT_SECONDS,
  type WorktreeHook,
  type WorktreeHookEvent,
} from "../config/schema.ts";
import { isGitLocalEnvironmentKey } from "./git-local-environment.ts";

export class WorktreeHookError extends Schema.TaggedError<WorktreeHookError>()(
  "WorktreeHookError",
  { message: Schema.String },
) {}

/** The JSON object a hook reads on stdin. */
export interface WorktreeHookInput {
  readonly event: WorktreeHookEvent;
  readonly workspaceId: string;
  /** The root of the tree the hook runs in, which is also its cwd. */
  readonly worktreePath: string;
  readonly sourceCwd: string;
  readonly kind: "worker" | "prepare";
  readonly runId?: string | undefined;
}

interface WorktreeHookOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

// Generous bounds: installers can be verbose, and overflowing kills the hook.
const STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 2 * 1024 * 1024;
const CLEANUP_TIMEOUT_MILLIS = 5_000;
const MESSAGE_LINE_CHARS = 400;
// Redaction runs on a window far wider than the reported line, so a credential cut at the
// window's start lies outside it.
const REDACTION_WINDOW_CHARS = 16_000;

const hookEnvironment = (source: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => value !== undefined && !isGitLocalEnvironmentKey(key),
    ),
  );

const lastLine = (stdout: string, stderr: string) => {
  const text = stderr.trim() || stdout.trim();
  const recent = sanitizeDiagnosticContent(
    stripTerminalControls(text.slice(-REDACTION_WINDOW_CHARS)),
    { maximumLength: Number.POSITIVE_INFINITY },
  );
  return (recent.split("\n").findLast((line) => line.trim()) ?? "")
    .trim()
    .slice(-MESSAGE_LINE_CHARS);
};

export const describeWorktreeHook = (hook: { readonly command: ReadonlyArray<string> }) =>
  clipText(hook.command.join(" "), 80);

const stdinPayload = (input: WorktreeHookInput) =>
  new TextEncoder().encode(
    `${JSON.stringify({
      event: input.event,
      workspaceId: input.workspaceId,
      worktreePath: input.worktreePath,
      sourceCwd: input.sourceCwd,
      kind: input.kind,
      ...(input.runId !== undefined && { runId: input.runId }),
    })}\n`,
  );

/**
 * Runs one configured hook at `input.worktreePath` without a shell, in its own process group with
 * the user's environment minus Git variables that would redirect it to the parent repository, and
 * the event's JSON object on stdin. A timeout or interruption kills the whole group, SIGTERM then
 * SIGKILL. A group that can't be confirmed stopped is a logged warning naming the workspace and
 * changes no outcome: a hook that exited 0 still succeeds.
 */
export const runWorktreeHook = (
  hook: WorktreeHook,
  input: WorktreeHookInput,
  options: WorktreeHookOptions = {},
): Effect.Effect<void, WorktreeHookError> => {
  const [executable, ...args] = hook.command;
  const label = `${input.event} hook \`${describeWorktreeHook(hook)}\``;
  if (executable === undefined)
    return Effect.fail(new WorktreeHookError({ message: `${input.event} hook has no command.` }));
  const timeoutSeconds = hook.timeout ?? DEFAULT_WORKTREE_HOOK_TIMEOUT_SECONDS[input.event];
  const cleanupWarning = Effect.logWarning(
    `${label}'s process group couldn't be confirmed stopped.`,
  ).pipe(
    Effect.annotateLogs({
      workspaceId: input.workspaceId,
      tree: input.worktreePath,
      ...(input.runId !== undefined && { runId: input.runId }),
    }),
  );
  return runBoundedProcessNode({
    executable,
    args,
    cwd: input.worktreePath,
    environment: hookEnvironment(options.environment ?? process.env),
    stdin: stdinPayload(input),
    stdoutLimitBytes: STDOUT_LIMIT_BYTES,
    stderrLimitBytes: STDERR_LIMIT_BYTES,
    timeoutMillis: timeoutSeconds * 1000,
    cleanupTimeoutMillis: CLEANUP_TIMEOUT_MILLIS,
    detached: true,
    sweepProcessTreeOnExit: true,
  }).pipe(
    Effect.catch((error) => {
      // A hook that never started left nothing behind; any other read failure leaves its group
      // unconfirmed.
      if (error.operation === "spawn")
        return Effect.fail(
          new WorktreeHookError({
            message: `${label} couldn't start; check that the command exists on PATH.`,
          }),
        );
      return cleanupWarning.pipe(
        Effect.andThen(
          Effect.fail(
            new WorktreeHookError({ message: `${label} couldn't be read to completion.` }),
          ),
        ),
      );
    }),
    Effect.flatMap((result) => {
      const warned = result.cleanupUnconfirmed ? cleanupWarning : Effect.void;
      if (result.code === 0 && !result.timedOut && !result.overflowed) return warned;
      const reason = result.timedOut
        ? `timed out after ${timeoutSeconds}s`
        : result.overflowed
          ? "produced too much output"
          : `exited with ${result.code === null ? `signal ${result.signal ?? "unknown"}` : `code ${result.code}`}`;
      const line = lastLine(result.stdout, result.stderr);
      return warned.pipe(
        Effect.andThen(
          Effect.fail(
            new WorktreeHookError({ message: `${label} ${reason}${line ? `: ${line}` : "."}` }),
          ),
        ),
      );
    }),
  );
};
