import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import {
  invalidRequest as preflightError,
  type InvalidSubagentRequestError,
  type SubagentProcessError,
} from "../run/errors.ts";
import {
  subagentRuntimeEfforts,
  type SubagentEffort,
  type SubagentRuntime,
  type SubagentWriteIntent,
} from "../domain/routing.ts";
import { isSafeNativeModelSelector } from "../profiles/model.ts";
import {
  classifyCliVersion,
  LOCAL_CLI_LABELS,
  LOCAL_CLI_MINIMUM_VERSIONS,
  type LocalCliVersion,
} from "../backend/local-cli-version.ts";
import { acquireLocalClaudeDebug, type LocalClaudeDebugRecorder } from "./local-claude-debug.ts";
import { readValidatedCodexAuth, safeAgentDirectory } from "./harness-shared.ts";
import { requireNodeExecutable } from "./node-executable.ts";
import {
  approvedCodexApiKey,
  claudeAuthLoggedIn,
  claudeWriterCwdPolicy,
  prepareLocalCliHarness,
  removeLocalCliHarness,
  runIsolatedCodexAuthProbe,
  runProbeEffect,
  type ProbeResult,
  sanitizeLocalCliEnvironment,
  type LocalCliHarnessOptions,
  type LocalCliHarnessRequest,
} from "./local-cli-harness.ts";
import {
  acquireLocalCliTransport,
  processError,
  type LocalCliHandle,
} from "./local-cli-transport.ts";

export type LocalCliRuntime = Extract<SubagentRuntime, "claude" | "codex">;

export interface LocalCliPreflightRequest {
  readonly runtime: LocalCliRuntime;
  readonly context: "fresh" | "fork";
  readonly writeIntent: SubagentWriteIntent;
  readonly closeOnReport: boolean;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly cwd?: string | undefined;
}

export interface LocalCliProcessHandle extends LocalCliHandle {
  readonly claudeDebug?: LocalClaudeDebugRecorder | undefined;
  /** The child's private temp directory, removed with its harness after the process exits. */
  readonly temporaryDirectory?: string | undefined;
}

export interface LocalCliProcessContract {
  readonly preflight: (
    request: LocalCliPreflightRequest,
  ) => Effect.Effect<void, InvalidSubagentRequestError>;
  /** The CLI's reported release, probed once per session. */
  readonly version?: ((runtime: LocalCliRuntime) => Effect.Effect<LocalCliVersion>) | undefined;
  readonly spawn: (
    request: LocalCliHarnessRequest,
  ) => Effect.Effect<LocalCliProcessHandle, SubagentProcessError, Scope.Scope>;
}

const validateLocalPreflightRequest = (
  options: LocalCliHarnessOptions,
  request: LocalCliPreflightRequest,
) =>
  Effect.gen(function* () {
    if (request.context !== "fresh")
      return yield* preflightError(
        "context_unsupported",
        `local/${request.runtime} supports fresh context only.`,
      );
    if (!request.closeOnReport)
      return yield* preflightError(
        "local_close_on_report_required",
        `local/${request.runtime} requires closeOnReport=true.`,
      );
    const claudeSandboxPlatforms: ReadonlyArray<NodeJS.Platform> = ["darwin", "linux"];
    if (request.runtime === "claude" && !claudeSandboxPlatforms.includes(process.platform))
      return yield* preflightError(
        "claude_shell_confinement_unsupported",
        "Local Claude subagents require a current supported strict Bash sandbox platform.",
      );
    if (!isSafeNativeModelSelector(request.model))
      return yield* preflightError(
        `${request.runtime}_model_unsupported`,
        `${request.runtime} model selector is empty, excessive, or unsafe.`,
      );
    const supportedEfforts = subagentRuntimeEfforts(request.runtime);
    if (!supportedEfforts.includes(request.effort))
      return yield* preflightError(
        `${request.runtime}_effort_unsupported`,
        `${request.runtime} does not support required effort ${request.effort}; supported efforts: ${supportedEfforts.join(", ")}.`,
      );
    if (
      request.runtime === "claude" &&
      request.writeIntent === "writer" &&
      !claudeWriterCwdPolicy(request.cwd)
    )
      return yield* preflightError(
        "claude_writer_confinement_unsupported",
        "Local Claude writer confinement requires a canonical absolute cwd representable by current noninteractive sandbox and scoped Edit policies.",
      );
    // The supervisor MCP helper that Claude and Codex start runs on this Node binary.
    yield* requireNodeExecutable();
    yield* Effect.tryPromise({
      try: () => safeAgentDirectory(options.agentDirectory),
      catch: () =>
        preflightError(
          "local_harness_unavailable",
          "Private agent-directory state is unavailable for the local CLI harness.",
        ),
    });
    return undefined;
  });

