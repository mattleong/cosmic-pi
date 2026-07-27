// Claude CLI ownership is intentionally isolated at this Node boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { SubagentProcessError } from "../run/errors.ts";
import { sanitizeDiagnosticText } from "../run/state.ts";

const PREFLIGHT_TIMEOUT_MILLIS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DETAIL_CHARS = 2 * 1024;

/** Tolerant `claude auth status --json` shape; unknown fields are ignored on purpose. */
const AuthStatusSchema = Schema.Struct({
  loggedIn: Schema.optional(Schema.Boolean),
  authenticated: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.String),
});

const NEGATIVE_STATUS =
  /not[_ ]?(logged[_ ]?in|authenticated)|logged[_ ]?out|unauthenticated|expired/i;

export interface ClaudeCliPreflightOptions {
  readonly command?: string | undefined;
  readonly commandArgs?: ReadonlyArray<string> | undefined;
  readonly timeoutMillis?: number | undefined;
}

interface PreflightProbe {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const preflightError = (code: string, message: string) =>
  new SubagentProcessError({ operation: "preflight", message, code });

const verifiedCommands = new Set<string>();

export const resetClaudeCliPreflightCache = (): void => {
  verifiedCommands.clear();
};

const parseJsonObject = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
};

const probeAuthStatus = (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMillis: number,
): Effect.Effect<PreflightProbe, SubagentProcessError> =>
  Effect.callback<PreflightProbe, SubagentProcessError>((resume) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, [...args, "auth", "status", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const settle = (outcome: Effect.Effect<PreflightProbe, SubagentProcessError>) => {
      if (settled) return;
      settled = true;
      resume(outcome);
    };
    const collect = (current: string, chunk: Buffer): string => {
      const next = `${current}${chunk.toString("utf8")}`;
      return Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES
        ? Buffer.from(next, "utf8").subarray(-MAX_OUTPUT_BYTES).toString("utf8")
        : next;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      settle(
        Effect.fail(
          error.code === "ENOENT"
            ? preflightError(
                "claude_cli_not_found",
                `Claude CLI executable was not found (${command}). Install Claude Code or fix PATH before launching claude-cli subagents.`,
              )
            : preflightError(
                "claude_cli_preflight_failed",
                `Claude CLI preflight failed to start: ${error.message}`,
              ),
        ),
      );
    });
    child.once("close", (exitCode) => settle(Effect.succeed({ exitCode, stdout, stderr })));
    return Effect.sync(() => {
      if (!settled) child.kill("SIGKILL");
    });
  }).pipe(
    Effect.timeoutOption(timeoutMillis),
    Effect.flatMap((outcome) =>
      outcome._tag === "Some"
        ? Effect.succeed(outcome.value)
        : Effect.fail(
            preflightError(
              "claude_cli_preflight_failed",
              `Claude CLI preflight (auth status) did not answer within ${timeoutMillis} ms.`,
            ),
          ),
    ),
  );

const authenticationFailure = (probe: PreflightProbe): SubagentProcessError | undefined => {
  const decoded = Schema.decodeUnknownOption(AuthStatusSchema)(parseJsonObject(probe.stdout));
  const explicitlyUnauthenticated =
    Option.isSome(decoded) &&
    (decoded.value.loggedIn === false ||
      decoded.value.authenticated === false ||
      (decoded.value.status !== undefined && NEGATIVE_STATUS.test(decoded.value.status)));
  if (probe.exitCode === 0 && !explicitlyUnauthenticated) return undefined;
  const detail = sanitizeDiagnosticText(
    `${probe.stdout}\n${probe.stderr}`.trim(),
    MAX_DETAIL_CHARS,
  );
  return preflightError(
    "claude_cli_unauthenticated",
    `Claude CLI is not authenticated; sign in with the installed Claude CLI and retry.${detail ? `\n${detail}` : ""}`,
  );
};

/**
 * Process-cached Claude CLI readiness: executable presence and CLI authentication only, via
 * `claude auth status --json`. Success is cached per command so repeated launches skip the probe;
 * failures are never cached so a fixed installation or login is picked up immediately. Model
 * availability is deliberately not probed here.
 */
export const ensureClaudeCliReady = (
  options: ClaudeCliPreflightOptions = {},
): Effect.Effect<void, SubagentProcessError> =>
  Effect.suspend(() => {
    const command = options.command ?? "claude";
    const args = options.commandArgs ?? [];
    const key = [command, ...args].join(" ");
    if (verifiedCommands.has(key)) return Effect.void;
    return probeAuthStatus(command, args, options.timeoutMillis ?? PREFLIGHT_TIMEOUT_MILLIS).pipe(
      Effect.flatMap((probe) => {
        const failure = authenticationFailure(probe);
        if (failure) return Effect.fail(failure);
        return Effect.sync(() => {
          verifiedCommands.add(key);
        });
      }),
    );
  });
