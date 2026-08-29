// Private local CLI harness/auth/config filesystem lifecycle: launch and catalog harness
// roots, sanitized environment and API-key selection, Codex config builders, scoped
// failure-atomic prepare/remove, and cancelable bounded auth probes. This boundary owns no wire transport
// and must not import the LocalCliProcess service.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { runBoundedProcessNode } from "pi-cosmic-core";
import { randomBytes } from "node:crypto";
import { nodeFsPromises as fs, nodePath } from "./node-builtins.ts";
import type { BackendLaunchRequest } from "../backend/model.ts";
import { claudeArgv, claudeSettings } from "../backend/claude-policy.ts";
import type { SubagentRuntime } from "../domain/routing.ts";
import { claudeWriterCwdPolicy } from "./claude-writer-cwd.ts";
import {
  ensurePrivateDirectory,
  readValidatedCodexAuth,
  safeAgentDirectory,
  writeExclusive,
} from "./harness-shared.ts";
import type { SupervisorConnectionMetadata } from "./supervisor-channel.ts";

const { join } = nodePath;

const HARNESS_ROOT = "local-cli-v1";
const CATALOG_HARNESS_ROOT = "native-model-catalog-v1";
const MAX_PROBE_OUTPUT_BYTES = 32 * 1024;
const PROBE_TIMEOUT_MILLIS = 5_000;

const SAFE_ENV_KEYS = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
]);

export interface LocalCliHarnessOptions {
  readonly agentDirectory: string;
  /** Package-test seam only. Production always uses the fixed executable names. */
  readonly executables?: { readonly claude: string; readonly codex: string } | undefined;
  /** Package-test seam only. */
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Package-test seam only: fail after a sensitive harness file was published. */
  readonly harnessFault?: "after-claude-settings" | "after-codex-auth" | undefined;
  /** Package-test seam only: model an unconfirmable partial-harness cleanup. */
  readonly harnessCleanupFault?: boolean | undefined;
  /** Package-test seam only: pause after unique-directory ownership is established. */
  readonly afterHarnessDirectoryCreated?: (() => Promise<void>) | undefined;
}

export interface LocalCliHarnessRequest {
  readonly runtime: Extract<SubagentRuntime, "claude" | "codex">;
  readonly launch: BackendLaunchRequest;
  readonly supervisor: SupervisorConnectionMetadata;
}

export interface LocalCliHarness {
  readonly directory: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

/** Bounded harness failure that deliberately omits foreign filesystem and auth details. */
export class LocalCliHarnessError extends Schema.TaggedError<LocalCliHarnessError>()(
  "LocalCliHarnessError",
  {
    reason: Schema.Literals(["prepare_failed", "cleanup_unconfirmed"]),
    message: Schema.String,
  },
) {}

const harnessPrepareFailed = () =>
  new LocalCliHarnessError({
    reason: "prepare_failed",
    message: "Unable to prepare the private local CLI harness.",
  });

const harnessCleanupFailed = () =>
  new LocalCliHarnessError({
    reason: "cleanup_unconfirmed",
    message: "Private local CLI harness cleanup could not be confirmed.",
  });

const prepareStep = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({
    try: operation,
    catch: harnessPrepareFailed,
  });

export const approvedCodexApiKey = (source: NodeJS.ProcessEnv): string | undefined => {
  const apiKey = source.OPENAI_API_KEY;
  return Predicate.isString(apiKey) &&
    apiKey.length > 0 &&
    apiKey.length <= 8_192 &&
    !apiKey.includes("\0") &&
    !apiKey.includes("\r") &&
    !apiKey.includes("\n")
    ? apiKey
    : undefined;
};

export const sanitizeLocalCliEnvironment = (
  source: NodeJS.ProcessEnv,
  runtime: Extract<SubagentRuntime, "claude" | "codex">,
  launch?: BackendLaunchRequest,
): NodeJS.ProcessEnv => {
  const codexApiKey = runtime === "codex" ? approvedCodexApiKey(source) : undefined;
  return (() => {
    const baseResult = Object.fromEntries(
      Object.entries(source).filter(
        ([key, value]) => value !== undefined && SAFE_ENV_KEYS.has(key),
      ),
    );
    const withOpenAiApiKey = codexApiKey
      ? { ...baseResult, OPENAI_API_KEY: codexApiKey }
      : baseResult;
    const withSubagentLaunchEnvironment = launch
      ? {
          ...withOpenAiApiKey,
          PI_SUBAGENT_CHILD: "1",
          PI_SUBAGENT_PARENT_SESSION: launch.parentSessionId,
          PI_SUBAGENT_RUN_ID: launch.runId,
        }
      : withOpenAiApiKey;
    return withSubagentLaunchEnvironment;
  })();
};

export const codexArgv = (): ReadonlyArray<string> => ["app-server", "--stdio", "--strict-config"];

const codexBaseConfig = (openaiFastMode = false): ReadonlyArray<string> => [
  'approval_policy = "never"',
  'web_search = "disabled"',
  "[analytics]",
  "enabled = false",
  "[shell_environment_policy]",
  'inherit = "core"',
  'exclude = ["OPENAI_API_KEY", "CODEX_HOME", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_RUN_ID"]',
  "[agents]",
  "enabled = true",
  "[features]",
  "apps = false",
  "auth_elicitation = false",
  "browser_use = false",
  "computer_use = false",
  `fast_mode = ${openaiFastMode}`,
  "goals = false",
  "guardian_approval = false",
  "hooks = false",
  "image_generation = false",
  "in_app_browser = false",
  "memories = false",
  "multi_agent = true",
  "plugins = false",
  "remote_plugin = false",
  "skill_search = false",
  "standalone_web_search = false",
  "tool_suggest = false",
  "workspace_dependencies = false",
];

const codexConfig = (supervisor: SupervisorConnectionMetadata, openaiFastMode: boolean): string =>
  [...codexBaseConfig(openaiFastMode), supervisor.codexMcp.tomlFragment, ""].join("\n");

const codexCatalogConfig = (): string => [...codexBaseConfig(), ""].join("\n");

export const prepareLocalCliHarness = (
  options: LocalCliHarnessOptions,
  request: LocalCliHarnessRequest,
): Effect.Effect<LocalCliHarness, LocalCliHarnessError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const agentDirectory = yield* restore(
        prepareStep(() => safeAgentDirectory(options.agentDirectory)),
      );
      const packageRoot = join(agentDirectory, "subagents");
      const root = join(packageRoot, HARNESS_ROOT);
      const directory = join(
        root,
        `${request.runtime}-${request.launch.runId}-${randomBytes(12).toString("hex")}`,
      );
      yield* restore(prepareStep(() => ensurePrivateDirectory(packageRoot)));
      yield* restore(prepareStep(() => ensurePrivateDirectory(root)));
      yield* prepareStep(() => fs.mkdir(directory, { mode: 0o700 }));

