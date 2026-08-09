// Local Claude/Codex process, private harness, auth-copy, and environment ownership live here.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/cryptoRandomBytes:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type {
  CodexInitializedNotification,
  CodexRequest,
} from "../backend/local-codex-protocol.ts";
import type {
  ClaudeControlRequestFrame,
  ClaudeUserFrame,
} from "../backend/local-claude-protocol.ts";
import type { BackendLaunchRequest } from "../backend/model.ts";
import { InvalidSubagentRequestError, SubagentProcessError } from "../run/errors.ts";
import {
  subagentRuntimeEfforts,
  type SubagentRuntime,
  type SubagentWriteIntent,
} from "../run/model.ts";
import { isSafeNativeModelSelector } from "../run/native-model-selector.ts";
import { claudeWriterCwdPolicy } from "./claude-writer-policy.ts";
import type { SupervisorConnectionMetadata } from "./supervisor-channel.ts";
import { attachBoundedLineParser, makeByteBoundedQueueRoom } from "./bounded-line-parser.ts";
import { releaseChildProcess } from "./child-process.ts";
import { terminateProcessTree } from "./process-tree.ts";

const HARNESS_ROOT = "local-cli-v1";
const CATALOG_HARNESS_ROOT = "native-model-catalog-v1";
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const MAX_PROBE_OUTPUT_BYTES = 32 * 1024;
const MAX_AUTH_BYTES = 64 * 1024;
const MAX_PATH_CHARS = 4_096;
const EVENT_CAPACITY = 512;
const WRITE_TIMEOUT = "10 seconds";
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
const SUPERVISOR_TOOLS = [
  "mcp__pi_subagents_supervisor__supervisor_progress",
  "mcp__pi_subagents_supervisor__supervisor_warning",
  "mcp__pi_subagents_supervisor__supervisor_question",
  "mcp__pi_subagents_supervisor__supervisor_submit_report",
] as const;
const CLAUDE_INSPECTION_TOOLS = [
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
  "WebSearch",
  ...SUPERVISOR_TOOLS,
];
const CLAUDE_READ_TOOLS = ["Bash", ...CLAUDE_INSPECTION_TOOLS];
const CLAUDE_WRITE_TOOLS = ["Bash", "Edit", ...CLAUDE_INSPECTION_TOOLS];
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

export type LocalCliRuntime = Extract<SubagentRuntime, "claude" | "codex">;

export type LocalCliWireEvent =
  | { readonly type: "message"; readonly value: unknown }
  | { readonly type: "protocol_error"; readonly message: string }
  | {
      readonly type: "exit";
      readonly exitCode: number | null;
      readonly signal?: string | undefined;
      readonly stderr: string;
    };

export type LocalCliOutboundFrame =
  | ClaudeUserFrame
  | ClaudeControlRequestFrame
  | CodexRequest
  | CodexInitializedNotification;

export interface LocalCliHandle {
  readonly pid: number;
  readonly events: Queue.Dequeue<LocalCliWireEvent, Cause.Done>;
  readonly awaitExit: Effect.Effect<
    Extract<LocalCliWireEvent, { readonly type: "exit" }>,
    SubagentProcessError
  >;
  readonly send: (value: LocalCliOutboundFrame) => Effect.Effect<void, SubagentProcessError>;
  readonly acknowledge: (event: LocalCliWireEvent) => void;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, SubagentProcessError>;
}

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
  readonly effort: import("../run/model.ts").SubagentEffort;
  /** Canonical assigned cwd when available. Required for local Claude writers. */
  readonly cwd?: string | undefined;
}

export interface LocalCliProcessShape {
  readonly preflight: (
    request: LocalCliPreflightRequest,
  ) => Effect.Effect<void, InvalidSubagentRequestError>;
  readonly spawn: (
    request: LocalCliSpawnRequest,
  ) => Effect.Effect<LocalCliHandle, SubagentProcessError, Scope.Scope>;
}

