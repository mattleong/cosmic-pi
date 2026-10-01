import { synchronousRandomHex } from "pi-cosmic-core";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { FAST_SERVICE_TIER } from "pi-better-openai/fast-models";
import { nodeFsPromises as fs, nodePath } from "./node-builtins.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type { BackendLaunchRequest } from "../backend/model.ts";
import {
  PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_ARGUMENT,
  SUBAGENT_TOOL_NAMES,
} from "../run/tool-policy.ts";
import {
  invalidRequest as readinessError,
  processError,
  SubagentProcessError,
  type InvalidSubagentRequestError,
} from "../run/errors.ts";
import { subagentRuntimeEfforts, type SubagentRuntime } from "../domain/routing.ts";
import { SUPERVISOR_MCP_TOOL_NAMES } from "../supervisor/mcp-contract.ts";
import { isSafeNativeModelSelector } from "../profiles/model.ts";
import { claudePolicyArgv, claudeSettings } from "../backend/claude-policy.ts";
import { claudeWriterCwdPolicy } from "./claude-writer-cwd.ts";
import {
  prepareHerdrStartupAttestation,
  type HerdrStartupAttestation,
} from "./herdr-attestation.ts";
import {
  HerdrCodexHooksError,
  makeHerdrCodexHooks,
  type HerdrCodexHooksContract,
} from "./herdr-codex-hooks.ts";
import { HERDR_HARNESS_ENVIRONMENT_KEYS } from "./herdr-environment.ts";
import {
  CODEX_DISABLED_FEATURES,
  codexFeatureLines,
  ensurePrivateDirectory,
  hasControlCharacter,
  MAX_PATH_CHARS,
  pickEnvironment,
  readValidatedCodexAuth,
  removePrivateDirectory,
  safeAgentDirectory,
  shellQuote,
  tomlString,
  writeExclusive,
} from "./harness-shared.ts";
import { approvedCodexApiKey as approvedApiKey } from "./local-cli-harness.ts";
import type { SupervisorConnectionMetadata } from "./supervisor-channel.ts";

const { isAbsolute, join } = nodePath;

const HARNESS_ROOT = "herdr-host-v1";
const MAX_INTEGRATION_BYTES = 256 * 1024;
// Reviewed hooks shipped with Herdr 0.8 and 0.9. CLI preflight separately requires
// the installed hook to be current for the selected Herdr executable.
const HERDR_INTEGRATION_VERSIONS = { pi: [8], claude: [7, 9], codex: [7, 8] } satisfies Readonly<
  Record<SubagentRuntime, ReadonlyArray<number>>
>;
const CODEX_BOOTSTRAP_PROMPT =
  "Initialize the private Herdr lifecycle hook. This bootstrap turn must stop before inference.";
const PI_SUPERVISOR_EXTENSION = fileURLToPath(
  new URL("./host-pi-supervisor-extension.ts", import.meta.url),
);
const CODEX_SESSION_HOOK = fileURLToPath(
  new URL("./herdr-codex-session-hook.mjs", import.meta.url),
);

export interface HerdrPreparedHarness {
  readonly directory: string;
  readonly argv: ReadonlyArray<string>;
  readonly environmentCommand: (topology: {
    readonly paneId: string;
    readonly tabId: string;
    readonly workspaceId: string;
  }) => string;
  readonly startupAttestation: HerdrStartupAttestation;
  readonly secretCommand?: string | undefined;
  readonly withholdCleanup: () => void;
  readonly authorizeCleanup: () => void;
}