      const buildHarness = (): Promise<LocalCliHarness> =>
        fs.lstat(directory).then((directoryStat) => {
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
            throw new Error("unsafe-harness-directory");
          const executable = options.executables?.[request.runtime] ?? request.runtime;
          const sourceEnvironment = options.environment ?? process.env;
          const env = sanitizeLocalCliEnvironment(
            sourceEnvironment,
            request.runtime,
            request.launch,
          );

          if (request.runtime === "claude") {
            const settingsPath = join(directory, "settings.json");
            const mcpPath = join(directory, "mcp.json");
            const promptPath = join(directory, "system-prompt.md");
            const writerPolicy = claudeWriterCwdPolicy(request.launch.cwd);
            return writeExclusive(
              settingsPath,
              `${JSON.stringify(claudeSettings(request.launch, writerPolicy))}\n`,
            )
              .then(() => {
                if (options.harnessFault === "after-claude-settings")
                  throw new Error("fixture-after-claude-settings");
                return writeExclusive(mcpPath, `${JSON.stringify(request.supervisor.claudeMcp)}\n`);
              })
              .then(() => writeExclusive(promptPath, request.launch.systemPrompt))
              .then(() => ({
                directory,
                executable,
                args: claudeArgv(
                  request.launch,
                  { settingsPath, mcpPath, promptPath },
                  writerPolicy,
                ),
                env,
              }));
          }

          const codexHome = join(directory, "codex-home");
          return fs
            .mkdir(codexHome, { mode: 0o700 })
            .then(() =>
              writeExclusive(
                join(codexHome, "config.toml"),
                codexConfig(request.supervisor, request.launch.openaiFastMode),
              ),
            )
            .then(() => readValidatedCodexAuth(sourceEnvironment))
            .then((auth) => {
              if (auth)
                return writeExclusive(join(codexHome, "auth.json"), auth).then(() => {
                  if (options.harnessFault === "after-codex-auth")
                    throw new Error("fixture-after-codex-auth");
                });
              if (!approvedCodexApiKey(sourceEnvironment))
                throw new Error("codex-auth-unavailable");
              return undefined;
            })
            .then(() => ({
              directory,
              executable,
              args: codexArgv(),
              env: { ...env, CODEX_HOME: codexHome },
            }));
        });

      const built = yield* Effect.exit(
        Effect.gen(function* () {
          if (options.afterHarnessDirectoryCreated)
            yield* prepareStep(options.afterHarnessDirectoryCreated);
          return yield* prepareStep(buildHarness);
        }),
      );
      if (built._tag === "Success") return built.value;
      const cleanup = yield* Effect.exit(
        options.harnessCleanupFault
          ? Effect.fail(harnessCleanupFailed())
          : removeLocalCliHarness(directory),
      );
      if (cleanup._tag === "Failure") return yield* harnessCleanupFailed();
      return yield* Effect.failCause(built.cause);
    }),
  );