export interface LocalCliProcessLayerOptions {
  readonly agentDirectory: string;
  /** Package-test seam only. Production always uses the fixed executable names. */
  readonly executables?: { readonly claude: string; readonly codex: string } | undefined;
  /** Package-test seam only. */
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Package-test seam only. */
  readonly platform?: NodeJS.Platform | undefined;
  /** Package-test seam only: fail after a sensitive harness file was published. */
  readonly harnessFault?: "after-claude-settings" | "after-codex-auth" | undefined;
  /** Package-test seam only: model an unconfirmable partial-harness cleanup. */
  readonly harnessCleanupFault?: boolean | undefined;
}

interface Harness {
  readonly directory: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

const processError = (operation: string, error?: unknown, code?: string) =>
  new SubagentProcessError({
    operation,
    message:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : `Unable to ${operation} local CLI process.`,
    ...(code ? { code } : {}),
  });

const preflightError = (code: string, message: string) =>
  new InvalidSubagentRequestError({ code, message });

const nodeErrorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const boundedAppend = (current: string, chunk: Buffer, maximum: number): string => {
  const next = Buffer.concat([Buffer.from(current, "utf8"), chunk]);
  return next.subarray(Math.max(0, next.length - maximum)).toString("utf8");
};

const approvedCodexApiKey = (source: NodeJS.ProcessEnv): string | undefined => {
  const apiKey = source.OPENAI_API_KEY;
  return typeof apiKey === "string" &&
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
  runtime: LocalCliRuntime,
  launch?: BackendLaunchRequest,
): NodeJS.ProcessEnv => {
  const codexApiKey = runtime === "codex" ? approvedCodexApiKey(source) : undefined;
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(
        ([key, value]) => value !== undefined && SAFE_ENV_KEYS.has(key),
      ),
    ),
    ...(codexApiKey ? { OPENAI_API_KEY: codexApiKey } : {}),
    ...(launch
      ? {
          PI_SUBAGENT_CHILD: "1",
          PI_SUBAGENT_PARENT_SESSION: launch.parentSessionId,
          PI_SUBAGENT_RUN_ID: launch.runId,
        }
      : {}),
  };
};

const claudeAllowedTools = (launch: BackendLaunchRequest): ReadonlyArray<string> => {
  const writerPolicy = claudeWriterCwdPolicy(launch.cwd);
  return launch.writeIntent === "writer" && writerPolicy
    ? [...CLAUDE_INSPECTION_TOOLS, writerPolicy.scopedEditRule]
    : CLAUDE_INSPECTION_TOOLS;
};

export interface ClaudePermissionSettings {
  readonly defaultMode: "dontAsk";
  readonly allow: ReadonlyArray<string>;
  readonly deny: ReadonlyArray<string>;
}

export interface ClaudeSandboxFilesystemSettings {
  readonly allowWrite: ReadonlyArray<string>;
  readonly denyWrite: ReadonlyArray<string>;
}

export interface ClaudeSandboxNetworkSettings {
  readonly allowedDomains: ReadonlyArray<string>;
  readonly strictAllowlist: true;
  readonly allowUnixSockets: ReadonlyArray<string>;
  readonly allowAllUnixSockets: false;
  readonly allowLocalBinding: false;
}

export interface ClaudeSandboxSettings {
  readonly enabled: true;
  readonly autoAllowBashIfSandboxed: true;
  readonly failIfUnavailable: true;
  readonly allowUnsandboxedCommands: false;
  readonly filesystem: ClaudeSandboxFilesystemSettings;
  readonly network: ClaudeSandboxNetworkSettings;
}

export interface ClaudeSettings {
  readonly permissions: ClaudePermissionSettings;
  readonly sandbox: ClaudeSandboxSettings;
  readonly enableAllProjectMcpServers: false;
}

export const claudeSettings = (launch: BackendLaunchRequest): ClaudeSettings => {
  const writerPolicy = claudeWriterCwdPolicy(launch.cwd);
  return {
    permissions: {
      defaultMode: "dontAsk",
      allow: claudeAllowedTools(launch),
      deny: CLAUDE_DENIED_TOOLS,
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: launch.writeIntent === "writer" && writerPolicy ? [writerPolicy.cwd] : [],
        denyWrite: launch.writeIntent === "read-only" ? [launch.cwd] : [],
      },
      network: {
        allowedDomains: [],
        strictAllowlist: true,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
    },
    enableAllProjectMcpServers: false,
  };
};

