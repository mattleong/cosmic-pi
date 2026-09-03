// The LocalCliProcess service door: local CLI request/service contracts plus environment,
// preflight, and probe orchestration over the private harness and wire-transport boundaries.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { BackendLaunchRequest } from "../backend/model.ts";
import {
  InvalidSubagentRequestError,
  processCauseError,
  SubagentProcessError,
} from "../run/errors.ts";
import {
  subagentRuntimeEfforts,
  type SubagentEffort,
  type SubagentRuntime,
  type SubagentWriteIntent,
} from "../domain/routing.ts";
import { isSafeNativeModelSelector } from "../profiles/model.ts";
import { claudeWriterCwdPolicy } from "./claude-writer-cwd.ts";
import { readValidatedCodexAuth, safeAgentDirectory } from "./harness-shared.ts";
import {
  approvedCodexApiKey,
  claudeAuthLoggedIn,
  prepareLocalCliHarness,
  removeLocalCliHarness,
  runIsolatedCodexAuthProbe,
  runProbeEffect,
  type ProbeResult,
  sanitizeLocalCliEnvironment,
  type LocalCliHarnessOptions,
} from "./local-cli-harness.ts";
import { acquireLocalCliTransport, type LocalCliHandle } from "./local-cli-transport.ts";
import type { SupervisorConnectionMetadata } from "./supervisor-channel.ts";

export type LocalCliRuntime = Extract<SubagentRuntime, "claude" | "codex">;

export interface LocalCliSpawnRequest {
  readonly runtime: LocalCliRuntime;
  readonly launch: BackendLaunchRequest;
  readonly supervisor: SupervisorConnectionMetadata;
}

export interface LocalCliPreflightRequest {
  readonly runtime: LocalCliRuntime;
  readonly context: "fresh" | "fork";
  readonly writeIntent: SubagentWriteIntent;
  readonly closeOnReport: boolean;
  readonly model: string;
  readonly effort: SubagentEffort;
  /** Canonical assigned cwd when available. Required for local Claude writers. */
  readonly cwd?: string | undefined;
}

export interface LocalCliProcessContract {
  readonly preflight: (
    request: LocalCliPreflightRequest,
  ) => Effect.Effect<void, InvalidSubagentRequestError>;
  readonly spawn: (
    request: LocalCliSpawnRequest,
  ) => Effect.Effect<LocalCliHandle, SubagentProcessError, Scope.Scope>;
}

export interface LocalCliProcessLayerOptions extends LocalCliHarnessOptions {
  /** Package-test seam only. */
  readonly platform?: NodeJS.Platform | undefined;
}

const processError = <ErrorInput>(
  operation: string,
  error?: ErrorInput,
  code?: string,
): SubagentProcessError =>
  processCauseError(operation, error, code, `Unable to ${operation} local CLI process.`);

const preflightError = (code: string, message: string) =>
  new InvalidSubagentRequestError({ code, message });

const validateLocalPreflightRequest = (
  options: LocalCliProcessLayerOptions,
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
    if (request.writeIntent === "writer" && (options.platform ?? process.platform) === "win32")
      return yield* preflightError(
        "unsupported_safe_writer_ownership",
        "Local CLI writers are unavailable on Windows until native Job Object cleanup is implemented.",
      );
    const claudeSandboxPlatforms: ReadonlyArray<NodeJS.Platform> = ["darwin", "linux"];
    if (
      request.runtime === "claude" &&
      !claudeSandboxPlatforms.includes(options.platform ?? process.platform)
    )
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
    yield* Effect.tryPromise({
      try: () => safeAgentDirectory(options.agentDirectory),
      catch: () =>
        preflightError(
          "local_harness_unavailable",
          "Private agent-directory state is unavailable for the local CLI harness.",
        ),
    });
  });

const resolveCodexApiKeyFallback = (
  request: LocalCliPreflightRequest,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    if (request.runtime !== "codex") return false;
    // Auth helpers contain hostile filesystem/JSON failures and cannot reject.
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
  options: LocalCliProcessLayerOptions,
  request: LocalCliPreflightRequest,
  environment: NodeJS.ProcessEnv,
  codexApiKeyFallback: boolean,
): Effect.Effect<ProbeResult, InvalidSubagentRequestError> => {
  const executable = options.executables?.[request.runtime] ?? request.runtime;
  const args =
    request.runtime === "claude"
      ? ["auth", "status", "--json"]
      : codexApiKeyFallback
        ? ["--version"]
        : ["login", "status"];
  const probeEnvironment = sanitizeLocalCliEnvironment(environment, request.runtime);
  if (request.runtime !== "codex" || codexApiKeyFallback)
    return runProbeEffect(executable, args, probeEnvironment);
  return runIsolatedCodexAuthProbe(executable, options.agentDirectory, environment).pipe(
    Effect.mapError((error) =>
      error.reason === "cleanup_unconfirmed"
        ? preflightError(
            `${request.runtime}_preflight_cleanup_unconfirmed`,
            `${request.runtime} readiness probe private harness cleanup could not be confirmed; no later candidate will be attempted.`,
          )
        : preflightError(
            `${request.runtime}_preflight_failed`,
            `Unable to run bounded ${request.runtime} readiness preflight.`,
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
  });

const acquireLocalCli = Effect.fn("LocalCliProcess.acquire")(function* (
  options: LocalCliProcessLayerOptions,
  request: LocalCliSpawnRequest,
) {
  // Keep acquisition masked through finalizer registration. Preparation owns a unique private
  // directory before its final writes, so exposing interruption between return and registration
  // could abandon credential-bearing state.
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
    (owned) => removeLocalCliHarness(owned.directory).pipe(Effect.orDie),
  );
  return yield* Effect.acquireRelease(
    acquireLocalCliTransport({
      executable: harness.executable,
      args: harness.args,
      env: harness.env,
      cwd: request.launch.cwd,
      platform: options.platform,
    }),
    (transport) => transport.release.pipe(Effect.orDie),
  );
});

// SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
export const makeLocalCliProcess = (
  options: LocalCliProcessLayerOptions,
): LocalCliProcessContract => ({
  preflight: (request) =>
    Effect.gen(function* () {
      yield* validateLocalPreflightRequest(options, request);
      const environment = options.environment ?? process.env;
      const codexApiKeyFallback = yield* resolveCodexApiKeyFallback(request, environment);
      const result = yield* runLocalPreflightProbe(
        options,
        request,
        environment,
        codexApiKeyFallback,
      );
      yield* validateLocalProbeResult(request, result, codexApiKeyFallback);
    }),
  spawn: (request) =>
    acquireLocalCli(options, request).pipe(
      Effect.map(({ release: _release, ...handle }) => handle),
    ),
});

export class LocalCliProcess extends Context.Service<LocalCliProcess, LocalCliProcessContract>()(
  "pi-subagents/boundary/local-cli-process/LocalCliProcess",
) {
  static readonly layer = (options: LocalCliProcessLayerOptions): Layer.Layer<LocalCliProcess> =>
    Layer.succeed(this, makeLocalCliProcess(options));
}