export const removeLocalCliHarness = (
  directory: string,
): Effect.Effect<void, LocalCliHarnessError> =>
  Effect.tryPromise({
    try: () =>
      fs.lstat(directory).then((stat) => {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-harness-cleanup");
        return fs.rm(directory, { recursive: true, force: false });
      }),
    catch: harnessCleanupFailed,
  });

export interface CodexCatalogHarness {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly release: Effect.Effect<void, LocalCliHarnessError>;
}

/** Isolates model discovery from user Codex config while copying only bounded authentication. */
export const prepareCodexCatalogHarness = (options: {
  readonly agentDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<CodexCatalogHarness, LocalCliHarnessError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const agentDirectory = yield* restore(
        prepareStep(() => safeAgentDirectory(options.agentDirectory)),
      );
      const packageRoot = join(agentDirectory, "subagents");
      const root = join(packageRoot, CATALOG_HARNESS_ROOT);
      const directory = join(root, `codex-${randomBytes(12).toString("hex")}`);
      yield* restore(prepareStep(() => ensurePrivateDirectory(packageRoot)));
      yield* restore(prepareStep(() => ensurePrivateDirectory(root)));
      yield* prepareStep(() => fs.mkdir(directory, { mode: 0o700 }));

      const buildHarness = (): Promise<CodexCatalogHarness> => {
        const codexHome = join(directory, "codex-home");
        return fs
          .mkdir(codexHome, { mode: 0o700 })
          .then(() => writeExclusive(join(codexHome, "config.toml"), codexCatalogConfig()))
          .then(() => readValidatedCodexAuth(options.environment))
          .then((auth) => {
            if (auth) return writeExclusive(join(codexHome, "auth.json"), auth);
            if (!approvedCodexApiKey(options.environment))
              throw new Error("codex-auth-unavailable");
            return undefined;
          })
          .then(() => ({
            args: codexArgv(),
            env: {
              ...sanitizeLocalCliEnvironment(options.environment, "codex"),
              CODEX_HOME: codexHome,
            },
            release: removeLocalCliHarness(directory),
          }));
      };

      const built = yield* Effect.exit(prepareStep(buildHarness));
      if (built._tag === "Success") return built.value;
      const cleanup = yield* Effect.exit(removeLocalCliHarness(directory));
      if (cleanup._tag === "Failure") return yield* harnessCleanupFailed();
      return yield* Effect.failCause(built.cause);
    }),
  );

export interface ProbeResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly overflowed: boolean;
  readonly timedOut: boolean;
  readonly cleanupUnconfirmed: boolean;
}

const ClaudeAuthStatusSchema = Schema.Struct({ loggedIn: Schema.Boolean });

export const claudeAuthLoggedIn = (source: string): boolean => {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeAuthStatusSchema))(source);
  return Option.isSome(decoded) && decoded.value.loggedIn;
};

export const runProbeEffect = (
  executable: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<ProbeResult> =>
  runBoundedProcessNode({
    executable,
    args,
    environment: env,
    stdoutLimitBytes: MAX_PROBE_OUTPUT_BYTES,
    stderrLimitBytes: MAX_PROBE_OUTPUT_BYTES,
    totalOutputLimitBytes: MAX_PROBE_OUTPUT_BYTES,
    timeoutMillis: PROBE_TIMEOUT_MILLIS,
    cleanupTimeoutMillis: 2_000,
    sweepProcessTreeOnExit: true,
    detached: process.platform !== "win32",
    windowsHide: true,
  }).pipe(
    Effect.map(({ dispatched: _dispatched, ...result }) => result),
    Effect.catch((error) =>
      Effect.succeed({
        code: null,
        stdout: "",
        stderr: error.message,
        overflowed: false,
        timedOut: false,
        cleanupUnconfirmed: false,
      }),
    ),
  );

export const runIsolatedCodexAuthProbe = (
  executable: string,
  agentDirectory: string,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<ProbeResult, LocalCliHarnessError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      // Keep preparation masked until this owner can guarantee release; only the bounded probe
      // itself is restored to interruptibility.
      const harness = yield* prepareCodexCatalogHarness({ agentDirectory, environment });
      const result = yield* Effect.exit(
        restore(runProbeEffect(executable, ["login", "status"], harness.env)),
      );
      const released = yield* Effect.exit(harness.release);
      if (released._tag === "Failure") {
        if (result._tag === "Failure") return yield* harnessCleanupFailed();
        return {
          ...result.value,
          code: null,
          cleanupUnconfirmed: true,
          stderr: "Codex readiness probe private harness cleanup could not be confirmed.",
        };
      }
      if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
      return result.value;
    }),
  );