export const claudeArgv = (
  launch: BackendLaunchRequest,
  harness: { readonly settingsPath: string; readonly mcpPath: string; readonly promptPath: string },
): ReadonlyArray<string> => {
  const tools = launch.writeIntent === "writer" ? CLAUDE_WRITE_TOOLS : CLAUDE_READ_TOOLS;
  const allowedTools = claudeAllowedTools(launch);
  return [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--model",
    launch.model,
    "--effort",
    launch.effort,
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--settings",
    harness.settingsPath,
    "--strict-mcp-config",
    "--mcp-config",
    harness.mcpPath,
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools.join(","),
    "--allowedTools",
    allowedTools.join(","),
    "--disallowedTools",
    CLAUDE_DENIED_TOOLS.join(","),
    "--system-prompt-file",
    harness.promptPath,
  ];
};

export const codexArgv = (): ReadonlyArray<string> => ["app-server", "--stdio", "--strict-config"];

const codexBaseConfig = (fastMode = false): ReadonlyArray<string> => [
  'approval_policy = "never"',
  'web_search = "disabled"',
  "[analytics]",
  "enabled = false",
  "[shell_environment_policy]",
  'inherit = "core"',
  'exclude = ["OPENAI_API_KEY", "CODEX_HOME", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_RUN_ID"]',
  "[features]",
  "apps = false",
  "auth_elicitation = false",
  "browser_use = false",
  "computer_use = false",
  `fast_mode = ${fastMode}`,
  "goals = false",
  "guardian_approval = false",
  "hooks = false",
  "image_generation = false",
  "in_app_browser = false",
  "memories = false",
  "multi_agent = false",
  "plugins = false",
  "remote_plugin = false",
  "skill_search = false",
  "standalone_web_search = false",
  "tool_suggest = false",
  "workspace_dependencies = false",
];

const codexConfig = (supervisor: SupervisorConnectionMetadata, fastMode: boolean): string =>
  [...codexBaseConfig(fastMode), supervisor.codexMcp.tomlFragment, ""].join("\n");

const codexCatalogConfig = (): string => [...codexBaseConfig(), ""].join("\n");

const safeAgentDirectory = async (agentDirectory: string): Promise<string> => {
  if (
    !isAbsolute(agentDirectory) ||
    agentDirectory.length < 1 ||
    agentDirectory.length > MAX_PATH_CHARS ||
    agentDirectory.includes("\0")
  )
    throw new Error("invalid-agent-directory");
  const requested = resolve(agentDirectory);
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
    if (nodeErrorCode(error) !== "EEXIST") throw error;
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

const safeCodexSourceHome = async (
  sourceEnvironment: NodeJS.ProcessEnv,
): Promise<string | undefined> => {
  const configured = sourceEnvironment.CODEX_HOME;
  const source =
    configured === undefined ? join(sourceEnvironment.HOME || homedir(), ".codex") : configured;
  if (
    !isAbsolute(source) ||
    source.length < 1 ||
    source.length > MAX_PATH_CHARS ||
    source.includes("\0") ||
    source.includes("\r") ||
    source.includes("\n")
  )
    return undefined;
  try {
    const requested = resolve(source);
    const requestedStat = await fs.lstat(requested);
    if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) return undefined;
    const canonical = await fs.realpath(requested);
    const canonicalStat = await fs.lstat(canonical);
    if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
};

const readValidatedCodexAuthFromHome = async (sourceHome: string): Promise<string | undefined> => {
  const path = join(sourceHome, "auth.json");
  let bytes: Buffer;
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 1 || stat.size > MAX_AUTH_BYTES)
      return undefined;
    bytes = await fs.readFile(path);
  } catch {
    return undefined;
  }
  if (bytes.length <= 1 || bytes.length > MAX_AUTH_BYTES) return undefined;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value) || !boundedJsonValue(value))
      return undefined;
    return `${JSON.stringify(value)}\n`;
  } catch {
    return undefined;
  }
};

