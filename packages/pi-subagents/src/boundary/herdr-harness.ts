// Herdr runtime harness, private authentication copy, and pane-environment policy live here.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/cryptoRandomBytes:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type { BackendLaunchRequest } from "../backend/model.ts";
import { ORCHESTRATION_TOOL_DENYLIST_ARGUMENT } from "../run/tool-policy.ts";
import { InvalidSubagentRequestError, processError, SubagentProcessError } from "../run/errors.ts";
import { SUBAGENT_FAST_SERVICE_TIER } from "../run/fast-mode.ts";
import { subagentRuntimeEfforts, type SubagentRuntime } from "../domain/routing.ts";
import { isSafeNativeModelSelector } from "../run/native-model-selector.ts";
import {
  claudeAllowedTools,
  claudeSettings,
  CLAUDE_DENIED_TOOLS,
  CLAUDE_READ_TOOLS,
  CLAUDE_WRITE_TOOLS,
} from "../backend/claude-policy.ts";
import { claudeWriterCwdPolicy } from "./claude-writer-cwd.ts";
import {
  isHerdrCodexHooksError,
  makeHerdrCodexHooks,
  type HerdrCodexHooksContract,
} from "./herdr-codex-hooks.ts";
import {
  ensurePrivateDirectory,
  harnessCleanupUnconfirmed,
  hasControlCharacter,
  isHarnessCleanupUnconfirmed,
  MAX_PATH_CHARS,
  readValidatedCodexAuth,
  safeAgentDirectory,
  tomlString,
  writeExclusive,
} from "./harness-shared.ts";
import { approvedCodexApiKey as approvedApiKey } from "./local-cli-harness.ts";
import type { SupervisorConnectionMetadata } from "./supervisor-channel.ts";

const HARNESS_ROOT = "herdr-host-v1";
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
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "HERDR_CONFIG_PATH",
  "HERDR_SOCKET_PATH",
  "HERDR_SESSION",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "CLAUDE_CONFIG_DIR",
] as const;
const HERDR_080_INTEGRATION_VERSIONS = {
  pi: 8,
  claude: 7,
  codex: 7,
} satisfies Readonly<Record<SubagentRuntime, number>>;
const PI_SUPERVISOR_TOOLS = [
  "supervisor_progress",
  "supervisor_warning",
  "supervisor_question",
  "supervisor_submit_report",
] as const;
const CODEX_BOOTSTRAP_PROMPT =
  "Initialize the private Herdr lifecycle hook. This bootstrap turn must stop before inference.";
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
  readonly environmentReadyMarker: string;
  /** Harmless per-attempt marker used to causally activate a restored no-focus workspace. */
  readonly activationProbe: (attempt: number) => {
    readonly command: string;
    readonly marker: string;
  };
  /** Causally proves that the replacement shell accepted input after a bootstrap marker. */
  readonly shellReadinessProbe: (phase: "environment" | "secrets") => {
    readonly command: string;
    readonly marker: string;
  };
  /** Optional fixed command containing only a private script path and readiness marker. */
  readonly secretCommand?: string | undefined;
  readonly secretReadyMarker?: string | undefined;
  /** Authorize removal only after exact hosted topology/process cleanup has been confirmed. */
  readonly authorizeCleanup: () => void;
}

export interface HerdrHarnessContract {
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
  /** Test seam only. Production uses the fixed Codex hook-trust boundary. */
  readonly codexHooks?: HerdrCodexHooksContract | undefined;
  /** Test seam only. Production uses the current Node platform. */
  readonly platform?: NodeJS.Platform | undefined;
}

const readinessError = (code: string, message: string) =>
  new InvalidSubagentRequestError({ code, message });
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const printMarkerCommand = (marker: string): string => {
  const pivot = Math.max(1, Math.floor(marker.length / 2));
  return `printf '%s%s\\n' ${shellQuote(marker.slice(0, pivot))} ${shellQuote(marker.slice(pivot))}`;
};
const controlFreeArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (argv.some(hasControlCharacter)) throw new Error("herdr-agent-argument-invalid");
  return argv;
};

