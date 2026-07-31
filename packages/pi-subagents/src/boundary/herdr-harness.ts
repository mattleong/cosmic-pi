// Herdr runtime harness, private authentication copy, and pane-environment policy live here.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/cryptoRandomBytes:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { BackendLaunchRequest } from "../backend/model.ts";
import { InvalidSubagentRequestError, SubagentProcessError } from "../run/errors.ts";
import type { SubagentRuntime } from "../run/model.ts";
import { isSafeNativeModelSelector } from "../run/native-model-selector.ts";
import { claudeWriterCwdPolicy } from "./claude-writer-policy.ts";
import { claudeSettings } from "./local-cli-process.ts";
import type { SupervisorConnectionMetadata } from "./supervisor-channel.ts";

const HARNESS_ROOT = "herdr-host-v1";
const MAX_PATH_CHARS = 4_096;
const MAX_AUTH_BYTES = 64 * 1024;
const MAX_INTEGRATION_BYTES = 256 * 1024;
const SAFE_ENVIRONMENT_KEYS = [
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
  "TERM",
  "COLORTERM",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HERDR_CONFIG_PATH",
  "HERDR_SOCKET_PATH",
  "HERDR_SESSION",
] as const;
const SUPERVISOR_NATIVE_TOOLS = [
  "mcp__pi_subagents_supervisor__supervisor_progress",
  "mcp__pi_subagents_supervisor__supervisor_warning",
  "mcp__pi_subagents_supervisor__supervisor_question",
  "mcp__pi_subagents_supervisor__supervisor_submit_report",
] as const;
const PI_SUPERVISOR_TOOLS = [
  "supervisor_progress",
  "supervisor_warning",
  "supervisor_question",
  "supervisor_submit_report",
] as const;
const CLAUDE_READ_TOOLS = [
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
  "WebSearch",
  ...SUPERVISOR_NATIVE_TOOLS,
];
const CLAUDE_WRITE_TOOLS = [
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
  "WebSearch",
  ...SUPERVISOR_NATIVE_TOOLS,
];
const CLAUDE_DENIED_TOOLS = [
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "SendMessage",
  "Skill",
  "EnterWorktree",
  "ExitWorktree",
  "Chrome",
  "NotebookEdit",
  "Write",
];
const CODEX_DISABLED_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "computer_use",
  "fast_mode",
  "goals",
  "guardian_approval",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "plugins",
  "remote_plugin",
  "skill_search",
  "standalone_web_search",
  "tool_suggest",
  "workspace_dependencies",
] as const;

export interface HerdrPreparedHarness {
  readonly directory: string;
  readonly runtime: SubagentRuntime;
  readonly argv: ReadonlyArray<string>;
  /** Fixed, non-secret command that replaces the pane shell environment. */
  readonly environmentCommand: (topology: {
    readonly paneId: string;
    readonly tabId: string;
    readonly workspaceId: string;
  }) => string;
  /** Optional fixed command containing only a private script path, never secret bytes. */
  readonly secretCommand?: string | undefined;
  /** Authorize removal only after exact hosted topology/process cleanup has been confirmed. */
  readonly authorizeCleanup: () => void;
}

export interface HerdrHarnessShape {
  /** Readiness only; validates prerequisites without creating private run state or Herdr topology. */
  readonly preflight: (
    runtime: SubagentRuntime,
    request: Pick<
      BackendLaunchRequest,
      "cwd" | "writeIntent" | "model" | "effort" | "runtimeApiKey"
    >,
  ) => Effect.Effect<void, InvalidSubagentRequestError>;
  readonly prepare: (
    runtime: SubagentRuntime,
    request: BackendLaunchRequest,
    supervisor: SupervisorConnectionMetadata,
  ) => Effect.Effect<HerdrPreparedHarness, SubagentProcessError, Scope.Scope>;
}

export interface HerdrHarnessLayerOptions {
  readonly agentDirectory: string;
  /** Test seam only. */
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Test seams only. */
  readonly integrationPaths?: Partial<Record<SubagentRuntime, string>> | undefined;
  readonly harnessFault?: "after-claude-settings" | "after-codex-auth" | undefined;
  readonly harnessCleanupFault?: boolean | undefined;
}