const readValidatedCodexAuth = async (
  sourceEnvironment: NodeJS.ProcessEnv,
): Promise<string | undefined> => {
  const sourceHome = await safeCodexSourceHome(sourceEnvironment);
  return sourceHome ? readValidatedCodexAuthFromHome(sourceHome) : undefined;
};

const harnessCleanupUnconfirmed = (cause: unknown): Error & { readonly cleanupUnconfirmed: true } =>
  Object.assign(
    new Error("Partial private local CLI harness cleanup could not be confirmed.", { cause }),
    {
      cleanupUnconfirmed: true as const,
    },
  );

const isHarnessCleanupUnconfirmed = (
  error: unknown,
): error is Error & { readonly cleanupUnconfirmed: true } =>
  error instanceof Error && "cleanupUnconfirmed" in error && error.cleanupUnconfirmed === true;

const prepareHarness = async (
  options: LocalCliProcessLayerOptions,
  request: LocalCliSpawnRequest,
): Promise<Harness> => {
  const agentDirectory = await safeAgentDirectory(options.agentDirectory);
  const packageRoot = join(agentDirectory, "subagents");
  const root = join(packageRoot, HARNESS_ROOT);
  await ensurePrivateDirectory(packageRoot);
  await ensurePrivateDirectory(root);
  const directory = join(
    root,
    `${request.runtime}-${request.launch.runId}-${randomBytes(12).toString("hex")}`,
  );
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      throw new Error("unsafe-harness-directory");
    const executable = options.executables?.[request.runtime] ?? request.runtime;
    const sourceEnvironment = options.environment ?? process.env;
    const env = sanitizeLocalCliEnvironment(sourceEnvironment, request.runtime, request.launch);

    if (request.runtime === "claude") {
      const settingsPath = join(directory, "settings.json");
      const mcpPath = join(directory, "mcp.json");
      const promptPath = join(directory, "system-prompt.md");
      await writeExclusive(settingsPath, `${JSON.stringify(claudeSettings(request.launch))}\n`);
      if (options.harnessFault === "after-claude-settings")
        throw new Error("fixture-after-claude-settings");
      await writeExclusive(mcpPath, `${JSON.stringify(request.supervisor.claudeMcp)}\n`);
      await writeExclusive(promptPath, request.launch.systemPrompt);
      return {
        directory,
        executable,
        args: claudeArgv(request.launch, { settingsPath, mcpPath, promptPath }),
        env,
      };
    }

    const codexHome = join(directory, "codex-home");
    await fs.mkdir(codexHome, { mode: 0o700 });
    const config = codexConfig(request.supervisor, request.launch.fastMode);
    await writeExclusive(join(codexHome, "config.toml"), config);
    const auth = await readValidatedCodexAuth(sourceEnvironment);
    if (auth) {
      await writeExclusive(join(codexHome, "auth.json"), auth);
      if (options.harnessFault === "after-codex-auth") throw new Error("fixture-after-codex-auth");
    } else if (!approvedCodexApiKey(sourceEnvironment)) throw new Error("codex-auth-unavailable");
    return {
      directory,
      executable,
      args: codexArgv(),
      env: { ...env, CODEX_HOME: codexHome },
    };
  } catch (error) {
    try {
      if (options.harnessCleanupFault) throw new Error("fixture-harness-cleanup-failure");
      await removeHarness(directory);
    } catch {
      throw harnessCleanupUnconfirmed(error);
    }
    throw error;
  }
};

const removeHarness = async (directory: string): Promise<void> => {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe-harness-cleanup");
  await fs.rm(directory, { recursive: true, force: false });
};

export interface CodexCatalogHarness {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly release: () => Promise<void>;
}

