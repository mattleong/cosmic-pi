// Private local CLI harness/auth/config filesystem lifecycle: launch and catalog harness
// roots, sanitized environment and API-key selection, Codex config builders, failure-atomic
// prepare/remove, and the bounded isolated auth probes. This boundary owns no wire transport
// and must not import the LocalCliProcess service.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/cryptoRandomBytes:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { BackendLaunchRequest } from "../backend/model.ts";
import { claudeArgv, claudeSettings } from "../backend/claude-policy.ts";
import type { SubagentRuntime } from "../domain/routing.ts";
import { claudeWriterCwdPolicy } from "./claude-writer-cwd.ts";
import {
  ensurePrivateDirectory,
  harnessCleanupUnconfirmed,
  readValidatedCodexAuth,
  safeAgentDirectory,
  writeExclusive,
} from "./harness-shared.ts";
import type { SupervisorConnectionMetadata } from "./supervisor-channel.ts";
import { terminateProcessTree } from "./process-tree.ts";

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

export const prepareLocalCliHarness = async (
  options: LocalCliHarnessOptions,
  request: LocalCliHarnessRequest,
): Promise<LocalCliHarness> => {
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
      const writerPolicy = claudeWriterCwdPolicy(request.launch.cwd);
      await writeExclusive(
        settingsPath,
        `${JSON.stringify(claudeSettings(request.launch, writerPolicy))}\n`,
      );
      if (options.harnessFault === "after-claude-settings")
        throw new Error("fixture-after-claude-settings");
      await writeExclusive(mcpPath, `${JSON.stringify(request.supervisor.claudeMcp)}\n`);
      await writeExclusive(promptPath, request.launch.systemPrompt);
      return {
        directory,
        executable,
        args: claudeArgv(request.launch, { settingsPath, mcpPath, promptPath }, writerPolicy),
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
      await removeLocalCliHarness(directory);
    } catch {
      throw harnessCleanupUnconfirmed(error);
    }
    throw error;
  }
};

export const removeLocalCliHarness = async (directory: string): Promise<void> => {
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
      release: () => removeLocalCliHarness(directory),
    };
  } catch (error) {
    try {
      await removeLocalCliHarness(directory);
    } catch {
      throw harnessCleanupUnconfirmed(error);
    }
    throw error;
  }
};

export interface ProbeResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly overflowed: boolean;
  readonly timedOut: boolean;
  readonly cleanupUnconfirmed: boolean;
}

export const claudeAuthLoggedIn = (source: string): boolean => {
  try {
    // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
    const value = JSON.parse(source) as unknown;
    return (
      hasObjectRuntimeType(value) &&
      value !== null &&
      "loggedIn" in value &&
      value.loggedIn === true
    );
  } catch {
    return false;
  }
};

export const runProbeEffect = (
  executable: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<ProbeResult> =>
  Effect.gen(function* () {
    const done = Deferred.makeUnsafe<ProbeResult>();
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    let timedOut = false;
    let cleanupUnconfirmed = false;
    let settled = false;
    let child: NodeChildProcess;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      Deferred.doneUnsafe(
        done,
        Effect.succeed({ code, stdout, stderr, overflowed, timedOut, cleanupUnconfirmed }),
      );
    };
    const spawned = yield* Effect.exit(
      Effect.sync(() =>
        spawn(executable, [...args], {
          detached: process.platform !== "win32",
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }),
      ),
    );
    if (Exit.isFailure(spawned)) {
      // SAFETY: The only failure here is the spawn thunk's synchronous throw.
      const thrown = Cause.squash(spawned.cause);
      stderr = thrown instanceof Error ? thrown.message : "probe-spawn-failed";
      finish(null);
      return yield* Deferred.await(done);
    }
    child = spawned.value;
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
    // The deadline drives the same confirm-then-settle path; a bare timeout race would
    // abandon the probe process before its termination was confirmed.
    const deadline = yield* Effect.sleep(PROBE_TIMEOUT_MILLIS).pipe(
      Effect.andThen(() =>
        Effect.sync(() => {
          timedOut = true;
          terminateProcessTree(child, "force").then(
            () => finish(null),
            () => {
              cleanupUnconfirmed = true;
              finish(null);
            },
          );
        }),
      ),
      Effect.forkChild,
    );
    const result = yield* Deferred.await(done);
    yield* Effect.ignore(Fiber.interrupt(deadline));
    return result;
  });

export const runIsolatedCodexAuthProbe = async (
  executable: string,
  agentDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<ProbeResult> => {
  const harness = await prepareCodexCatalogHarness({ agentDirectory, environment });
  const result = await Effect.runPromise(
    runProbeEffect(executable, ["login", "status"], harness.env),
  );
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