const runVersionProbe = (
  options: LocalCliHarnessOptions,
  runtime: LocalCliRuntime,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<LocalCliVersion, InvalidSubagentRequestError> =>
  runProbeEffect(
    options.executables?.[runtime] ?? runtime,
    ["--version"],
    sanitizeLocalCliEnvironment(environment, runtime),
  ).pipe(
    Effect.flatMap((result) => {
      if (result.cleanupUnconfirmed)
        return preflightError(
          `${runtime}_preflight_cleanup_unconfirmed`,
          `${runtime} version probe cleanup could not be confirmed; no later candidate will be attempted.`,
        );
      return Effect.succeed(
        result.code === 0 && !result.timedOut && !result.overflowed
          ? classifyCliVersion(runtime, result.stdout)
          : { status: "unavailable" as const },
      );
    }),
  );

const requireSupportedVersion = (runtime: LocalCliRuntime, version: LocalCliVersion) =>
  version.status === "unsupported"
    ? preflightError(
        `${runtime}_version_unsupported`,
        `${LOCAL_CLI_LABELS[runtime]} ${version.version} is older than the supported ${LOCAL_CLI_MINIMUM_VERSIONS[runtime]}; update it to use this route.`,
      )
    : Effect.void;

const resolveCodexApiKeyFallback = (
  request: LocalCliPreflightRequest,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    if (request.runtime !== "codex") return false;
    const auth = yield* Effect.promise(() => readValidatedCodexAuth(environment));
    const fallback = !auth && approvedCodexApiKey(environment) !== undefined;
    if (!auth && !fallback)
      return yield* preflightError(
        "codex_harness_auth_unavailable",
        "Codex has no bounded valid auth.json to copy and no approved OPENAI_API_KEY fallback.",
      );
    return fallback;
  });

const runLocalPreflightProbe = (
  options: LocalCliHarnessOptions,
  request: LocalCliPreflightRequest,
  environment: NodeJS.ProcessEnv,
  codexApiKeyFallback: boolean,
): Effect.Effect<ProbeResult, InvalidSubagentRequestError> => {
  const executable = options.executables?.[request.runtime] ?? request.runtime;
  if (request.runtime === "claude" || codexApiKeyFallback)
    return runProbeEffect(
      executable,
      request.runtime === "claude" ? ["auth", "status", "--json"] : ["--version"],
      sanitizeLocalCliEnvironment(environment, request.runtime),
    );
  return runIsolatedCodexAuthProbe(executable, options.agentDirectory, environment).pipe(
    Effect.mapError((error) =>
      error.reason === "cleanup_unconfirmed"
        ? preflightError(
            "codex_preflight_cleanup_unconfirmed",
            "codex readiness probe private harness cleanup could not be confirmed; no later candidate will be attempted.",
          )
        : preflightError(
            "codex_preflight_failed",
            "Unable to run bounded codex readiness preflight.",
          ),
    ),
  );
};