/** Isolates model discovery from user Codex config while copying only bounded authentication. */
export const prepareCodexCatalogHarness = async (options: {
  readonly agentDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<CodexCatalogHarness> => {
  const agentDirectory = await safeAgentDirectory(options.agentDirectory);
  const packageRoot = join(agentDirectory, "subagents");
  const root = join(packageRoot, CATALOG_HARNESS_ROOT);
  await ensurePrivateDirectory(packageRoot);
  await ensurePrivateDirectory(root);
  const directory = join(root, `codex-${randomBytes(12).toString("hex")}`);
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    const codexHome = join(directory, "codex-home");
    await fs.mkdir(codexHome, { mode: 0o700 });
    await writeExclusive(join(codexHome, "config.toml"), codexCatalogConfig());
    const auth = await readValidatedCodexAuth(options.environment);
    if (auth) await writeExclusive(join(codexHome, "auth.json"), auth);
    else if (!approvedCodexApiKey(options.environment)) throw new Error("codex-auth-unavailable");
    return {
      args: codexArgv(),
      env: {
        ...sanitizeLocalCliEnvironment(options.environment, "codex"),
        CODEX_HOME: codexHome,
      },
      release: () => removeHarness(directory),
    };
  } catch (error) {
    try {
      await removeHarness(directory);
    } catch {
      throw harnessCleanupUnconfirmed(error);
    }
    throw error;
  }
};

interface ProbeResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly overflowed: boolean;
  readonly timedOut: boolean;
  readonly cleanupUnconfirmed: boolean;
}

const claudeAuthLoggedIn = (source: string): boolean => {
  try {
    const value = JSON.parse(source) as unknown;
    return (
      typeof value === "object" && value !== null && "loggedIn" in value && value.loggedIn === true
    );
  } catch {
    return false;
  }
};

const runProbe = (
  executable: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<ProbeResult> =>
  new Promise((resolveProbe) => {
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    let timedOut = false;
    let cleanupUnconfirmed = false;
    let settled = false;
    let child: NodeChildProcess;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveProbe({ code, stdout, stderr, overflowed, timedOut, cleanupUnconfirmed });
    };
    try {
      child = spawn(executable, [...args], {
        detached: process.platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      stderr = error instanceof Error ? error.message : "probe-spawn-failed";
      finish(null);
      return;
    }
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (
        Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") + chunk.length >
        MAX_PROBE_OUTPUT_BYTES
      ) {
        overflowed = true;
        void terminateProcessTree(child, "force").catch(() => undefined);
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      stderr = error.message;
      finish(null);
    });
    child.once("close", (code) => {
      void terminateProcessTree(child, "force").then(
        () => finish(code),
        () => {
          cleanupUnconfirmed = true;
          stderr = "Readiness probe cleanup could not be confirmed.";
          finish(null);
        },
      );
    });
    timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child, "force").catch(() => undefined);
      const hardStop = setTimeout(() => {
        cleanupUnconfirmed = true;
        finish(null);
      }, 1_000);
      hardStop.unref();
    }, PROBE_TIMEOUT_MILLIS);
    timer.unref();
  });