const harnessEnvironment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.freeze(
    Object.fromEntries(
      [...SAFE_ENVIRONMENT_KEYS, "CODEX_HOME", "OPENAI_API_KEY"].flatMap((key) =>
        source[key] === undefined ? [] : ([[key, source[key]]] as const),
      ),
    ),
  );

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
      return join(
        environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME || homedir(), ".claude"),
        "hooks",
        "herdr-agent-state.sh",
      );
    case "codex":
      return join(
        environment.CODEX_HOME ?? join(environment.HOME || homedir(), ".codex"),
        "herdr-agent-state.sh",
      );
  }
};

const validateIntegration = async (path: string, runtime: SubagentRuntime): Promise<void> => {
  if (!isAbsolute(path) || path.length > MAX_PATH_CHARS || hasControlCharacter(path))
    throw new Error("invalid-integration-path");
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_INTEGRATION_BYTES)
    throw new Error("invalid-integration-file");
  const source = await fs.readFile(path, "utf8");
  const markers = source
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*(?:\/\/|#)\s*/u, "").trim());
  if (
    !source.includes("installed by herdr") ||
    !markers.includes(`HERDR_INTEGRATION_ID=${runtime}`) ||
    !markers.includes(
      `HERDR_INTEGRATION_VERSION=${HERDR_080_INTEGRATION_VERSIONS[runtime].toString()}`,
    )
  )
    throw new Error("integration-marker-mismatch");
};