const validateLocalProbeResult = (
  request: LocalCliPreflightRequest,
  result: ProbeResult,
  codexApiKeyFallback: boolean,
) =>
  Effect.gen(function* () {
    if (result.cleanupUnconfirmed)
      return yield* preflightError(
        `${request.runtime}_preflight_cleanup_unconfirmed`,
        `${request.runtime} readiness probe cleanup could not be confirmed; no later candidate will be attempted.`,
      );
    if (result.timedOut || result.overflowed)
      return yield* preflightError(
        `${request.runtime}_preflight_unbounded`,
        `${request.runtime} readiness preflight exceeded its time or output bound.`,
      );
    if (result.code !== 0)
      return yield* preflightError(
        result.code === null
          ? `${request.runtime}_executable_unavailable`
          : `${request.runtime}_unauthenticated`,
        result.code === null
          ? `${request.runtime} executable is unavailable.`
          : `${request.runtime} authentication is unavailable.`,
      );
    if (request.runtime === "claude" && !claudeAuthLoggedIn(result.stdout))
      return yield* preflightError(
        "claude_unauthenticated",
        "Claude Code auth status did not confirm an authenticated account.",
      );
    if (
      request.runtime === "codex" &&
      !codexApiKeyFallback &&
      !/logged in/i.test(`${result.stdout}\n${result.stderr}`)
    )
      return yield* preflightError(
        "codex_unauthenticated",
        "Codex login status did not confirm an authenticated account.",
      );
    return undefined;
  });

const acquireLocalCli = Effect.fn("LocalCliProcess.acquire")(function* (
  options: LocalCliHarnessOptions,
  request: LocalCliHarnessRequest,
) {
  const harness = yield* Effect.acquireRelease(
    prepareLocalCliHarness(options, request).pipe(
      Effect.mapError((error) =>
        processError(
          "prepare private local CLI harness",
          error,
          error.reason === "cleanup_unconfirmed"
            ? "harness_cleanup_unconfirmed"
            : "harness_prepare_failed",
        ),
      ),
    ),
    (owned) => removeLocalCliHarness(owned).pipe(Effect.orDie),
  );
  const sourceEnvironment = options.environment ?? process.env;
  const claudeDebug =
    request.runtime === "claude"
      ? yield* acquireLocalClaudeDebug({
          agentDirectory: options.agentDirectory,
          environment: sourceEnvironment,
          runId: request.launch.runId,
        })
      : undefined;
  const transport = yield* acquireLocalCliTransport({
    executable: harness.executable,
    args: harness.args,
    env: harness.env,
    cwd: request.launch.cwd,
    writer: request.launch.writeIntent === "writer",
  });
  const handle: LocalCliProcessHandle = {
    ...transport,
    ...(claudeDebug && { claudeDebug }),
    temporaryDirectory: harness.temporaryDirectory,
  };
  return handle;
});

export const makeLocalCliProcess = (options: LocalCliHarnessOptions): LocalCliProcessContract => {
  const environment = options.environment ?? process.env;
  // A CLI rarely changes within a session; an unavailable one is probed again next time.
  const versions = new Map<LocalCliRuntime, LocalCliVersion>();
  const cachedVersion = (runtime: LocalCliRuntime) =>
    Effect.suspend(() => {
      const known = versions.get(runtime);
      if (known) return Effect.succeed(known);
      return runVersionProbe(options, runtime, environment).pipe(
        Effect.tap((probed) =>
          Effect.sync(() => {
            if (probed.status !== "unavailable") versions.set(runtime, probed);
          }),
        ),
      );
    });
  const version = (runtime: LocalCliRuntime): Effect.Effect<LocalCliVersion> =>
    cachedVersion(runtime).pipe(
      Effect.catch(() => Effect.succeed<LocalCliVersion>({ status: "unavailable" })),
    );
  return {
    preflight: Effect.fn("LocalCliProcess.preflight")(function* (
      request: LocalCliPreflightRequest,
    ) {
      yield* validateLocalPreflightRequest(options, request);
      yield* requireSupportedVersion(request.runtime, yield* cachedVersion(request.runtime));
      const codexApiKeyFallback = yield* resolveCodexApiKeyFallback(request, environment);
      const result = yield* runLocalPreflightProbe(
        options,
        request,
        environment,
        codexApiKeyFallback,
      );
      yield* validateLocalProbeResult(request, result, codexApiKeyFallback);
    }),
    version,
    spawn: (request) => acquireLocalCli(options, request),
  };
};

export class LocalCliProcess extends Context.Service<LocalCliProcess, LocalCliProcessContract>()(
  "pi-subagents/boundary/local-cli-process/LocalCliProcess",
) {
  static readonly layer = (options: LocalCliHarnessOptions): Layer.Layer<LocalCliProcess> =>
    Layer.succeed(this, makeLocalCliProcess(options));
}