const runIsolatedCodexAuthProbe = async (
  executable: string,
  agentDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<ProbeResult> => {
  const harness = await prepareCodexCatalogHarness({ agentDirectory, environment });
  const result = await runProbe(executable, ["login", "status"], harness.env);
  try {
    await harness.release();
    return result;
  } catch {
    return {
      ...result,
      code: null,
      cleanupUnconfirmed: true,
      stderr: "Codex readiness probe private harness cleanup could not be confirmed.",
    };
  }
};

const acquireLocalCli = Effect.fn("LocalCliProcess.acquire")(function* (
  options: LocalCliProcessLayerOptions,
  request: LocalCliSpawnRequest,
) {
  const harness = yield* Effect.tryPromise({
    try: () => prepareHarness(options, request),
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
  const events = yield* Queue.dropping<LocalCliWireEvent, Cause.Done>(EVENT_CAPACITY);
  const ready = yield* Deferred.make<void, SubagentProcessError>();
  const exited = yield* Deferred.make<Extract<LocalCliWireEvent, { readonly type: "exit" }>>();
  let stderr = "";
  let settled = false;
  let spawned = false;
  let cleaned = false;
  let stdinError: Error | undefined;

  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const platform = options.platform ?? process.platform;
      const child = yield* Effect.try({
        try: () =>
          spawn(harness.executable, [...harness.args], {
            cwd: request.launch.cwd,
            detached: platform !== "win32",
            env: harness.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }),
        catch: (error) => processError("spawn local CLI", error, "local_cli_spawn_failed"),
      });
      const room = makeByteBoundedQueueRoom(events, MAX_QUEUED_BYTES, () => {
        stderr = `${stderr}\nLocal CLI event backlog exceeded ${MAX_QUEUED_BYTES} bytes.`;
        Queue.offerUnsafe(events, {
          type: "protocol_error",
          message: "Local CLI event backlog exceeded its byte budget.",
        });
        void terminateProcessTree(child, "force", { platform }).catch(() => undefined);
      });
      let queueOverflowed = false;
      const offer = (event: LocalCliWireEvent, bytes = 0) => {
        if (room.offer(event, bytes)) return;
        if (queueOverflowed) return;
        queueOverflowed = true;
        stderr = `${stderr}\nLocal CLI event queue exceeded ${EVENT_CAPACITY} pending events.`;
        void terminateProcessTree(child, "force", { platform }).catch(() => undefined);
      };
      const detachStdout = child.stdout
        ? attachBoundedLineParser(child.stdout, {
            maxLineBytes: MAX_LINE_BYTES,
            maxQueuedBytes: MAX_QUEUED_BYTES,
            onLine: (line) => {
              const bytes = Buffer.byteLength(line, "utf8") + 1;
              try {
                offer({ type: "message", value: JSON.parse(line) as unknown }, bytes);
              } catch {
                offer(
                  { type: "protocol_error", message: "Local CLI emitted malformed JSONL." },
                  bytes,
                );
              }
            },
            onOverflow: () => {
              offer({
                type: "protocol_error",
                message: "Local CLI output exceeded its bounded parser budget.",
              });
              void terminateProcessTree(child, "force", { platform }).catch(() => undefined);
            },
          })
        : () => {};
      const onStderr = (chunk: Buffer) => {
        stderr = boundedAppend(stderr, chunk, MAX_STDERR_BYTES);
      };
      const onStdoutError = (error: Error) => {
        onStderr(Buffer.from(`\nLocal CLI stdout error: ${error.message}\n`, "utf8"));
        offer({ type: "protocol_error", message: "Local CLI output stream failed." });
      };
      const onStderrError = (error: Error) => {
        onStderr(Buffer.from(`\nLocal CLI stderr error: ${error.message}\n`, "utf8"));
        offer({ type: "protocol_error", message: "Local CLI diagnostic stream failed." });
      };
      const onStdinError = (error: Error) => {
        stdinError = error;
      };
      const onSpawn = () => {
        spawned = true;
        Deferred.doneUnsafe(ready, Effect.void);
      };
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        Queue.endUnsafe(events);
        Deferred.doneUnsafe(
          exited,
          Effect.succeed({
            type: "exit",
            exitCode,
            ...(signal ? { signal } : {}),
            stderr,
          }),
        );
      };
      const onError = (error: Error) => {
        Deferred.doneUnsafe(
          ready,
          Effect.fail(processError("spawn local CLI", error, "local_cli_spawn_failed")),
        );
        if (!spawned) finish(null, null);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal);
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        detachStdout();
        child.stdout?.off("error", onStdoutError);
        child.stderr?.off("data", onStderr);
        child.stderr?.off("error", onStderrError);
        child.stdin?.off("error", onStdinError);
        child.off("spawn", onSpawn);
        child.off("error", onError);
        child.off("close", onClose);
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      child.stdout?.on("error", onStdoutError);
      child.stderr?.on("data", onStderr);
      child.stderr?.on("error", onStderrError);
      child.stdin?.on("error", onStdinError);
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("close", onClose);
      yield* Deferred.await(ready).pipe(
        Effect.onError(() =>
          Effect.tryPromise({
            try: async () => {
              cleanup();
              if (harnessOwned) {
                harnessOwned = false;
                await removeHarness(harness.directory);
              }
            },
            catch: () => processError("clean failed local CLI acquisition"),
          }).pipe(Effect.orDie),
        ),
      );
      const pid = child.pid;
      if (!pid) {
        cleanup();
        return yield* processError("spawn local CLI", "Process did not expose a pid.");
      }

      const send = (value: LocalCliOutboundFrame) =>
        Effect.callback<void, SubagentProcessError>((resumeWrite) => {
          const stdin = child.stdin;
          if (!stdin || stdin.destroyed || stdinError) {
            resumeWrite(
              Effect.fail(
                processError(
                  "send local CLI protocol frame to",
                  stdinError ?? "Local CLI input is closed.",
                  "transport_not_sent",
                ),
              ),
            );
            return;
          }
          let encoded: string;
          try {
            encoded = `${JSON.stringify(value)}\n`;
          } catch (error) {
            resumeWrite(
              Effect.fail(processError("encode local CLI frame for", error, "transport_not_sent")),
            );
            return;
          }
          if (Buffer.byteLength(encoded, "utf8") > MAX_LINE_BYTES) {
            resumeWrite(
              Effect.fail(
                processError(
                  "encode local CLI frame for",
                  "Frame exceeded limit.",
                  "transport_not_sent",
                ),
              ),
            );
            return;
          }
          stdin.write(encoded, (error) =>
            resumeWrite(
              error
                ? Effect.fail(
                    processError("send local CLI frame to", error, "transport_outcome_uncertain"),
                  )
                : Effect.void,
            ),
          );
        }).pipe(
          Effect.timeoutOption(WRITE_TIMEOUT),
          Effect.flatMap((outcome) =>
            outcome._tag === "Some"
              ? Effect.void
              : Effect.fail(
                  processError(
                    "send local CLI frame to",
                    `Transport write exceeded ${WRITE_TIMEOUT}; delivery may already have occurred.`,
                    "transport_outcome_uncertain",
                  ),
                ),
          ),
        );
      const terminate = (mode: "graceful" | "force") =>
        Effect.tryPromise({
          try: () => terminateProcessTree(child, mode, { platform }),
          catch: (error) => processError("terminate local CLI", error),
        });
      const release = releaseChildProcess({
        platform,
        requestAbort: Effect.void,
        terminate,
        awaitExit: Deferred.await(exited),
      }).pipe(
        Effect.ensuring(
          Effect.tryPromise({
            try: async () => {
              cleanup();
              if (harnessOwned) {
                harnessOwned = false;
                await removeHarness(harness.directory);
              }
            },
            catch: (error) => processError("remove private local CLI harness", error),
          }).pipe(Effect.orDie),
        ),
      );
      return {
        pid,
        events,
        awaitExit: Deferred.await(exited),
        send,
        acknowledge: room.acknowledge,
        terminate,
        release,
      };
    }),
  ).pipe(
    Effect.onError(() =>
      Effect.suspend(() => {
        if (!harnessOwned) return Effect.void;
        harnessOwned = false;
        return Effect.tryPromise({
          try: () => removeHarness(harness.directory),
          catch: (error) => processError("remove failed local CLI acquisition harness", error),
        }).pipe(Effect.orDie);
      }),
    ),
  );
});

export const makeLocalCliProcess = (
  options: LocalCliProcessLayerOptions,
): LocalCliProcessShape => ({
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
      if (
        request.runtime === "claude" &&
        !(["darwin", "linux"] as ReadonlyArray<NodeJS.Platform>).includes(
          options.platform ?? process.platform,
        )
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
      const result = yield* Effect.tryPromise({
        try: () =>
          request.runtime === "codex" && !codexApiKeyFallback
            ? runIsolatedCodexAuthProbe(executable, options.agentDirectory, environment)
            : runProbe(executable, args, probeEnvironment),
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

export class LocalCliProcess extends Context.Service<LocalCliProcess, LocalCliProcessShape>()(
  "pi-subagents/boundary/local-cli-process/LocalCliProcess",
) {
  static readonly layer = (options: LocalCliProcessLayerOptions): Layer.Layer<LocalCliProcess> =>
    Layer.succeed(this, makeLocalCliProcess(options));
}
