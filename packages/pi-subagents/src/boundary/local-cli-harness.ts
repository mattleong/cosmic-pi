import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  synchronousRandomHex,
  runBoundedProcessNode,
  type BoundedProcessResult,
} from "pi-cosmic-core";
import { nodeFsPromises as fs, nodePath } from "./node-builtins.ts";
import type { BackendLaunchRequest } from "../backend/model.ts";
import {
  claudeArgv,
  claudeSettings,
  claudeWriterCwdRulePolicy,
  type ClaudeWriterCwdPolicy,
} from "../backend/claude-policy.ts";
import type { SubagentRuntime } from "../domain/routing.ts";
import {
  ensurePrivateDirectory,
  nodeErrorCode,
  readValidatedCodexAuth,
  removePrivateDirectory,
  safeAgentDirectory,
  tomlString,
  writeExclusive,
} from "./harness-shared.ts";
import {
  CLAUDE_TEMPORARY_PARENT,
  CLAUDE_TEMPORARY_PREFIX,
  CODEX_CATALOG_HARNESS_ROOT,
  LOCAL_CLI_HARNESS_ROOT,
  recordPrivateStateOwner,
  SUBAGENT_STATE_ROOT,
} from "./private-state.ts";
import type { SupervisorConnectionMetadata } from "./supervisor-channel.ts";

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
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "all_proxy",
]);

export interface LocalCliHarnessOptions {
  readonly agentDirectory: string;
  readonly executables?: { readonly claude: string; readonly codex: string } | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly harnessFault?: "after-claude-settings" | undefined;
  readonly harnessCleanupFault?: boolean | undefined;
  readonly afterHarnessDirectoryCreated?: (() => Promise<void>) | undefined;
  /** Where Claude children's temp roots are created; `/tmp` unless a test points elsewhere. */
  readonly claudeTemporaryParent?: string | undefined;
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
  /**
   * The child's private temp directory, removed with the harness. Codex's lives inside the
   * harness; Claude's is a short root of its own under `/tmp` with its own owner record.
   */
  readonly temporaryDirectory: string;
}

interface OwnedHarnessDirectories {
  readonly directory: string;
  readonly temporaryDirectory?: string | undefined;
}

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
    !/[\0\r\n]/u.test(apiKey)
    ? apiKey
    : undefined;
};

export const sanitizeLocalCliEnvironment = (
  source: NodeJS.ProcessEnv,
  runtime: Extract<SubagentRuntime, "claude" | "codex">,
  launch?: BackendLaunchRequest,
): NodeJS.ProcessEnv => {
  const codexApiKey = runtime === "codex" ? approvedCodexApiKey(source) : undefined;
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(
        ([key, value]) => value !== undefined && SAFE_ENV_KEYS.has(key),
      ),
    ),
    ...(codexApiKey && { OPENAI_API_KEY: codexApiKey }),
    ...(launch && {
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENT_PARENT_SESSION: launch.parentSessionId,
      PI_SUBAGENT_RUN_ID: launch.runId,
    }),
  };
};

export const claudeWriterCwdPolicy = (cwd: string | undefined): ClaudeWriterCwdPolicy | undefined =>
  Predicate.isString(cwd) && nodePath.isAbsolute(cwd) ? claudeWriterCwdRulePolicy(cwd) : undefined;

export const codexArgv = (): ReadonlyArray<string> => ["app-server", "--stdio", "--strict-config"];

const CODEX_DISABLED_FEATURES =
  "apps auth_elicitation browser_use computer_use fast_mode goals guardian_approval image_generation in_app_browser memories plugins remote_plugin skill_search standalone_web_search tool_suggest workspace_dependencies".split(
    " ",
  );

const CODEX_TEMPORARY_DIRECTORY = "tmp";

const temporaryEnvironment = (directory: string): NodeJS.ProcessEnv => ({
  TMPDIR: directory,
  TMP: directory,
  TEMP: directory,
});