const processError = (operation: string, code: string, message: string) =>
  new SubagentProcessError({ operation, code, message });
const readinessError = (code: string, message: string) =>
  new InvalidSubagentRequestError({ code, message });
const nodeCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const tomlString = (value: string): string => JSON.stringify(value);

const harnessEnvironment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.freeze(
    Object.fromEntries(
      [...SAFE_ENVIRONMENT_KEYS, "CODEX_HOME", "OPENAI_API_KEY"].flatMap((key) =>
        source[key] === undefined ? [] : ([[key, source[key]]] as const),
      ),
    ),
  );

const harnessCleanupUnconfirmed = (cause: unknown): Error & { readonly cleanupUnconfirmed: true } =>
  Object.assign(
    new Error("Partial private Herdr harness cleanup could not be confirmed.", { cause }),
    {
      cleanupUnconfirmed: true as const,
    },
  );
const isHarnessCleanupUnconfirmed = (
  error: unknown,
): error is Error & { readonly cleanupUnconfirmed: true } =>
  error instanceof Error && "cleanupUnconfirmed" in error && error.cleanupUnconfirmed === true;

const safeAgentDirectory = async (path: string): Promise<string> => {
  if (!isAbsolute(path) || path.length < 1 || path.length > MAX_PATH_CHARS || path.includes("\0"))
    throw new Error("invalid-agent-directory");
  const requested = resolve(path);
  const requestedStat = await fs.lstat(requested);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink())
    throw new Error("unsafe-agent-directory");
  const canonical = await fs.realpath(requested);
  const canonicalStat = await fs.lstat(canonical);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink())
    throw new Error("unsafe-agent-directory");
  return canonical;
};

const ensurePrivateDirectory = async (path: string): Promise<void> => {
  try {
    await fs.mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (nodeCode(error) !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-private-directory");
  await fs.chmod(path, 0o700);
};

const writeExclusive = async (path: string, source: string): Promise<void> => {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await fs.open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(source, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(path, 0o600);
};

const boundedJsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.length <= 1_024 && value.every((entry) => boundedJsonValue(entry, depth + 1));
  if (typeof value !== "object") return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 1_024 &&
    entries.every(([key, entry]) => key.length <= 1_024 && boundedJsonValue(entry, depth + 1))
  );
};

const safeCodexSourceHome = async (source: NodeJS.ProcessEnv): Promise<string | undefined> => {
  const value = source.CODEX_HOME ?? join(source.HOME || homedir(), ".codex");
  if (!isAbsolute(value) || value.length > MAX_PATH_CHARS || value.includes("\0")) return undefined;
  try {
    const requested = resolve(value);
    const requestedStat = await fs.lstat(requested);
    if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) return undefined;
    const canonical = await fs.realpath(requested);
    const canonicalStat = await fs.lstat(canonical);
    return canonicalStat.isDirectory() && !canonicalStat.isSymbolicLink() ? canonical : undefined;
  } catch {
    return undefined;
  }
};

const readCodexAuth = async (source: NodeJS.ProcessEnv): Promise<string | undefined> => {
  const home = await safeCodexSourceHome(source);
  if (!home) return undefined;
  try {
    const path = join(home, "auth.json");
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_AUTH_BYTES)
      return undefined;
    const bytes = await fs.readFile(path);
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value) || !boundedJsonValue(value))
      return undefined;
    return `${JSON.stringify(value)}\n`;
  } catch {
    return undefined;
  }
};

const approvedApiKey = (source: NodeJS.ProcessEnv): string | undefined => {
  const key = source.OPENAI_API_KEY;
  return typeof key === "string" &&
    key.length > 0 &&
    key.length <= 8_192 &&
    !key.includes("\0") &&
    !key.includes("\r") &&
    !key.includes("\n")
    ? key
    : undefined;
};

