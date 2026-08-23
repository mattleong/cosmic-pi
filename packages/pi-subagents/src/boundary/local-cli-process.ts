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
import { isSafeNativeModelSelector } from "../run/native-model-selector.ts";
import { claudeWriterCwdPolicy } from "./claude-writer-cwd.ts";
import {
  isHarnessCleanupUnconfirmed,
  readValidatedCodexAuth,
  safeAgentDirectory,
} from "./harness-shared.ts";
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

const acquireLocalCli = Effect.fn("LocalCliProcess.acquire")(function* (
  options: LocalCliProcessLayerOptions,
  request: LocalCliSpawnRequest,
) {
  const harness = yield* Effect.tryPromise({
    try: () => prepareLocalCliHarness(options, request),
    catch: (error) =>
      processError(
        "prepare private local CLI harness",
        error,
        isHarnessCleanupUnconfirmed(error)
          ? "harness_cleanup_unconfirmed"
          : "harness_prepare_failed",
      ),
  });
  let harnessOwned = true;
  const releaseHarness = (operation: string) =>
    Effect.suspend(() => {
      if (!harnessOwned) return Effect.void;
      harnessOwned = false;
      return Effect.tryPromise({
        try: () => removeLocalCliHarness(harness.directory),
        catch: (error) => processError(operation, error),
      }).pipe(Effect.orDie);
    });
  return yield* acquireLocalCliTransport({
    executable: harness.executable,
    args: harness.args,
    env: harness.env,
    cwd: request.launch.cwd,
    platform: options.platform,
  }).pipe(
    Effect.map((transport) => ({
      ...transport,
      release: transport.release.pipe(
        Effect.ensuring(releaseHarness("remove private local CLI harness")),
      ),
    })),
    Effect.onError(() => releaseHarness("remove failed local CLI acquisition harness")),
  );
});

// SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
export const makeLocalCliProcess = (
  options: LocalCliProcessLayerOptions,
): LocalCliProcessContract => ({
  preflight: (request) =>
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
      const environment = options.environment ?? process.env;
      let codexApiKeyFallback = false;
      if (request.runtime === "codex") {
        // Auth helpers contain hostile filesystem/JSON failures and cannot reject.
        const auth = yield* Effect.promise(() => readValidatedCodexAuth(environment));
        codexApiKeyFallback = !auth && approvedCodexApiKey(environment) !== undefined;
        if (!auth && !codexApiKeyFallback)
          return yield* preflightError(
            "codex_harness_auth_unavailable",
            "Codex has no bounded valid auth.json to copy and no approved OPENAI_API_KEY fallback.",
          );
      }
      const executable = options.executables?.[request.runtime] ?? request.runtime;
      const args =
        request.runtime === "claude"
          ? ["auth", "status", "--json"]
          : codexApiKeyFallback
            ? ["--version"]
            : ["login", "status"];
      const probeEnvironment = sanitizeLocalCliEnvironment(environment, request.runtime);
      let result: ProbeResult;
      if (request.runtime === "codex" && !codexApiKeyFallback) {
        result = yield* Effect.tryPromise({
          try: () => runIsolatedCodexAuthProbe(executable, options.agentDirectory, environment),
          catch: (error) =>
            isHarnessCleanupUnconfirmed(error)
              ? preflightError(
                  `${request.runtime}_preflight_cleanup_unconfirmed`,
                  `${request.runtime} readiness probe private harness cleanup could not be confirmed; no later candidate will be attempted.`,
                )
              : preflightError(
                  `${request.runtime}_preflight_failed`,
                  `Unable to run bounded ${request.runtime} readiness preflight.`,
                ),
        });
      } else {
        // The bounded probe is total: it always resolves an outcome record.
        result = yield* runProbeEffect(executable, args, probeEnvironment);
      }
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
      if (request.runtime === "claude") {
        if (!claudeAuthLoggedIn(result.stdout))
          return yield* preflightError(
            "claude_unauthenticated",
            "Claude Code auth status did not confirm an authenticated account.",
          );
      } else if (!codexApiKeyFallback && !/logged in/i.test(`${result.stdout}\n${result.stderr}`))
        return yield* preflightError(
          "codex_unauthenticated",
          "Codex login status did not confirm an authenticated account.",
        );
      return yield* Effect.void;
    }),
  spawn: (request) =>
    Effect.acquireRelease(acquireLocalCli(options, request), (handle) =>
      handle.release.pipe(Effect.orDie),
    ).pipe(Effect.map(({ release: _release, ...handle }) => handle)),
});

export class LocalCliProcess extends Context.Service<LocalCliProcess, LocalCliProcessContract>()(
  "pi-subagents/boundary/local-cli-process/LocalCliProcess",
) {
  static readonly layer = (options: LocalCliProcessLayerOptions): Layer.Layer<LocalCliProcess> =>
    Layer.succeed(this, makeLocalCliProcess(options));
}