const fixedEnvironmentCommand = (
  environment: NodeJS.ProcessEnv,
  topology: { readonly paneId: string; readonly tabId: string; readonly workspaceId: string },
  readyMarker: string,
  fixedOverrides: Readonly<Record<string, string>> = {},
): string => {
  const fixed = {
    ...Object.fromEntries(
      SAFE_ENVIRONMENT_KEYS.flatMap((key) =>
        environment[key] === undefined ? [] : [[key, environment[key]]],
      ),
    ),
    ...fixedOverrides,
    HERDR_ENV: "1",
    HERDR_PANE_ID: topology.paneId,
    HERDR_TAB_ID: topology.tabId,
    HERDR_WORKSPACE_ID: topology.workspaceId,
    PI_SUBAGENT_CHILD: "1",
  };
  // SAFETY: These keys and values come directly from the same typed owner object enumerated on this path.
  const assignments = Object.entries(fixed)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${shellQuote(value as string)}`)
    .join(" ");
  // The first shell receives no user startup files. Its marker proves the env -i transition ran
  // before it replaces itself with the interactive shell used by `agent start`.
  const bootstrap = `${printMarkerCommand(readyMarker)}; exec /bin/sh`;
  return `exec /usr/bin/env -i ${assignments} /bin/sh -c ${shellQuote(bootstrap)}`;
};

const claudeArgv = (
  request: BackendLaunchRequest,
  settingsPath: string,
  mcpPath: string,
  promptPath: string,
): ReadonlyArray<string> => {
  const tools = request.writeIntent === "writer" ? CLAUDE_WRITE_TOOLS : CLAUDE_READ_TOOLS;
  const writerPolicy = claudeWriterCwdPolicy(request.cwd);
  const allowed = claudeAllowedTools(request.writeIntent, writerPolicy);
  return [
    "--name",
    request.name,
    "--model",
    request.model,
    "--effort",
    request.effort,
    "--no-chrome",
    "--disable-slash-commands",
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
    "--system-prompt-file",
    promptPath,
  ];
};

const piArgv = (
  request: BackendLaunchRequest,
  sessionDirectory: string,
  integration: string,
  supervisorConfig: string,
  promptPath: string,
): ReadonlyArray<string> => {
  const tools = [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    ...(request.writeIntent === "writer" ? ["edit", "write"] : []),
    ...PI_SUPERVISOR_TOOLS,
  ];
  return [
    "--name",
    request.name,
    "--model",
    request.model,
    "--thinking",
    request.effort,
    ...(request.fastMode ? ["--pi-subagents-fast-mode"] : []),
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
    ORCHESTRATION_TOOL_DENYLIST_ARGUMENT,
    "--append-system-prompt",
    promptPath,
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
    ...(request.fastMode ? [`service_tier = ${tomlString(SUBAGENT_FAST_SERVICE_TIER)}`] : []),
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
    ...CODEX_DISABLED_FEATURES.map(
      (feature) => `${feature} = ${feature === "fast_mode" && request.fastMode}`,
    ),
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
  "-c",
  `model_reasoning_effort=${tomlString(request.effort)}`,
  ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
  CODEX_BOOTSTRAP_PROMPT,
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
  if (Object.values(environment).some((value) => value && hasControlCharacter(value)))
    throw new Error("herdr-environment-invalid");
  if ((options.platform ?? process.platform) === "win32")
    throw new Error("herdr-platform-unsupported");
  const agentDirectory = await safeAgentDirectory(options.agentDirectory);
  const packageRoot = join(agentDirectory, "subagents");
  const root = join(packageRoot, HARNESS_ROOT);
  await ensurePrivateDirectory(packageRoot);
  await ensurePrivateDirectory(root);
  const nonce = randomBytes(12).toString("hex");
  const directory = join(root, `${runtime}-${request.runId}-${nonce}`);
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
    const environmentReadyMarker = `pi-subagents-env-${nonce}`;
    const secretReadyMarker = `pi-subagents-secret-${nonce}`;
    const environmentCommand = (topology: {
      readonly paneId: string;
      readonly tabId: string;
      readonly workspaceId: string;
    }) => fixedEnvironmentCommand(environment, topology, environmentReadyMarker);
    const activationProbe = (attempt: number) => {
      const marker = `pi-subagents-activate-${nonce}-${attempt.toString()}`;
      return { command: printMarkerCommand(marker), marker };
    };
    const shellReadinessProbe = (phase: "environment" | "secrets") => {
      const marker = `pi-subagents-shell-${phase}-${nonce}`;
      return { command: printMarkerCommand(marker), marker };
    };
    const promptPath = join(directory, "system-prompt.md");
    await writeExclusive(promptPath, request.systemPrompt);

    if (runtime === "claude") {
      const settingsPath = join(directory, "claude-settings.json");
      const mcpPath = join(directory, "claude-mcp.json");
      const base = claudeSettings(request, claudeWriterCwdPolicy(request.cwd));
      const settings = {
        ...base,
        // Herdr Claude remains authenticated through the inherited native credential boundary.
        // Its fixed process environment disables interactive transcript and prompt-history writes.
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
        argv: controlFreeArgv(claudeArgv(request, settingsPath, mcpPath, promptPath)),
        environmentCommand: (topology) =>
          fixedEnvironmentCommand(environment, topology, environmentReadyMarker, {
            CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
          }),
        environmentReadyMarker,
        activationProbe,
        shellReadinessProbe,
      });
    }

    if (runtime === "pi") {
      const sessionDirectory = join(directory, "pi-sessions");
      await fs.mkdir(sessionDirectory, { mode: 0o700 });
      const secretPath = join(directory, "pi-environment.sh");
      const provider = request.model.slice(0, request.model.indexOf("/"));
      const secretSource = [
        request.runtimeApiKey
          ? `export PI_SUBAGENT_RUNTIME_API_KEY=${shellQuote(Redacted.value(request.runtimeApiKey))}`
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
        argv: controlFreeArgv(
          piArgv(
            request,
            sessionDirectory,
            integration,
            supervisor.connectionConfigPath,
            promptPath,
          ),
        ),
        environmentCommand,
        environmentReadyMarker,
        activationProbe,
        shellReadinessProbe,
        secretCommand: `. ${shellQuote(secretPath)} && ${printMarkerCommand(secretReadyMarker)}`,
        secretReadyMarker,
      });
    }

    const codexHome = join(directory, "codex-home");
    await fs.mkdir(codexHome, { mode: 0o700 });
    const auth = await readValidatedCodexAuth(environment);
    const apiKey = approvedApiKey(environment);
    if (auth) await writeExclusive(join(codexHome, "auth.json"), auth);
    else if (!apiKey) throw new Error("codex-auth-unavailable");
    if (options.harnessFault === "after-codex-auth") throw new Error("fixture-after-codex-auth");
    const sessionHook = fileURLToPath(new URL("./herdr-codex-session-hook.mjs", import.meta.url));
    const fallbackTranscript = join(directory, "codex-session-anchor.jsonl");
    await writeExclusive(fallbackTranscript, "\n");
    const hookCommand = [
      shellQuote(process.execPath),
      shellQuote(sessionHook),
      shellQuote(integration),
      shellQuote(fallbackTranscript),
    ].join(" ");
    const hooksPath = join(codexHome, "hooks.json");
    const configPath = join(codexHome, "config.toml");
    const hooks = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [{ type: "command", command: hookCommand, timeout: 10 }],
          },
        ],
      },
    };
    await writeExclusive(hooksPath, `${JSON.stringify(hooks)}\n`);
    await writeExclusive(configPath, codexConfig(request, supervisor, integration));
    await Effect.runPromise(
      options.codexHooks!.establishTrust({
        codexHome,
        configPath,
        hooksPath,
        cwd: request.cwd,
        command: hookCommand,
      }),
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
      argv: controlFreeArgv(codexArgv(request)),
      environmentCommand,
      environmentReadyMarker,
      activationProbe,
      shellReadinessProbe,
      secretCommand: `. ${shellQuote(secretPath)} && ${printMarkerCommand(secretReadyMarker)}`,
      secretReadyMarker,
    });
  } catch (error) {
    if (isHerdrCodexHooksError(error) && error.code === "codex_herdr_hook_cleanup_unconfirmed")
      throw harnessCleanupUnconfirmed(error);
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

export const makeHerdrHarness = (options: HerdrHarnessLayerOptions): HerdrHarnessContract => {
  // Select and sanitize inherited auth/session inputs exactly once for this session service.
  const fixedOptions: HerdrHarnessLayerOptions = Object.freeze(
    (() => {
      const environment = harnessEnvironment(options.environment ?? process.env);
      const baseResult = {
        ...options,
        environment,
        codexHooks: options.codexHooks ?? makeHerdrCodexHooks({ environment }),
      };
      const withIntegrationPaths = options.integrationPaths
        ? { ...baseResult, integrationPaths: Object.freeze({ ...options.integrationPaths }) }
        : baseResult;
      return withIntegrationPaths;
    })(),
  );
  // SAFETY: These keys and values come directly from the same typed owner object enumerated on this path.
  return {
    preflight: (runtime, request) =>
      Effect.gen(function* () {
        if (
          Object.values(fixedOptions.environment ?? {}).some(
            (value) => value && hasControlCharacter(value),
          )
        )
          return yield* readinessError(
            "herdr_environment_invalid",
            "The bounded inherited Herdr harness environment contains unsupported control characters.",
          );
        if ((fixedOptions.platform ?? process.platform) === "win32")
          return yield* readinessError(
            "herdr_platform_unsupported",
            "The private Herdr subagent harness currently requires POSIX env, shell, and lifecycle-integration semantics; Windows candidates are rejected before topology ownership.",
          );
        if (
          runtime === "claude" &&
          !(["darwin", "linux"] as ReadonlyArray<NodeJS.Platform>).includes(
            fixedOptions.platform ?? process.platform,
          )
        )
          return yield* readinessError(
            "claude_shell_confinement_unsupported",
            "Herdr Claude subagents require a current supported strict Bash sandbox platform.",
          );
        if (!isSafeNativeModelSelector(request.model))
          return yield* readinessError(
            `${runtime}_model_unsupported`,
            `${runtime} model selector is empty, excessive, or unsafe.`,
          );
        const efforts = subagentRuntimeEfforts(runtime);
        if (!efforts.includes(request.effort))
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
          const sessionHook = fileURLToPath(
            new URL("./herdr-codex-session-hook.mjs", import.meta.url),
          );
          yield* Effect.tryPromise({
            try: async () => {
              const stat = await fs.lstat(sessionHook);
              if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1)
                throw new Error("missing-codex-session-hook");
            },
            catch: () =>
              readinessError(
                "codex_herdr_hook_unavailable",
                "The packaged private Codex Herdr SessionStart hook is unavailable.",
              ),
          });
          const auth = yield* Effect.promise(() => readValidatedCodexAuth(environment));
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
                : isHerdrCodexHooksError(error)
                  ? error.code
                  : "herdr_harness_prepare_failed",
              isHarnessCleanupUnconfirmed(error)
                ? `Private ${runtime} Herdr harness cleanup could not be confirmed; its state remains quarantined.`
                : isHerdrCodexHooksError(error)
                  ? "Codex could not trust and verify the exact private Herdr SessionStart hook before topology creation."
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

export class HerdrHarness extends Context.Service<HerdrHarness, HerdrHarnessContract>()(
  "pi-subagents/boundary/herdr-harness/HerdrHarness",
) {
  static readonly layer = (options: HerdrHarnessLayerOptions): Layer.Layer<HerdrHarness> =>
    Layer.succeed(this, makeHerdrHarness(options));
}