const integrationPath = (
  options: HerdrHarnessLayerOptions,
  runtime: SubagentRuntime,
  agentDirectory: string,
  environment: NodeJS.ProcessEnv,
): string => {
  const override = options.integrationPaths?.[runtime];
  if (override) return override;
  switch (runtime) {
    case "pi":
      return join(agentDirectory, "extensions", "herdr-agent-state.ts");
    case "claude":
      return join(environment.HOME || homedir(), ".claude", "hooks", "herdr-agent-state.sh");
    case "codex":
      return join(
        environment.CODEX_HOME ?? join(environment.HOME || homedir(), ".codex"),
        "herdr-agent-state.sh",
      );
  }
};

const validateIntegration = async (path: string, runtime: SubagentRuntime): Promise<void> => {
  if (!isAbsolute(path) || path.length > MAX_PATH_CHARS || path.includes("\0"))
    throw new Error("invalid-integration-path");
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_INTEGRATION_BYTES)
    throw new Error("invalid-integration-file");
  const source = await fs.readFile(path, "utf8");
  if (!source.includes("installed by herdr") || !source.includes(`HERDR_INTEGRATION_ID=${runtime}`))
    throw new Error("integration-marker-mismatch");
};

const fixedEnvironmentCommand = (
  environment: NodeJS.ProcessEnv,
  topology: { readonly paneId: string; readonly tabId: string; readonly workspaceId: string },
): string => {
  const fixed = {
    ...Object.fromEntries(
      SAFE_ENVIRONMENT_KEYS.flatMap((key) =>
        environment[key] === undefined ? [] : [[key, environment[key]]],
      ),
    ),
    HERDR_ENV: "1",
    HERDR_PANE_ID: topology.paneId,
    HERDR_TAB_ID: topology.tabId,
    HERDR_WORKSPACE_ID: topology.workspaceId,
    PI_SUBAGENT_CHILD: "1",
  };
  const assignments = Object.entries(fixed)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${shellQuote(value as string)}`)
    .join(" ");
  // /bin/sh receives no user startup files, so the pane cannot reintroduce ambient integrations.
  return `exec /usr/bin/env -i ${assignments} /bin/sh`;
};

const claudeArgv = (
  request: BackendLaunchRequest,
  settingsPath: string,
  mcpPath: string,
): ReadonlyArray<string> => {
  const tools = request.writeIntent === "writer" ? CLAUDE_WRITE_TOOLS : CLAUDE_READ_TOOLS;
  const writerPolicy = claudeWriterCwdPolicy(request.cwd);
  const allowed =
    request.writeIntent === "writer" && writerPolicy
      ? [...CLAUDE_READ_TOOLS, writerPolicy.scopedEditRule]
      : CLAUDE_READ_TOOLS;
  return [
    "--name",
    request.name,
    "--model",
    request.model,
    "--effort",
    request.effort,
    "--no-chrome",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--settings",
    settingsPath,
    "--strict-mcp-config",
    "--mcp-config",
    mcpPath,
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools.join(","),
    "--allowedTools",
    allowed.join(","),
    "--disallowedTools",
    CLAUDE_DENIED_TOOLS.join(","),
    "--append-system-prompt",
    request.systemPrompt,
  ];
};

const piArgv = (
  request: BackendLaunchRequest,
  sessionDirectory: string,
  integration: string,
  supervisorConfig: string,
): ReadonlyArray<string> => {
  const tools = [
    "read",
    "grep",
    "find",
    "ls",
    ...(request.writeIntent === "writer" ? ["bash", "edit", "write"] : []),
    ...PI_SUPERVISOR_TOOLS,
  ];
  return [
    "--name",
    request.name,
    "--model",
    request.model,
    "--thinking",
    request.effort,
    "--session-dir",
    sessionDirectory,
    "--no-approve",
    "--no-extensions",
    "--extension",
    integration,
    "--extension",
    fileURLToPath(new URL("./host-pi-supervisor-extension.ts", import.meta.url)),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools",
    tools.join(","),
    "--exclude-tools",
    "subagent_models,subagent_start,subagent_list,subagent_status,subagent_await,subagent_send,subagent_reply,subagent_lifecycle,subagent_rename,herdr_agent_start,herdr_agent_list,herdr_agent_status,herdr_agent_await,herdr_agent_read,herdr_agent_send,herdr_agent_stop",
    "--system-prompt",
    request.systemPrompt,
    "--pi-subagents-supervisor-config",
    supervisorConfig,
  ];
};

const codexConfig = (
  request: BackendLaunchRequest,
  supervisor: SupervisorConnectionMetadata,
  integration: string,
): string =>
  [
    `developer_instructions = ${tomlString(request.systemPrompt)}`,
    'approval_policy = "never"',
    `sandbox_mode = ${tomlString(request.writeIntent === "writer" ? "workspace-write" : "read-only")}`,
    'web_search = "disabled"',
    "allow_login_shell = false",
    "check_for_update_on_startup = false",
    "[analytics]",
    "enabled = false",
    "[agents]",
    "enabled = false",
    "[shell_environment_policy]",
    'inherit = "none"',
    "[features]",
    ...CODEX_DISABLED_FEATURES.map((feature) => `${feature} = false`),
    "hooks = true",
    `[projects.${tomlString(request.cwd)}]`,
    'trust_level = "untrusted"',
    supervisor.codexMcp.tomlFragment,
    "",
    `# sole marker-validated Herdr integration: ${integration.replaceAll("\n", "")}`,
    "",
  ].join("\n");