const codexBaseConfig = (
  openaiFastMode = false,
  temporaryDirectory?: string,
): ReadonlyArray<string> => [
  'approval_policy = "never"',
  'web_search = "disabled"',
  "[analytics]",
  "enabled = false",
  "[shell_environment_policy]",
  'inherit = "core"',
  'exclude = ["OPENAI_API_KEY", "CODEX_HOME", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_RUN_ID"]',
  // zsh writes here-documents under TMPPREFIX, which defaults to /tmp, rather than TMPDIR.
  ...(temporaryDirectory === undefined
    ? []
    : [`set = { TMPPREFIX = ${tomlString(nodePath.join(temporaryDirectory, "zsh"))} }`]),
  "[agents]",
  "enabled = true",
  "[features]",
  ...CODEX_DISABLED_FEATURES.map(
    (feature) => `${feature} = ${feature === "fast_mode" && openaiFastMode}`,
  ),
  "multi_agent = true",
  "hooks = false",
];

/**
 * Every turn sends its own sandbox policy; this gives the thread's configured workspace-write
 * default the same temp-directory rule.
 */
const codexWorkspaceWriteConfig = (temporaryDirectory: string): ReadonlyArray<string> => [
  "[sandbox_workspace_write]",
  `writable_roots = [${tomlString(temporaryDirectory)}]`,
  "network_access = false",
  "exclude_tmpdir_env_var = true",
  "exclude_slash_tmp = true",
];

const codexConfig = (
  supervisor: SupervisorConnectionMetadata,
  openaiFastMode: boolean,
  temporaryDirectory: string,
): string =>
  [
    ...codexBaseConfig(openaiFastMode, temporaryDirectory),
    ...codexWorkspaceWriteConfig(temporaryDirectory),
    supervisor.codexMcp.tomlFragment,
    "",
  ].join("\n");

const codexCatalogConfig = (): string => [...codexBaseConfig(), ""].join("\n");

const removeTemporaryDirectory = (directory: string | undefined): Promise<void> =>
  directory === undefined
    ? Promise.resolve()
    : removePrivateDirectory(directory).catch((cause: unknown) => {
        if (nodeErrorCode(cause) !== "ENOENT") throw cause;
      });

/** Removes the child's temp directory first, so a harness never outlives a temp root it names. */
export const removeLocalCliHarness = (
  harness: OwnedHarnessDirectories,
): Effect.Effect<void, LocalCliHarnessError> =>
  Effect.tryPromise({
    try: () =>
      removeTemporaryDirectory(harness.temporaryDirectory).then(() =>
        removePrivateDirectory(harness.directory),
      ),
    catch: harnessCleanupFailed,
  });

/** Runs `cleanup` when `effect` fails; a cleanup failure is reported instead of the cause. */
const cleanupOnFailure = <Value>(
  effect: Effect.Effect<Value, LocalCliHarnessError>,
  cleanup: Effect.Effect<void, LocalCliHarnessError>,
): Effect.Effect<Value, LocalCliHarnessError> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      cleanup.pipe(
        Effect.catchCause(() => Effect.fail(harnessCleanupFailed())),
        Effect.andThen(Effect.failCause(cause)),
      ),
    ),
  );

const prepareOwnedHarness = <Harness>(
  agentDirectory: string,
  rootName: string,
  namePrefix: string,
  build: (directory: string) => Effect.Effect<Harness, LocalCliHarnessError>,
  cleanup: (directory: string) => Effect.Effect<void, LocalCliHarnessError> = (directory) =>
    removeLocalCliHarness({ directory }),
): Effect.Effect<Harness, LocalCliHarnessError> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const safeDirectory = yield* Effect.interruptible(
        prepareStep(() => safeAgentDirectory(agentDirectory)),
      );
      const packageRoot = nodePath.join(safeDirectory, SUBAGENT_STATE_ROOT);
      const root = nodePath.join(packageRoot, rootName);
      const directory = nodePath.join(root, `${namePrefix}-${synchronousRandomHex(12)}`);
      yield* Effect.interruptible(prepareStep(() => ensurePrivateDirectory(packageRoot)));
      yield* Effect.interruptible(prepareStep(() => ensurePrivateDirectory(root)));
      yield* prepareStep(() => fs.mkdir(directory, { mode: 0o700 }));
      return yield* cleanupOnFailure(
        prepareStep(() => recordPrivateStateOwner(directory)).pipe(
          Effect.andThen(build(directory)),
        ),
        cleanup(directory),
      );
    }),
  );