export interface HerdrHarnessContract {
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
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly integrationPaths?: Partial<Record<SubagentRuntime, string>> | undefined;
  readonly harnessFault?: "after-claude-settings" | undefined;
  readonly harnessCleanupFault?: boolean | undefined;
  readonly codexHooks?: HerdrCodexHooksContract | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

const controlFreeArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (argv.some(hasControlCharacter)) throw new Error("herdr-agent-argument-invalid");
  return argv;
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

const validateIntegration = (path: string, runtime: SubagentRuntime): Promise<void> => {
  if (!isAbsolute(path) || path.length > MAX_PATH_CHARS || hasControlCharacter(path))
    return Promise.reject(new Error("invalid-integration-path"));
  return fs
    .lstat(path)
    .then((stat) => {
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size < 1 ||
        stat.size > MAX_INTEGRATION_BYTES
      )
        throw new Error("invalid-integration-file");
      return fs.readFile(path, "utf8");
    })
    .then((source) => {
      const markers = source
        .split(/\r?\n/u)
        .map((line) => line.replace(/^\s*(?:\/\/|#)\s*/u, "").trim());
      if (
        !source.includes("installed by herdr") ||
        !markers.includes(`HERDR_INTEGRATION_ID=${runtime}`) ||
        !HERDR_INTEGRATION_VERSIONS[runtime].some((version) =>
          markers.includes(`HERDR_INTEGRATION_VERSION=${version.toString()}`),
        )
      )
        throw new Error("integration-marker-mismatch");
    });
};

const fixedEnvironmentCommand = (
  environment: NodeJS.ProcessEnv,
  topology: { readonly paneId: string; readonly tabId: string; readonly workspaceId: string },
  environmentReceiptCommand: string,
  fixedOverrides: Readonly<Record<string, string>> = {},
): string => {
  const fixed = {
    ...pickEnvironment(environment, HERDR_HARNESS_ENVIRONMENT_KEYS),
    ...fixedOverrides,
    HERDR_ENV: "1",
    HERDR_PANE_ID: topology.paneId,
    HERDR_TAB_ID: topology.tabId,
    HERDR_WORKSPACE_ID: topology.workspaceId,
    PI_SUBAGENT_CHILD: "1",
  };
  // SAFETY: The filter proves every value is a string from the typed environment map above.
  const assignments = Object.entries(fixed)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${shellQuote(value as string)}`)
    .join(" ");
  const bootstrap = `${environmentReceiptCommand} && exec /bin/sh`;
  return `exec /usr/bin/env -i ${assignments} /bin/sh -c ${shellQuote(bootstrap)}`;
};

const piArgv = (
  request: BackendLaunchRequest,
  sessionDirectory: string,
  integration: string,
  supervisorConfig: string,
  promptPath: string,
): ReadonlyArray<string> => {
  const tools = [
    ...new Set([...request.activeTools, ...SUPERVISOR_MCP_TOOL_NAMES, ...SUBAGENT_TOOL_NAMES]),
  ];
  return [
    "--name",
    request.name,
    "--model",
    request.model,
    "--thinking",
    request.effort,
    ...(request.openaiFastMode ? ["--pi-subagents-fast-mode"] : []),
    "--session-dir",
    sessionDirectory,
    request.projectTrusted ? "--approve" : "--no-approve",
    "--extension",
    integration,
    "--extension",
    PI_SUPERVISOR_EXTENSION,
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--tools",
    tools.join(","),
    "--exclude-tools",
    PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_ARGUMENT,
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
    ...(request.openaiFastMode ? [`service_tier = ${tomlString(FAST_SERVICE_TIER)}`] : []),
    'web_search = "disabled"',
    "allow_login_shell = false",
    "check_for_update_on_startup = false",
    "[analytics]",
    "enabled = false",
    "[agents]",
    "enabled = true",
    "[shell_environment_policy]",
    'inherit = "none"',
    ...codexFeatureLines(request.openaiFastMode, true),
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
  readonly cleanupAllowed: () => boolean;
}

const prepareStageError = () =>
  processError(
    "prepare Herdr harness",
    "herdr_harness_prepare_failed",
    "Unable to prepare the private Herdr harness.",
  );
const cleanupError = () =>
  processError(
    "remove Herdr harness",
    "herdr_harness_cleanup_unconfirmed",
    "Private Herdr harness cleanup could not be confirmed.",
  );
const defectReason = <Error>(reason: Cause.Reason<Error>): Cause.Reason<never> =>
  Cause.isFailReason(reason) ? Cause.makeDieReason(reason.error) : reason;
export const defectCause = <Error>(cause: Cause.Cause<Error>): Cause.Cause<never> =>
  Cause.fromReasons(cause.reasons.map(defectReason));
const attemptPromise = <Value>(
  attempt: () => Promise<Value>,
): Effect.Effect<Value, SubagentProcessError> =>
  Effect.tryPromise({ try: attempt, catch: prepareStageError });
const ownedMutation = <Value>(
  attempt: () => Promise<Value>,
): Effect.Effect<Value, SubagentProcessError> =>
  attemptPromise(attempt).pipe(Effect.uninterruptible);
const removeOwnedHarness = (options: HerdrHarnessLayerOptions, directory: string) =>
  Effect.suspend(() =>
    options.harnessCleanupFault
      ? Effect.fail(prepareStageError())
      : attemptPromise(() => removePrivateDirectory(directory)),
  );
const prepareHarness = (
  options: HerdrHarnessLayerOptions,
  runtime: SubagentRuntime,
  request: BackendLaunchRequest,
  supervisor: SupervisorConnectionMetadata,
): Effect.Effect<PreparedHarnessResource, SubagentProcessError | HerdrCodexHooksError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const environment = options.environment ?? process.env;
      if (Object.values(environment).some((value) => value && hasControlCharacter(value)))
        return yield* prepareStageError();
      if ((options.platform ?? process.platform) === "win32") return yield* prepareStageError();

      const agentDirectory = yield* restore(
        attemptPromise(() => safeAgentDirectory(options.agentDirectory)),
      );
      const packageRoot = join(agentDirectory, "subagents");
      const root = join(packageRoot, HARNESS_ROOT);
      yield* restore(attemptPromise(() => ensurePrivateDirectory(packageRoot)));
      yield* restore(attemptPromise(() => ensurePrivateDirectory(root)));
      const nonce = synchronousRandomHex(12);
      const directory = join(root, `${runtime}-${request.runId}-${nonce}`);
      yield* attemptPromise(() => fs.mkdir(directory, { mode: 0o700 }));

      const failOwned = (original: Cause.Cause<SubagentProcessError | HerdrCodexHooksError>) => {
        if (
          original.reasons.some(
            (reason) =>
              Cause.isFailReason(reason) &&
              reason.error instanceof HerdrCodexHooksError &&
              reason.error.code === "codex_herdr_hook_cleanup_unconfirmed",
          )
        )
          return Effect.failCause(original);
        return removeOwnedHarness(options, directory).pipe(
          Effect.uninterruptible,
          Effect.catchCause((cleanupFailure) =>
            Effect.failCause(
              Cause.fromReasons([
                ...Cause.fail(cleanupError()).reasons,
                ...cleanupFailure.reasons,
                ...original.reasons,
              ]),
            ),
          ),
          Effect.andThen(Effect.failCause(original)),
        );
      };
      let cleanupAllowed = true;
      const withholdCleanup = () => void (cleanupAllowed = false);
      const authorizeCleanup = () => void (cleanupAllowed = true);
      const integration = integrationPath(options, runtime, agentDirectory, environment);
      const startupAttestation = yield* restore(
        attemptPromise(() => prepareHerdrStartupAttestation(directory)),
      ).pipe(Effect.catchCause(failOwned));
      const promptPath = join(directory, "system-prompt.md");
      const write = (path: string, source: string) =>
        ownedMutation(() => writeExclusive(path, source));
      const complete = (
        argv: ReadonlyArray<string>,
        secretCommand?: string,
        extraEnvironment: Readonly<Record<string, string>> = {},
      ): PreparedHarnessResource => {
        const harness = {
          directory,
          argv: controlFreeArgv(argv),
          environmentCommand: (topology: Parameters<typeof fixedEnvironmentCommand>[1]) =>
            fixedEnvironmentCommand(
              environment,
              topology,
              startupAttestation.environmentReadyReceipt.command,
              {
                PI_SUBAGENT_PARENT_SESSION: request.parentSessionId,
                PI_SUBAGENT_RUN_ID: request.runId,
                ...extraEnvironment,
              },
            ),
          startupAttestation,
          withholdCleanup,
          authorizeCleanup,
        };
        return {
          harness: secretCommand === undefined ? harness : { ...harness, secretCommand },
          cleanupAllowed: () => cleanupAllowed,
        };
      };

      const buildClaude = Effect.gen(function* () {
        const settingsPath = join(directory, "claude-settings.json");
        const mcpPath = join(directory, "claude-mcp.json");
        const writerPolicy = claudeWriterCwdPolicy(request.cwd);
        const settings = {
          ...claudeSettings(request, writerPolicy),
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
        yield* ownedMutation(() => writeExclusive(settingsPath, `${JSON.stringify(settings)}\n`));
        if (options.harnessFault === "after-claude-settings") return yield* prepareStageError();
        yield* ownedMutation(() =>
          writeExclusive(mcpPath, `${JSON.stringify(supervisor.claudeMcp)}\n`),
        );
        return complete(
          [
            "--name",
            request.name,
            ...claudePolicyArgv(request, { settingsPath, mcpPath, promptPath }, writerPolicy),
          ],
          undefined,
          { CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" },
        );
      });

      const buildPi = Effect.gen(function* () {
        const sessionDirectory = join(directory, "pi-sessions");
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
        yield* ownedMutation(() => fs.mkdir(sessionDirectory, { mode: 0o700 }));
        yield* write(secretPath, secretSource);
        return complete(
          piArgv(
            request,
            sessionDirectory,
            integration,
            supervisor.connectionConfigPath,
            promptPath,
          ),
          `. ${shellQuote(secretPath)} && ${startupAttestation.secretReadyReceipt.command}`,
        );
      });

      const buildCodex = Effect.gen(function* () {
        const codexHome = join(directory, "codex-home");
        yield* ownedMutation(() => fs.mkdir(codexHome, { mode: 0o700 }));
        const auth = yield* attemptPromise(() => readValidatedCodexAuth(environment));
        const apiKey = approvedApiKey(environment);
        if (auth) yield* write(join(codexHome, "auth.json"), auth);
        else if (!apiKey) return yield* prepareStageError();

        const fallbackTranscript = join(directory, "codex-session-anchor.jsonl");
        const hookCommand = [
          shellQuote(process.execPath),
          shellQuote(CODEX_SESSION_HOOK),
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
        const secretPath = join(directory, "codex-environment.sh");
        yield* write(fallbackTranscript, "\n");
        yield* ownedMutation(() => writeExclusive(hooksPath, `${JSON.stringify(hooks)}\n`));
        yield* write(configPath, codexConfig(request, supervisor, integration));
        yield* options.codexHooks!.establishTrust({
          codexHome,
          configPath,
          hooksPath,
          cwd: request.cwd,
          command: hookCommand,
        });
        yield* write(
          secretPath,
          [
            `export CODEX_HOME=${shellQuote(codexHome)}`,
            apiKey ? `export OPENAI_API_KEY=${shellQuote(apiKey)}` : "unset OPENAI_API_KEY",
            "",
          ].join("\n"),
        );
        return complete(
          codexArgv(request),
          `. ${shellQuote(secretPath)} && ${startupAttestation.secretReadyReceipt.command}`,
        );
      });

      const build = Effect.gen(function* () {
        yield* attemptPromise(() => validateIntegration(integration, runtime));
        yield* write(promptPath, request.systemPrompt);
        return yield* runtime === "claude" ? buildClaude : runtime === "pi" ? buildPi : buildCodex;
      });

      return yield* restore(build).pipe(Effect.catchCause(failOwned));
    }),
  );
const readinessPromise = <Value>(
  attempt: () => Promise<Value>,
  failure: InvalidSubagentRequestError,
): Effect.Effect<Value, InvalidSubagentRequestError> =>
  Effect.tryPromise({ try: attempt, catch: () => failure });

export const makeHerdrHarness = (options: HerdrHarnessLayerOptions): HerdrHarnessContract => {
  const environment = pickEnvironment(options.environment ?? process.env, [
    ...HERDR_HARNESS_ENVIRONMENT_KEYS,
    "CODEX_HOME",
    "OPENAI_API_KEY",
  ]);
  const fixedOptions: HerdrHarnessLayerOptions = Object.freeze({
    ...options,
    environment,
    codexHooks: options.codexHooks ?? makeHerdrCodexHooks({ environment }),
    ...(options.integrationPaths && {
      integrationPaths: Object.freeze({ ...options.integrationPaths }),
    }),
  });
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
        // SAFETY: This fixed allowlist contains only valid Node platform literals.
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
        const agentDirectory = yield* readinessPromise(
          () => safeAgentDirectory(fixedOptions.agentDirectory),
          readinessError(
            "herdr_harness_unavailable",
            "Private agent-directory state is unavailable.",
          ),
        );
        const integration = integrationPath(fixedOptions, runtime, agentDirectory, environment);
        yield* readinessPromise(
          () => validateIntegration(integration, runtime),
          readinessError(
            `${runtime}_herdr_integration_unavailable`,
            `The marker-validated current Herdr ${runtime} integration is unavailable.`,
          ),
        );
        if (runtime === "pi") {
          yield* readinessPromise(
            () =>
              fs.lstat(PI_SUPERVISOR_EXTENSION).then((stat) => {
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1)
                  throw new Error("missing-bridge");
              }),
            readinessError(
              "pi_bridge_unavailable",
              "The packaged private Pi supervisor bridge is unavailable.",
            ),
          );
        }
        if (runtime === "codex") {
          yield* readinessPromise(
            () =>
              fs.lstat(CODEX_SESSION_HOOK).then((stat) => {
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1)
                  throw new Error("missing-codex-session-hook");
              }),
            readinessError(
              "codex_herdr_hook_unavailable",
              "The packaged private Codex Herdr SessionStart hook is unavailable.",
            ),
          );
          const auth = yield* Effect.promise(() => readValidatedCodexAuth(environment));
          if (!auth && !approvedApiKey(environment))
            return yield* readinessError(
              "codex_harness_auth_unavailable",
              "Codex has no bounded valid auth.json copy source and no approved API-key fallback.",
            );
        }
      }),
    prepare: (runtime, request, supervisor) => {
      const acquisition = prepareHarness(fixedOptions, runtime, request, supervisor).pipe(
        Effect.catchCause((cause) =>
          Effect.failCause(
            Cause.map(cause, (error) =>
              error instanceof SubagentProcessError
                ? error
                : processError(
                    "prepare Herdr harness",
                    error.code,
                    error.code === "codex_herdr_hook_cleanup_unconfirmed"
                      ? `Private ${runtime} Herdr harness cleanup could not be confirmed; its state remains quarantined.`
                      : "Codex could not trust and verify the exact private Herdr SessionStart hook before topology creation.",
                  ),
            ),
          ),
        ),
      );
      return Effect.acquireRelease(
        acquisition,
        (resource) =>
          resource.cleanupAllowed()
            ? removeOwnedHarness(fixedOptions, resource.harness.directory).pipe(
                Effect.catchCause((cause) =>
                  Effect.failCause(
                    defectCause(
                      Cause.fromReasons([
                        ...Cause.fail(cleanupError()).reasons,
                        ...Cause.map(cause, () => cleanupError()).reasons,
                      ]),
                    ),
                  ),
                ),
                Effect.uninterruptible,
              )
            : Effect.void,
        { interruptible: true },
      ).pipe(Effect.map((resource) => resource.harness));
    },
  };
};

export class HerdrHarness extends Context.Service<HerdrHarness, HerdrHarnessContract>()(
  "pi-subagents/boundary/herdr-harness/HerdrHarness",
) {
  static readonly layer = (options: HerdrHarnessLayerOptions): Layer.Layer<HerdrHarness> =>
    Layer.succeed(this, makeHerdrHarness(options));
}