const codexArgv = (request: BackendLaunchRequest): ReadonlyArray<string> => [
  "--strict-config",
  "--model",
  request.model,
  "--sandbox",
  request.writeIntent === "writer" ? "workspace-write" : "read-only",
  "--ask-for-approval",
  "never",
  "--no-alt-screen",
  "--dangerously-bypass-hook-trust",
  "-c",
  `model_reasoning_effort=${tomlString(request.effort)}`,
  ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
];

interface PreparedHarnessResource {
  readonly harness: HerdrPreparedHarness;
  readonly cleanupAuthorized: () => boolean;
}

const prepareHarness = async (
  options: HerdrHarnessLayerOptions,
  runtime: SubagentRuntime,
  request: BackendLaunchRequest,
  supervisor: SupervisorConnectionMetadata,
): Promise<PreparedHarnessResource> => {
  const environment = options.environment ?? process.env;
  const agentDirectory = await safeAgentDirectory(options.agentDirectory);
  const packageRoot = join(agentDirectory, "subagents");
  const root = join(packageRoot, HARNESS_ROOT);
  await ensurePrivateDirectory(packageRoot);
  await ensurePrivateDirectory(root);
  const directory = join(root, `${runtime}-${request.runId}-${randomBytes(12).toString("hex")}`);
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    let cleanupAuthorized = false;
    const authorizeCleanup = () => {
      cleanupAuthorized = true;
    };
    const resource = (
      harness: Omit<HerdrPreparedHarness, "authorizeCleanup">,
    ): PreparedHarnessResource => ({
      harness: { ...harness, authorizeCleanup },
      cleanupAuthorized: () => cleanupAuthorized,
    });
    const integration = integrationPath(options, runtime, agentDirectory, environment);
    await validateIntegration(integration, runtime);
    const environmentCommand = (topology: {
      readonly paneId: string;
      readonly tabId: string;
      readonly workspaceId: string;
    }) => fixedEnvironmentCommand(environment, topology);

    if (runtime === "claude") {
      const settingsPath = join(directory, "claude-settings.json");
      const mcpPath = join(directory, "claude-mcp.json");
      const base = claudeSettings(request);
      const settings = {
        ...base,
        // Herdr Claude remains authenticated through the inherited native credential boundary,
        // while the CLI's no-session-persistence mode disables resumable transcript storage.
        env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        hooks: {
          SessionStart: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `bash ${shellQuote(integration)} session`,
                  timeout: 10,
                },
              ],
            },
          ],
        },
      };
      await writeExclusive(settingsPath, `${JSON.stringify(settings)}\n`);
      if (options.harnessFault === "after-claude-settings")
        throw new Error("fixture-after-claude-settings");
      await writeExclusive(mcpPath, `${JSON.stringify(supervisor.claudeMcp)}\n`);
      return resource({
        directory,
        runtime,
        argv: claudeArgv(request, settingsPath, mcpPath),
        environmentCommand,
      });
    }

    if (runtime === "pi") {
      const sessionDirectory = join(directory, "pi-sessions");
      await fs.mkdir(sessionDirectory, { mode: 0o700 });
      const secretPath = join(directory, "pi-environment.sh");
      const provider = request.model.slice(0, request.model.indexOf("/"));
      const secretSource = [
        request.runtimeApiKey
          ? `export PI_SUBAGENT_RUNTIME_API_KEY=${shellQuote(request.runtimeApiKey)}`
          : "unset PI_SUBAGENT_RUNTIME_API_KEY",
        request.runtimeApiKey
          ? `export PI_SUBAGENT_RUNTIME_API_PROVIDER=${shellQuote(provider)}`
          : "unset PI_SUBAGENT_RUNTIME_API_PROVIDER",
        "",
      ].join("\n");
      await writeExclusive(secretPath, secretSource);
      return resource({
        directory,
        runtime,
        argv: piArgv(request, sessionDirectory, integration, supervisor.connectionConfigPath),
        environmentCommand,
        secretCommand: `. ${shellQuote(secretPath)}`,
      });
    }

    const codexHome = join(directory, "codex-home");
    await fs.mkdir(codexHome, { mode: 0o700 });
    const auth = await readCodexAuth(environment);
    const apiKey = approvedApiKey(environment);
    if (auth) await writeExclusive(join(codexHome, "auth.json"), auth);
    else if (!apiKey) throw new Error("codex-auth-unavailable");
    if (options.harnessFault === "after-codex-auth") throw new Error("fixture-after-codex-auth");
    const hooks = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `bash ${shellQuote(integration)} session` }] },
        ],
      },
    };
    await writeExclusive(join(codexHome, "hooks.json"), `${JSON.stringify(hooks)}\n`);
    await writeExclusive(
      join(codexHome, "config.toml"),
      codexConfig(request, supervisor, integration),
    );
    const secretPath = join(directory, "codex-environment.sh");
    await writeExclusive(
      secretPath,
      [
        `export CODEX_HOME=${shellQuote(codexHome)}`,
        apiKey ? `export OPENAI_API_KEY=${shellQuote(apiKey)}` : "unset OPENAI_API_KEY",
        "",
      ].join("\n"),
    );
    return resource({
      directory,
      runtime,
      argv: codexArgv(request),
      environmentCommand,
      secretCommand: `. ${shellQuote(secretPath)}`,
    });
  } catch (error) {
    try {
      if (options.harnessCleanupFault) throw new Error("fixture-harness-cleanup-failure");
      await removeHarness(directory);
    } catch (cleanupError) {
      // Keep the private directory fail-closed. Suppressing this failure would permit candidate
      // fallback even though credentials or harness state may still be present.
      throw harnessCleanupUnconfirmed(cleanupError);
    }
    throw error;
  }
};

