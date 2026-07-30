// Per-agent isolated harness preparation is a Node filesystem boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/processEnvInEffect:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentDirectory } from "pi-cosmic-core";
import type { HerdrAgentKind } from "../herd/model.ts";
import { HerdrHarnessError } from "../herd/errors.ts";
import type { PreparedReportChannel } from "./report-channel.ts";

export type PreparedAgentHarness =
  | {
      readonly kind: "claude";
      readonly mcpConfigPath: string;
      readonly settingsPath: string;
    }
  | {
      readonly kind: "pi";
      readonly integrationPath: string;
      readonly reportExtensionPath: string;
      readonly reportHelperPath: string;
      readonly reportDirectory: string;
      readonly runId: string;
      readonly sessionDirectory: string;
    }
  | {
      readonly kind: "codex";
      readonly codexHome: string;
    };

export interface AgentHarnessShape {
  readonly prepare: (
    kind: HerdrAgentKind,
    cwd: string,
    channel: PreparedReportChannel,
  ) => Effect.Effect<PreparedAgentHarness, HerdrHarnessError>;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const tomlString = (value: string): string => JSON.stringify(value);

export interface AgentHarnessOptions {
  readonly claudeIntegrationPath?: string | undefined;
  readonly sourceCodexHome?: string | undefined;
  readonly piIntegrationPath?: string | undefined;
}

export class AgentHarness extends Context.Service<AgentHarness, AgentHarnessShape>()(
  "pi-herdr/boundary/agent-harness/AgentHarness",
) {
  static readonly layer = (options: AgentHarnessOptions = {}) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const agentDirectory = yield* AgentDirectory;
        const reportExtensionPath = fileURLToPath(
          new URL("./host-report-extension.ts", import.meta.url),
        );
        const piIntegrationPath =
          options.piIntegrationPath ?? join(agentDirectory, "extensions", "herdr-agent-state.ts");
        const claudeIntegrationPath =
          options.claudeIntegrationPath ??
          join(homedir(), ".claude", "hooks", "herdr-agent-state.sh");
        const sourceCodexHome =
          options.sourceCodexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
        const codexAuthPath = join(sourceCodexHome, "auth.json");
        const codexIntegrationPath = join(sourceCodexHome, "herdr-agent-state.sh");

        const failure = (operation: string, code: string, message: string) =>
          new HerdrHarnessError({ operation, code, message });

        const requireHerdrIntegration = (path: string, kind: HerdrAgentKind, description: string) =>
          Effect.tryPromise({
            try: async () => {
              const source = await readFile(path, "utf8");
              if (
                Buffer.byteLength(source, "utf8") > 256 * 1024 ||
                !source.includes("installed by herdr") ||
                !source.includes(`HERDR_INTEGRATION_ID=${kind}`)
              )
                throw new Error("integration_marker_mismatch");
            },
            catch: () =>
              failure(
                `prepare ${kind} harness`,
                `${kind}_integration_required`,
                `${description} is required at ${path}. Install the current Herdr ${kind} integration, then retry.`,
              ),
          });

        const prepareClaude = (channel: PreparedReportChannel) =>
          Effect.gen(function* () {
            yield* requireHerdrIntegration(
              claudeIntegrationPath,
              "claude",
              "The Herdr Claude integration",
            );
            const settingsPath = join(channel.directory, "claude-settings.json");
            const settings = {
              hooks: {
                SessionStart: [
                  {
                    matcher: "*",
                    hooks: [
                      {
                        type: "command",
                        command: `bash ${shellQuote(claudeIntegrationPath)} session`,
                        timeout: 10,
                      },
                    ],
                  },
                ],
              },
            };
            yield* Effect.tryPromise({
              try: () =>
                writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
                  encoding: "utf8",
                  mode: 0o600,
                }),
              catch: () =>
                failure(
                  "prepare claude harness",
                  "claude_harness_prepare_failed",
                  "Unable to prepare isolated Claude settings for the Herdr integration.",
                ),
            });
            return {
              kind: "claude",
              mcpConfigPath: channel.mcpConfigPath,
              settingsPath,
            } satisfies PreparedAgentHarness;
          });

        const preparePi = (channel: PreparedReportChannel) =>
          Effect.gen(function* () {
            yield* requireHerdrIntegration(piIntegrationPath, "pi", "The Herdr Pi integration");
            const sessionDirectory = join(channel.directory, "pi-sessions");
            yield* Effect.tryPromise({
              try: () => mkdir(sessionDirectory, { recursive: true, mode: 0o700 }),
              catch: () =>
                failure(
                  "prepare pi harness",
                  "pi_harness_prepare_failed",
                  "Unable to prepare the private Pi session directory.",
                ),
            });
            return {
              kind: "pi",
              integrationPath: piIntegrationPath,
              reportExtensionPath,
              reportHelperPath: channel.helperPath,
              reportDirectory: channel.directory,
              runId: channel.runId,
              sessionDirectory,
            } satisfies PreparedAgentHarness;
          });

        const prepareCodex = (cwd: string, channel: PreparedReportChannel) =>
          Effect.gen(function* () {
            yield* requireHerdrIntegration(
              codexIntegrationPath,
              "codex",
              "The Herdr Codex integration",
            );
            const codexHome = join(channel.directory, "codex-home");
            const authTarget = join(codexHome, "auth.json");
            const hooksPath = join(codexHome, "hooks.json");
            const configPath = join(codexHome, "config.toml");
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(codexHome, { recursive: true, mode: 0o700 });
                try {
                  const authentication = await readFile(codexAuthPath);
                  if (authentication.byteLength > 1024 * 1024) throw new Error("auth_too_large");
                  JSON.parse(authentication.toString("utf8"));
                  await writeFile(authTarget, authentication, { mode: 0o600, flag: "wx" });
                } catch (error) {
                  if (!process.env.OPENAI_API_KEY) throw error;
                }
                const hooks = {
                  hooks: {
                    SessionStart: [
                      {
                        hooks: [
                          {
                            type: "command",
                            command: `bash ${shellQuote(codexIntegrationPath)} session`,
                          },
                        ],
                      },
                    ],
                  },
                };
                await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, {
                  encoding: "utf8",
                  mode: 0o600,
                });
                const config = [
                  `developer_instructions = ${tomlString("You are a read-only delegated Codex agent managed by pi-herdr. Do not modify files, request elevated permissions, use external apps, or create subagents. Complete the assigned task independently. Before the final response, call the submit_report tool from the private herdr_report MCP server exactly once with a complete self-contained report and status completed, blocked, or failed.")}`,
                  'approval_policy = "never"',
                  'sandbox_mode = "read-only"',
                  'web_search = "disabled"',
                  "allow_login_shell = false",
                  "check_for_update_on_startup = false",
                  "",
                  "[agents]",
                  "enabled = false",
                  "",
                  "[features]",
                  "apps = false",
                  "browser_use = false",
                  "browser_use_external = false",
                  "browser_use_full_cdp_access = false",
                  "computer_use = false",
                  "enable_mcp_apps = false",
                  "hooks = true",
                  "image_generation = false",
                  "in_app_browser = false",
                  "multi_agent = false",
                  "multi_agent_v2 = false",
                  "network_proxy = false",
                  "plugin_sharing = false",
                  "plugins = false",
                  "remote_plugin = false",
                  "skill_mcp_dependency_install = false",
                  "standalone_web_search = false",
                  "",
                  `[projects.${tomlString(cwd)}]`,
                  'trust_level = "untrusted"',
                  "",
                  "[mcp_servers.herdr_report]",
                  `command = ${tomlString(process.execPath)}`,
                  `args = [${tomlString(channel.helperPath)}]`,
                  `env = { HERDR_RUN_ID = ${tomlString(channel.runId)}, HERDR_REPORT_DIR = ${tomlString(channel.directory)} }`,
                  "required = true",
                  'enabled_tools = ["submit_report"]',
                  'default_tools_approval_mode = "approve"',
                  "",
                ].join("\n");
                await writeFile(configPath, config, { encoding: "utf8", mode: 0o600 });
              },
              catch: () =>
                failure(
                  "prepare codex harness",
                  "codex_harness_prepare_failed",
                  "Unable to prepare the isolated Codex harness or reuse Codex authentication.",
                ),
            });
            return { kind: "codex", codexHome } satisfies PreparedAgentHarness;
          });

        const prepare: AgentHarnessShape["prepare"] = (kind, cwd, channel) => {
          switch (kind) {
            case "claude":
              return prepareClaude(channel);
            case "pi":
              return preparePi(channel);
            case "codex":
              return prepareCodex(cwd, channel);
          }
        };

        return AgentHarness.of({ prepare });
      }),
    );
}