const prepareCodexHome = (
  directory: string,
  config: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> => {
  const codexHome = nodePath.join(directory, "codex-home");
  return fs
    .mkdir(codexHome, { mode: 0o700 })
    .then(() => writeExclusive(nodePath.join(codexHome, "config.toml"), config))
    .then(() => readValidatedCodexAuth(environment))
    .then((auth) => {
      if (auth) return writeExclusive(nodePath.join(codexHome, "auth.json"), auth);
      if (!approvedCodexApiKey(environment)) throw new Error("codex-auth-unavailable");
      return undefined;
    })
    .then(() => codexHome);
};

interface HarnessLaunch {
  readonly executable: string;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  readonly env: NodeJS.ProcessEnv;
}

const harnessLaunch = (
  options: LocalCliHarnessOptions,
  request: LocalCliHarnessRequest,
  directory: string,
): Promise<HarnessLaunch> =>
  fs.lstat(directory).then((directoryStat) => {
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      throw new Error("unsafe-harness-directory");
    const sourceEnvironment = options.environment ?? process.env;
    return {
      executable: options.executables?.[request.runtime] ?? request.runtime,
      sourceEnvironment,
      env: sanitizeLocalCliEnvironment(sourceEnvironment, request.runtime, request.launch),
    };
  });

/**
 * Claude Code's per-user temp directory, shared with the user's other Claude Code sessions.
 * Sandboxed Bash falls back to it when a private temp path is too long.
 */
const sharedClaudeTemporaryDirectory = (): Promise<string> => {
  const uid = process.getuid?.();
  if (uid === undefined) return Promise.reject(new Error("claude-uid-unavailable"));
  return fs
    .realpath(CLAUDE_TEMPORARY_PARENT)
    .then((parent) => nodePath.join(parent, `claude-${uid}`));
};

const buildClaudeHarness = (
  options: LocalCliHarnessOptions,
  request: LocalCliHarnessRequest,
  directory: string,
  temporaryDirectory: string,
): Promise<LocalCliHarness> =>
  Promise.all([harnessLaunch(options, request, directory), sharedClaudeTemporaryDirectory()]).then(
    ([launch, sharedTemporaryDirectory]) => {
      const settingsPath = nodePath.join(directory, "settings.json");
      const mcpPath = nodePath.join(directory, "mcp.json");
      const promptPath = nodePath.join(directory, "system-prompt.md");
      const writerPolicy = claudeWriterCwdPolicy(request.launch.cwd);
      return writeExclusive(
        settingsPath,
        `${JSON.stringify(claudeSettings(request.launch, writerPolicy, sharedTemporaryDirectory))}\n`,
      )
        .then(() => {
          if (options.harnessFault === "after-claude-settings")
            throw new Error("fixture-after-claude-settings");
          return writeExclusive(mcpPath, `${JSON.stringify(request.supervisor.claudeMcp)}\n`);
        })
        .then(() => writeExclusive(promptPath, request.launch.systemPrompt))
        .then(() => ({
          directory,
          executable: launch.executable,
          args: claudeArgv(request.launch, { settingsPath, mcpPath, promptPath }, writerPolicy),
          env: {
            ...launch.env,
            ...temporaryEnvironment(temporaryDirectory),
            CLAUDE_CODE_TMPDIR: temporaryDirectory,
          },
          temporaryDirectory,
        }));
    },
  );

const buildCodexHarness = (
  options: LocalCliHarnessOptions,
  request: LocalCliHarnessRequest,
  directory: string,
): Promise<LocalCliHarness> =>
  harnessLaunch(options, request, directory).then((launch) => {
    // Codex writers may not write the shared /tmp or $TMPDIR; this is their private temp space.
    const temporaryDirectory = nodePath.join(directory, CODEX_TEMPORARY_DIRECTORY);
    return fs
      .mkdir(temporaryDirectory, { mode: 0o700 })
      .then(() =>
        prepareCodexHome(
          directory,
          codexConfig(request.supervisor, request.launch.openaiFastMode, temporaryDirectory),
          launch.sourceEnvironment,
        ),
      )
      .then((codexHome) => ({
        directory,
        executable: launch.executable,
        args: codexArgv(),
        env: { ...launch.env, ...temporaryEnvironment(temporaryDirectory), CODEX_HOME: codexHome },
        temporaryDirectory,
      }));
  });

/**
 * Claude Code puts its own temp files and sandboxed Bash's `$TMPDIR` under `CLAUDE_CODE_TMPDIR`,
 * so each Claude child gets a fresh 0700 root there instead of the user's shared directory.
 */
const prepareClaudeHarness = (
  options: LocalCliHarnessOptions,
  request: LocalCliHarnessRequest,
  directory: string,
): Effect.Effect<LocalCliHarness, LocalCliHarnessError> =>
  Effect.gen(function* () {
    const parent = options.claudeTemporaryParent ?? CLAUDE_TEMPORARY_PARENT;
    const temporaryDirectory = yield* prepareStep(() =>
      fs.mkdtemp(nodePath.join(parent, CLAUDE_TEMPORARY_PREFIX)),
    );
    return yield* cleanupOnFailure(
      prepareStep(() =>
        recordPrivateStateOwner(temporaryDirectory).then(() =>
          buildClaudeHarness(options, request, directory, temporaryDirectory),
        ),
      ),
      Effect.tryPromise({
        try: () => removePrivateDirectory(temporaryDirectory),
        catch: harnessCleanupFailed,
      }),
    );
  });

export const prepareLocalCliHarness = (
  options: LocalCliHarnessOptions,
  request: LocalCliHarnessRequest,
): Effect.Effect<LocalCliHarness, LocalCliHarnessError> =>
  prepareOwnedHarness(
    options.agentDirectory,
    LOCAL_CLI_HARNESS_ROOT,
    `${request.runtime}-${request.launch.runId}`,
    (directory) =>
      Effect.gen(function* () {
        if (options.afterHarnessDirectoryCreated)
          yield* prepareStep(options.afterHarnessDirectoryCreated);
        return yield* request.runtime === "claude"
          ? prepareClaudeHarness(options, request, directory)
          : prepareStep(() => buildCodexHarness(options, request, directory));
      }),
    (directory) =>
      options.harnessCleanupFault
        ? Effect.fail(harnessCleanupFailed())
        : removeLocalCliHarness({ directory }),
  );

export interface CodexCatalogHarness {
  readonly env: NodeJS.ProcessEnv;
  readonly release: Effect.Effect<void, LocalCliHarnessError>;
}

export const prepareCodexCatalogHarness = (options: {
  readonly agentDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<CodexCatalogHarness, LocalCliHarnessError> =>
  prepareOwnedHarness(options.agentDirectory, CODEX_CATALOG_HARNESS_ROOT, "codex", (directory) =>
    prepareStep(() =>
      prepareCodexHome(directory, codexCatalogConfig(), options.environment).then((codexHome) => ({
        env: {
          ...sanitizeLocalCliEnvironment(options.environment, "codex"),
          CODEX_HOME: codexHome,
        },
        release: removeLocalCliHarness({ directory }),
      })),
    ),
  );

export type ProbeResult = Omit<BoundedProcessResult, "signal">;

const decodeClaudeAuthStatus = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ loggedIn: Schema.Boolean })),
);

export const claudeAuthLoggedIn = (source: string): boolean => {
  const decoded = decodeClaudeAuthStatus(source);
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
    detached: true,
  }).pipe(
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
      const harness = yield* prepareCodexCatalogHarness({ agentDirectory, environment });
      const result = yield* Effect.exit(
        restore(runProbeEffect(executable, ["login", "status"], harness.env)),
      );
      const released = yield* Effect.exit(harness.release);
      if (Exit.isFailure(released)) {
        if (Exit.isFailure(result)) return yield* harnessCleanupFailed();
        return {
          ...result.value,
          code: null,
          cleanupUnconfirmed: true,
          stderr: "Codex readiness probe private harness cleanup could not be confirmed.",
        };
      }
      return yield* result;
    }),
  );