const removeHarness = async (directory: string): Promise<void> => {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-harness-cleanup");
  await fs.rm(directory, { recursive: true, force: false });
};

export const makeHerdrHarness = (options: HerdrHarnessLayerOptions): HerdrHarnessShape => {
  // Select and sanitize inherited auth/session inputs exactly once for this session service.
  const fixedOptions: HerdrHarnessLayerOptions = Object.freeze({
    ...options,
    environment: harnessEnvironment(options.environment ?? process.env),
    ...(options.integrationPaths
      ? { integrationPaths: Object.freeze({ ...options.integrationPaths }) }
      : {}),
  });
  return {
    preflight: (runtime, request) =>
      Effect.gen(function* () {
        if (!isSafeNativeModelSelector(request.model))
          return yield* readinessError(
            `${runtime}_model_unsupported`,
            `${runtime} model selector is empty, excessive, or unsafe.`,
          );
        const efforts =
          runtime === "claude"
            ? (["low", "medium", "high", "xhigh", "max"] as const)
            : runtime === "codex"
              ? (["minimal", "low", "medium", "high", "xhigh", "max"] as const)
              : (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
        if (!(efforts as ReadonlyArray<string>).includes(request.effort))
          return yield* readinessError(
            `${runtime}_effort_unsupported`,
            `${runtime} does not support required effort ${request.effort}.`,
          );
        if (
          runtime === "claude" &&
          request.writeIntent === "writer" &&
          !claudeWriterCwdPolicy(request.cwd)
        )
          return yield* readinessError(
            "claude_writer_confinement_unsupported",
            "Herdr Claude writer confinement requires a canonical absolute cwd representable by current noninteractive sandbox and comma-delimited scoped Edit policies.",
          );
        if (request.writeIntent === "writer" && process.platform === "win32")
          return yield* readinessError(
            "unsupported_safe_writer_ownership",
            "Herdr writers are unavailable on Windows until native Job Object ownership is implemented.",
          );
        const environment = fixedOptions.environment ?? {};
        const agentDirectory = yield* Effect.tryPromise({
          try: () => safeAgentDirectory(fixedOptions.agentDirectory),
          catch: () =>
            readinessError(
              "herdr_harness_unavailable",
              "Private agent-directory state is unavailable.",
            ),
        });
        const integration = integrationPath(fixedOptions, runtime, agentDirectory, environment);
        yield* Effect.tryPromise({
          try: () => validateIntegration(integration, runtime),
          catch: () =>
            readinessError(
              `${runtime}_herdr_integration_unavailable`,
              `The marker-validated current Herdr ${runtime} integration is unavailable.`,
            ),
        });
        if (runtime === "pi") {
          const extension = fileURLToPath(
            new URL("./host-pi-supervisor-extension.ts", import.meta.url),
          );
          const helper = fileURLToPath(new URL("./supervisor-mcp-helper.mjs", import.meta.url));
          yield* Effect.tryPromise({
            try: async () => {
              for (const path of [extension, helper]) {
                const stat = await fs.lstat(path);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1)
                  throw new Error("missing-bridge");
              }
            },
            catch: () =>
              readinessError(
                "pi_bridge_unavailable",
                "The packaged private Pi supervisor bridge is unavailable.",
              ),
          });
        }
        if (runtime === "codex") {
          const auth = yield* Effect.promise(() => readCodexAuth(environment));
          if (!auth && !approvedApiKey(environment))
            return yield* readinessError(
              "codex_harness_auth_unavailable",
              "Codex has no bounded valid auth.json copy source and no approved API-key fallback.",
            );
        }
      }),
    prepare: (runtime, request, supervisor) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => prepareHarness(fixedOptions, runtime, request, supervisor),
          catch: (error) =>
            processError(
              "prepare Herdr harness",
              isHarnessCleanupUnconfirmed(error)
                ? "herdr_harness_cleanup_unconfirmed"
                : "herdr_harness_prepare_failed",
              isHarnessCleanupUnconfirmed(error)
                ? `Private ${runtime} Herdr harness cleanup could not be confirmed; its state remains quarantined.`
                : `Unable to prepare the private ${runtime} Herdr harness.`,
            ),
        }),
        (resource) =>
          resource.cleanupAuthorized()
            ? Effect.tryPromise({
                try: () => removeHarness(resource.harness.directory),
                catch: () =>
                  processError(
                    "remove Herdr harness",
                    "herdr_harness_cleanup_unconfirmed",
                    "Private Herdr harness cleanup could not be confirmed.",
                  ),
              }).pipe(Effect.orDie)
            : Effect.void,
      ).pipe(Effect.map((resource) => resource.harness)),
  };
};

export class HerdrHarness extends Context.Service<HerdrHarness, HerdrHarnessShape>()(
  "pi-subagents/boundary/herdr-harness/HerdrHarness",
) {
  static readonly layer = (options: HerdrHarnessLayerOptions): Layer.Layer<HerdrHarness> =>
    Layer.succeed(this, makeHerdrHarness(options));
}
