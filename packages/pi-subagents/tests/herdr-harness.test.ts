// Private harness files are intentional boundary-test IO.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { provideBuiltLayer } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedLogger } from "pi-cosmic-core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { prepareHerdrStartupAttestation } from "../src/boundary/herdr-attestation.ts";
import { HerdrCodexHooksError, makeHerdrCodexHooks } from "../src/boundary/herdr-codex-hooks.ts";
import { makeHerdrHarness } from "../src/boundary/herdr-harness.ts";
import type { SupervisorConnectionMetadata } from "../src/boundary/supervisor-channel.ts";
import type { BackendLaunchRequest } from "../src/backend/model.ts";
import { processError } from "../src/run/errors.ts";
import {
  PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_ARGUMENT,
  SUBAGENT_TOOL_NAMES,
} from "../src/run/tool-policy.ts";
import { SUPERVISOR_MCP_TOOL_NAMES } from "../src/supervisor/mcp-contract.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { nodeFsPromises as fs, nodePath, nodeSpawn } from "./support/node-builtins.ts";

const { join } = nodePath;

const codexHookFixture = fileURLToPath(
  new URL("./fixtures/codex-hook-trust-fixture.mjs", import.meta.url),
);
const directories: string[] = [];

const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

// Test assertions decode private harness JSON files outside Effect code on purpose: the
// boundary under test owns the shape of these fixture documents.
const readJsonFile = (path: string): Promise<any> =>
  fs.readFile(path, "utf8").then((source) => JSON.parse(source));
const valueAfter = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });

const runShellCommand = (command: string): Promise<void> =>
  Effect.runPromise(
    Effect.callback<void>((resume) => {
      const child = nodeSpawn("/bin/sh", ["-c", command], { stdio: "ignore" });
      child.once("error", (error) => resume(Effect.die(error)));
      child.once("close", (code) =>
        resume(
          code === 0 ? Effect.void : Effect.die(new Error(`Fixture shell exited ${String(code)}.`)),
        ),
      );
    }),
  );

const setupReceiptDirectory = () =>
  fs.mkdtemp(join(tmpdir(), "pi-subagents-herdr-receipts-")).then((directory) => {
    directories.push(directory);
    return fs.chmod(directory, 0o700).then(() => directory);
  });

const setup = () =>
  fs.mkdtemp(join(tmpdir(), "pi-subagents-herdr-harness-")).then((directory) => {
    directories.push(directory);
    const home = join(directory, "home");
    const agentDirectory = join(directory, "agent");
    const integrations = {
      pi: join(directory, "pi-integration.ts"),
      claude: join(directory, "claude-integration.sh"),
      codex: join(directory, "codex-integration.sh"),
    } as const;
    const integrationVersions = { pi: 8, claude: 7, codex: 7 } as const;
    const codexSource = join(home, ".codex");
    return fs
      .mkdir(home, { recursive: true, mode: 0o700 })
      .then(() => fs.mkdir(agentDirectory, { recursive: true, mode: 0o700 }))
      .then(() =>
        Promise.all(
          Object.entries(integrations).map(([runtime, path]) =>
            // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
            fs.writeFile(
              path,
              `# installed by herdr\nHERDR_INTEGRATION_ID=${runtime}\nHERDR_INTEGRATION_VERSION=${integrationVersions[runtime as keyof typeof integrationVersions]}\n`,
              { mode: 0o600 },
            ),
          ),
        ),
      )
      .then(() => fs.mkdir(codexSource, { recursive: true, mode: 0o700 }))
      .then(() =>
        fs.writeFile(
          join(codexSource, "auth.json"),
          JSON.stringify({ tokens: { access: "private" } }),
          {
            mode: 0o600,
          },
        ),
      )
      .then(() => buildSetup(directory, home, agentDirectory, integrations));
  });

const buildSetup = (
  directory: string,
  home: string,
  agentDirectory: string,
  integrations: { readonly pi: string; readonly claude: string; readonly codex: string },
) => {
  const supervisor: SupervisorConnectionMetadata = {
    runId: "agent-herdr",
    host: "127.0.0.1",
    port: 1,
    stateDirectory: join(directory, "supervisor"),
    connectionConfigPath: join(directory, "supervisor", "connection.json"),
    helperPath: "/private/helper.mjs",
    claudeMcp: {
      mcpServers: {
        pi_subagents_supervisor: {
          type: "stdio",
          command: process.execPath,
          args: ["/private/helper.mjs", "--config", "/private/connection.json"],
          env: {},
        },
      },
    },
    codexMcp: {
      serverName: "pi_subagents_supervisor",
      command: process.execPath,
      args: ["/private/helper.mjs", "--config", "/private/connection.json"],
      enabledTools: [
        "supervisor_progress",
        "supervisor_warning",
        "supervisor_question",
        "supervisor_submit_report",
      ],
      tomlFragment: "[mcp_servers.pi_subagents_supervisor]\nrequired = true",
    },
  };
  const environment = {
    HOME: home,
    PATH: inheritedPath(process.env),
    HERDR_SOCKET_PATH: "/private/herdr.sock",
    OPENAI_API_KEY: "must-never-appear-in-argv",
  };
  const harness = makeHerdrHarness({
    agentDirectory,
    environment,
    integrationPaths: integrations,
    codexHooks: makeHerdrCodexHooks({
      executable: codexHookFixture,
      environment,
      timeoutMillis: 1_000,
    }),
  });
  return { directory, agentDirectory, environment, integrations, harness, supervisor };
};

const launch = (
  runtime: "pi" | "claude" | "codex",
  writeIntent: "read-only" | "writer" = "read-only",
): BackendLaunchRequest => ({
  runId: `agent-${runtime}`,
  name: `${runtime}-worker`,
  closeOnReport: writeIntent === "writer",
  cwd: process.cwd(),
  context: "fresh",
  writeIntent,
  openaiFastMode: false,
  model: runtime === "pi" ? "openai-codex/gpt-5.6-sol" : `${runtime}-model`,
  effort: "xhigh",
  runtimeApiKey:
    runtime === "pi"
      ? Redacted.make("pi-runtime-secret", { label: "Test runtime API key" })
      : undefined,
  activeTools: [],
  projectTrusted: false,
  parentSessionId: "parent-session",
  systemPrompt: "Fixed supervisor policy.\n\nReport only through the private supervisor.",
});

afterEach(() =>
  Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  ).then(() => undefined),
);

describe("Herdr native harness security", () => {
  it("atomically publishes a unique private receipt from the pane command", () =>
    setupReceiptDirectory().then((directory) =>
      prepareHerdrStartupAttestation(directory, {
        pollAttempts: 2,
        pollDelayMillis: 1,
      }).then((attestation) => {
        const receipt = attestation.environmentReadyReceipt;
        return fs
          .readdir(directory)
          .then((entries) => expect(entries).toEqual([]))
          .then(() => runShellCommand(receipt.command))
          .then(() => Effect.runPromise(receipt.observe))
          .then(() => fs.lstat(receipt.path))
          .then((stat) => {
            expect(stat.isFile()).toBe(true);
            expect(stat.isSymbolicLink()).toBe(false);
            expect(stat.mode & 0o077).toBe(0);
            return expect(fs.lstat(receipt.temporaryPath)).rejects.toMatchObject({
              code: "ENOENT",
            });
          });
      }),
    ));

  it("logs only bounded receipt phase/outcome diagnostics", () =>
    setupReceiptDirectory().then((directory) => {
      const captured = makeCapturedLogger();
      return prepareHerdrStartupAttestation(directory, {
        pollAttempts: 1,
        pollDelayMillis: 1,
      }).then((attestation) => {
        const receipt = attestation.secretReadyReceipt;
        return expect(Effect.runPromise(receipt.observe.pipe(provideBuiltLayer(captured.layer))))
          .rejects.toMatchObject({ code: "herdr_startup_receipt_timeout" })
          .then(() => {
            const diagnostics = capturedTelemetrySnapshot({ entries: captured.entries });
            expect(diagnostics).toContain("secret-ready");
            expect(diagnostics).toContain("timeout");
            expect(diagnostics).not.toContain(directory);
            expect(diagnostics).not.toContain(receipt.path);
            expect(diagnostics).not.toContain(receipt.command);
          });
      });
    }));

  it("removes startup receipts only after harness cleanup is authorized", () =>
    setup().then((test) => {
      let harnessDirectory = "";
      let receiptPath = "";
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* test.harness.prepare("pi", launch("pi"), test.supervisor);
            harnessDirectory = prepared.directory;
            const receipt = prepared.startupAttestation.activationReceipt(1);
            receiptPath = receipt.path;
            yield* Effect.tryPromise({
              try: () => runShellCommand(receipt.command),
              catch: () =>
                processError(
                  "execute fixture receipt command",
                  "fixture_receipt_command_failed",
                  "Fixture receipt command failed.",
                ),
            }).pipe(Effect.orDie);
            yield* receipt.observe;
            prepared.authorizeCleanup();
          }),
        ),
      ).then(() =>
        Promise.all([
          expect(fs.lstat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" }),
          expect(fs.lstat(harnessDirectory)).rejects.toMatchObject({ code: "ENOENT" }),
        ]).then(() => undefined),
      );
    }));

  it("rejects absent, wrong, symlink, partial, oversized, and non-regular receipts", () =>
    setupReceiptDirectory().then((directory) =>
      prepareHerdrStartupAttestation(directory, {
        pollAttempts: 2,
        pollDelayMillis: 1,
      }).then((attestation) => {
        const absent = attestation.activationReceipt(1);
        const wrong = attestation.activationReceipt(2);
        const symlink = attestation.environmentReadyReceipt;
        const partial = attestation.postEnvironmentShellReceipt;
        const oversized = attestation.secretReadyReceipt;
        const nonRegular = attestation.postSecretShellReceipt;
        const target = join(directory, "symlink-target");
        return expect(Effect.runPromise(absent.observe))
          .rejects.toMatchObject({ code: "herdr_startup_receipt_timeout" })
          .then(() => fs.writeFile(wrong.path, "wrong-complete-content\n", { mode: 0o600 }))
          .then(() =>
            expect(Effect.runPromise(wrong.observe)).rejects.toMatchObject({
              code: "herdr_startup_receipt_invalid",
            }),
          )
          .then(() => fs.writeFile(target, "target\n", { mode: 0o600 }))
          .then(() => fs.symlink(target, symlink.path))
          .then(() =>
            expect(Effect.runPromise(symlink.observe)).rejects.toMatchObject({
              code: "herdr_startup_receipt_invalid",
            }),
          )
          .then(() => fs.writeFile(partial.path, "partial", { mode: 0o600 }))
          .then(() =>
            expect(Effect.runPromise(partial.observe)).rejects.toMatchObject({
              code: "herdr_startup_receipt_invalid",
            }),
          )
          .then(() => fs.writeFile(oversized.path, "x".repeat(512), { mode: 0o600 }))
          .then(() =>
            expect(Effect.runPromise(oversized.observe)).rejects.toMatchObject({
              code: "herdr_startup_receipt_invalid",
            }),
          )
          .then(() => fs.mkdir(nonRegular.path, { mode: 0o700 }))
          .then(() =>
            expect(Effect.runPromise(nonRegular.observe)).rejects.toMatchObject({
              code: "herdr_startup_receipt_invalid",
            }),
          );
      }),
    ));

  effectTest(
    "rejects unrepresentable Claude writer cwd rules during topology-free preflight",
    function* () {
      const test = yield* step(setup);
      for (const cwd of ["/repo,other", "/repo/(group)", "/repo/*/glob"]) {
        yield* step(() =>
          expect(
            Effect.runPromise(
              test.harness.preflight("claude", {
                ...launch("claude", "writer"),
                cwd,
              }),
            ),
          ).rejects.toMatchObject({ code: "claude_writer_confinement_unsupported" }),
        );
      }
      yield* step(() =>
        expect(
          Effect.runPromise(
            test.harness.preflight("claude", {
              ...launch("claude", "writer"),
              cwd: "/repo-safe/path_1",
            }),
          ),
        ).resolves.toBeUndefined(),
      );
    },
  );

  effectTest("uses the shared safe model-selector grammar for every Herdr runtime", function* () {
    const test = yield* step(setup);
    for (const runtime of ["pi", "claude", "codex"] as const)
      for (const model of ["-leading-option", "model with spaces", "model,(glob)*"]) {
        yield* step(() =>
          expect(
            Effect.runPromise(test.harness.preflight(runtime, { ...launch(runtime), model })),
          ).rejects.toMatchObject({ code: `${runtime}_model_unsupported` }),
        );
      }
  });

  effectTest(
    "accepts reviewed hook versions and rejects unknown or wrong-runtime markers",
    function* () {
      const test = yield* step(setup);
      for (const [runtime, versions] of [
        ["pi", [8]],
        ["claude", [7, 9]],
        ["codex", [7, 8]],
      ] as const) {
        for (const version of versions) {
          yield* step(() =>
            fs.writeFile(
              test.integrations[runtime],
              `# installed by herdr\nHERDR_INTEGRATION_ID=${runtime}\nHERDR_INTEGRATION_VERSION=${version}\n`,
            ),
          );
          yield* step(() => Effect.runPromise(test.harness.preflight(runtime, launch(runtime))));
        }
        for (const [id, version] of [
          [runtime, 999],
          ["other", versions[0]],
        ] as const) {
          yield* step(() =>
            fs.writeFile(
              test.integrations[runtime],
              `# installed by herdr\nHERDR_INTEGRATION_ID=${id}\nHERDR_INTEGRATION_VERSION=${version}\n`,
            ),
          );
          yield* step(() =>
            expect(
              Effect.runPromise(test.harness.preflight(runtime, launch(runtime))),
            ).rejects.toMatchObject({ code: `${runtime}_herdr_integration_unavailable` }),
          );
        }
      }
    },
  );

  it("rejects obsolete Herdr integration marker versions", () =>
    setup().then((test) =>
      fs
        .writeFile(
          test.integrations.pi,
          "// installed by herdr\n// HERDR_INTEGRATION_ID=pi\n// HERDR_INTEGRATION_VERSION=6\n",
        )
        .then(() =>
          expect(
            Effect.runPromise(test.harness.preflight("pi", launch("pi"))),
          ).rejects.toMatchObject({ code: "pi_herdr_integration_unavailable" }),
        ),
    ));

  it("rejects control-bearing inherited harness values before topology ownership", () =>
    setup().then((test) => {
      const harness = makeHerdrHarness({
        agentDirectory: test.agentDirectory,
        environment: { ...test.environment, PATH: "bad\u0085path" },
        integrationPaths: test.integrations,
      });
      return expect(Effect.runPromise(harness.preflight("pi", launch("pi")))).rejects.toMatchObject(
        {
          code: "herdr_environment_invalid",
        },
      );
    }));

  it("rejects every Windows Herdr harness before topology ownership", () =>
    setup().then((test) => {
      const harness = makeHerdrHarness({
        agentDirectory: test.agentDirectory,
        environment: test.environment,
        integrationPaths: test.integrations,
        platform: "win32",
      });
      return expect(Effect.runPromise(harness.preflight("pi", launch("pi")))).rejects.toMatchObject(
        {
          code: "herdr_platform_unsupported",
        },
      );
    }));

  it("rejects read-only Claude Bash where the strict sandbox is unsupported", () =>
    setup().then((test) => {
      const harness = makeHerdrHarness({
        agentDirectory: test.agentDirectory,
        environment: test.environment,
        integrationPaths: test.integrations,
        platform: "freebsd",
      });
      return expect(
        Effect.runPromise(harness.preflight("claude", launch("claude"))),
      ).rejects.toMatchObject({ code: "claude_shell_confinement_unsupported" });
    }));

  it("exposes read-only Claude Bash only through the strict sandbox", () =>
    setup().then((test) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* test.harness.prepare(
              "claude",
              launch("claude"),
              test.supervisor,
            );
            expect(valueAfter(prepared.argv, "--tools")).toContain("Bash");
            expect(valueAfter(prepared.argv, "--tools")).toContain("Agent");
            expect(valueAfter(prepared.argv, "--tools")).toContain("TaskOutput");
            expect(valueAfter(prepared.argv, "--tools")).not.toContain("Edit");
            const allowed = valueAfter(prepared.argv, "--allowedTools")?.split(",") ?? [];
            expect(allowed).not.toContain("Bash");
            expect(allowed).not.toContain("Edit");
            expect(allowed).not.toContain("Write");
            expect(allowed).toContain("Agent");
            expect(allowed).toContain("TaskOutput");
            const settings = yield* Effect.promise(() =>
              readJsonFile(valueAfter(prepared.argv, "--settings")!),
            );
            expect(settings.sandbox).toMatchObject({
              enabled: true,
              autoAllowBashIfSandboxed: true,
              failIfUnavailable: true,
              allowUnsandboxedCommands: false,
              filesystem: { allowWrite: [], denyWrite: [process.cwd()] },
            });
            prepared.authorizeCleanup();
          }),
        ),
      ),
    ));

  it("fixes Claude args and reuses strict cwd-scoped writer policy", () =>
    setup().then((test) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* test.harness.prepare(
              "claude",
              launch("claude", "writer"),
              test.supervisor,
            );
            expect(valueAfter(prepared.argv, "--model")).toBe("claude-model");
            expect(valueAfter(prepared.argv, "--effort")).toBe("xhigh");
            expect(prepared.argv).toContain("--strict-mcp-config");
            expect(prepared.argv).not.toContain("--no-session-persistence");
            expect(valueAfter(prepared.argv, "--setting-sources")).toBe("");
            const promptPath = valueAfter(prepared.argv, "--system-prompt-file")!;
            expect(yield* Effect.promise(() => fs.readFile(promptPath, "utf8"))).toBe(
              launch("claude", "writer").systemPrompt,
            );
            expect(prepared.argv.every((argument) => !hasControlCharacter(argument))).toBe(true);
            expect(valueAfter(prepared.argv, "--tools")).toContain("Bash");
            expect(valueAfter(prepared.argv, "--tools")).toContain("Edit");
            expect(valueAfter(prepared.argv, "--tools")).not.toContain("Write,");
            expect(valueAfter(prepared.argv, "--allowedTools")).toContain(
              `Edit(/${process.cwd()}/**)`,
            );
            const environmentCommand = prepared.environmentCommand({
              paneId: "w:p",
              tabId: "w:t",
              workspaceId: "w",
            });
            expect(environmentCommand).toContain("exec /usr/bin/env -i");
            expect(environmentCommand).toContain("CLAUDE_CODE_SKIP_PROMPT_HISTORY='1'");
            expect(environmentCommand).toContain(
              prepared.startupAttestation.environmentReadyReceipt.path,
            );
            const startupReceipts = [
              prepared.startupAttestation.activationReceipt(1),
              prepared.startupAttestation.activationReceipt(2),
              prepared.startupAttestation.environmentReadyReceipt,
              prepared.startupAttestation.postEnvironmentShellReceipt,
              prepared.startupAttestation.secretReadyReceipt,
              prepared.startupAttestation.postSecretShellReceipt,
            ];
            expect(new Set(startupReceipts.map((receipt) => receipt.path)).size).toBe(6);
            expect(new Set(startupReceipts.map((receipt) => receipt.command)).size).toBe(6);
            expect(
              startupReceipts.every((receipt) => receipt.path.startsWith(prepared.directory)),
            ).toBe(true);
            const settings = yield* Effect.promise(() =>
              readJsonFile(valueAfter(prepared.argv, "--settings")!),
            );
            expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true });
            expect(settings.env).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
            expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
              "claude-integration.sh",
            );
            expect(settings.hooks.SessionStart[0].hooks[0].command).toMatch(/ session$/u);
            prepared.authorizeCleanup();
          }),
        ),
      ),
    ));

  it("propagates fast mode to Herdr Pi and Codex without exposing a credential", () =>
    setup().then((test) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const pi = yield* test.harness.prepare(
              "pi",
              { ...launch("pi"), openaiFastMode: true },
              test.supervisor,
            );
            expect(pi.argv).toContain("--pi-subagents-fast-mode");

            const codex = yield* test.harness.prepare(
              "codex",
              { ...launch("codex"), openaiFastMode: true },
              test.supervisor,
            );
            const config = yield* Effect.promise(() =>
              fs.readFile(join(codex.directory, "codex-home", "config.toml"), "utf8"),
            );
            expect(config).toContain('service_tier = "priority"');
            expect(config).toContain("fast_mode = true");
            expect(codex.argv.join(" ")).not.toContain("must-never-appear-in-argv");
            pi.authorizeCleanup();
            codex.authorizeCleanup();
          }),
        ),
      ),
    ));

  it("isolates Codex auth/config and never places secrets in Herdr agent argv", () =>
    setup().then((test) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* test.harness.prepare("codex", launch("codex"), test.supervisor);
            expect(valueAfter(prepared.argv, "--model")).toBe("codex-model");
            expect(valueAfter(prepared.argv, "--sandbox")).toBe("read-only");
            expect(valueAfter(prepared.argv, "--ask-for-approval")).toBe("never");
            expect(prepared.argv).not.toContain("--dangerously-bypass-hook-trust");
            expect(prepared.argv.at(-1)).toContain("lifecycle hook");
            expect(prepared.argv.join(" ")).not.toContain("must-never-appear-in-argv");
            expect(prepared.argv.every((argument) => !hasControlCharacter(argument))).toBe(true);
            expect(prepared.secretCommand).not.toContain("must-never-appear-in-argv");
            const codexHome = join(prepared.directory, "codex-home");
            const hooks = yield* Effect.promise(() => readJsonFile(join(codexHome, "hooks.json")));
            const sessionStart = hooks.hooks.SessionStart[0];
            expect(sessionStart.matcher).toBe("startup");
            expect(sessionStart.hooks[0]).toMatchObject({ type: "command", timeout: 10 });
            expect(sessionStart.hooks[0].command).toContain("herdr-codex-session-hook.mjs");
            const config = yield* Effect.promise(() =>
              fs.readFile(join(codexHome, "config.toml"), "utf8"),
            );
            expect(config).toContain('approval_policy = "never"');
            expect(config).toContain("[agents]\nenabled = true");
            expect(config).toContain("multi_agent = true");
            expect(config).toContain("[mcp_servers.pi_subagents_supervisor]");
            const auth = yield* Effect.promise(() => readJsonFile(join(codexHome, "auth.json")));
            expect(auth).toEqual({
              tokens: { access: "private" },
            });
            prepared.authorizeCleanup();
          }),
        ),
      ),
    ));

  it("removes private Codex state when exact hook trust cannot be established", () =>
    setup().then((test) => {
      const failing = makeHerdrHarness({
        agentDirectory: test.agentDirectory,
        environment: test.environment,
        integrationPaths: test.integrations,
        codexHooks: {
          establishTrust: () =>
            Effect.fail(new HerdrCodexHooksError({ code: "codex_herdr_hook_unavailable" })),
        },
      });
      return expect(
        Effect.runPromise(
          Effect.scoped(failing.prepare("codex", launch("codex"), test.supervisor)),
        ),
      )
        .rejects.toMatchObject({ code: "codex_herdr_hook_unavailable" })
        .then(() =>
          expect(
            fs.readdir(join(test.agentDirectory, "subagents", "herdr-host-v1")),
          ).resolves.toEqual([]),
        );
    }));

  it("pins the sanitized inherited environment at harness construction", () =>
    setup().then((test) => {
      test.environment.HOME = join(test.directory, "redirected-home");
      test.environment.HERDR_SOCKET_PATH = "/redirected/herdr.sock";
      test.environment.OPENAI_API_KEY = "redirected-secret";
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* test.harness.prepare("codex", launch("codex"), test.supervisor);
            const auth = yield* Effect.promise(() =>
              readJsonFile(join(prepared.directory, "codex-home", "auth.json")),
            );
            expect(auth).toEqual({ tokens: { access: "private" } });
            expect(prepared.secretCommand).not.toContain("redirected-secret");
            expect(
              prepared.environmentCommand({ paneId: "p", tabId: "t", workspaceId: "w" }),
            ).toContain("HERDR_SOCKET_PATH='/private/herdr.sock'");
            prepared.authorizeCleanup();
          }),
        ),
      );
    }));

  effectTest(
    "leaves a pre-owned blocking parent unchanged and reports prepare failure",
    function* () {
      const test = yield* step(setup);
      const blocker = join(test.agentDirectory, "subagents");
      yield* step(() => fs.writeFile(blocker, "foreign-owner", { mode: 0o600 }));
      const exit = yield* Effect.scoped(
        test.harness.prepare("pi", launch("pi"), test.supervisor),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const first = exit.cause.reasons[0];
        expect(first && Cause.isFailReason(first) ? first.error.code : undefined).toBe(
          "herdr_harness_prepare_failed",
        );
      }
      expect(yield* step(() => fs.readFile(blocker, "utf8"))).toBe("foreign-owner");
    },
  );

  effectTest("removes an owned partial harness after a build failure", function* () {
    const test = yield* step(setup);
    const harness = makeHerdrHarness({
      agentDirectory: test.agentDirectory,
      environment: test.environment,
      integrationPaths: test.integrations,
      harnessFault: "after-claude-settings",
    });
    const exit = yield* Effect.scoped(
      harness.prepare("claude", launch("claude"), test.supervisor),
    ).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      yield* step(() => fs.readdir(join(test.agentDirectory, "subagents", "herdr-host-v1"))),
    ).toEqual([]);
  });

  effectTest("keeps final-release cleanup failures as top-level Cause reasons", function* () {
    const test = yield* step(setup);
    const harness = makeHerdrHarness({
      agentDirectory: test.agentDirectory,
      environment: test.environment,
      integrationPaths: test.integrations,
      harnessCleanupFault: true,
    });
    const exit = yield* Effect.scoped(harness.prepare("pi", launch("pi"), test.supervisor)).pipe(
      Effect.exit,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.every(Cause.isDieReason)).toBe(true);
      expect(Cause.squash(exit.cause)).toMatchObject({
        code: "herdr_harness_cleanup_unconfirmed",
      });
      expect(
        exit.cause.reasons.some(
          (reason) => Cause.isDieReason(reason) && Cause.isCause(reason.defect),
        ),
      ).toBe(false);
    }
  });

  effectTest(
    "keeps partial cleanup failure primary while preserving every preparation failure",
    function* () {
      const test = yield* step(setup);
      const harness = makeHerdrHarness({
        agentDirectory: test.agentDirectory,
        environment: test.environment,
        integrationPaths: test.integrations,
        harnessFault: "after-claude-settings",
        harnessCleanupFault: true,
      });
      const exit = yield* Effect.scoped(
        harness.prepare("claude", launch("claude"), test.supervisor),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const codes = exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [reason.error.code] : [],
        );
        expect(codes[0]).toBe("herdr_harness_cleanup_unconfirmed");
        expect(codes.slice(1)).toEqual([
          "herdr_harness_prepare_failed",
          "herdr_harness_prepare_failed",
        ]);
      }
    },
  );

  effectTest("quarantines Codex state when hook-process cleanup is unconfirmed", function* () {
    const test = yield* step(setup);
    const harness = makeHerdrHarness({
      agentDirectory: test.agentDirectory,
      environment: test.environment,
      integrationPaths: test.integrations,
      codexHooks: {
        establishTrust: () =>
          Effect.failCause(
            Cause.fromReasons([
              ...Cause.fail(
                new HerdrCodexHooksError({ code: "codex_herdr_hook_cleanup_unconfirmed" }),
              ).reasons,
              ...Cause.fail(new HerdrCodexHooksError({ code: "codex_herdr_hook_unavailable" }))
                .reasons,
            ]),
          ),
      },
    });
    const exit = yield* Effect.scoped(
      harness.prepare("codex", launch("codex"), test.supervisor),
    ).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const codes = exit.cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) ? [reason.error.code] : [],
      );
      expect(codes).toEqual([
        "codex_herdr_hook_cleanup_unconfirmed",
        "codex_herdr_hook_unavailable",
      ]);
    }
    const root = join(test.agentDirectory, "subagents", "herdr-host-v1");
    const entries = yield* step(() => fs.readdir(root));
    expect(entries).toHaveLength(1);
    expect((yield* step(() => fs.lstat(join(root, entries[0]!, "codex-home")))).isDirectory()).toBe(
      true,
    );
  });

  effectTest(
    "surfaces partial preparation cleanup uncertainty and preserves private state",
    function* () {
      const test = yield* step(setup);
      const harness = makeHerdrHarness({
        agentDirectory: test.agentDirectory,
        environment: test.environment,
        integrationPaths: test.integrations,
        harnessFault: "after-claude-settings",
        harnessCleanupFault: true,
      });
      yield* step(() =>
        expect(
          Effect.runPromise(
            Effect.scoped(harness.prepare("claude", launch("claude"), test.supervisor)),
          ),
        ).rejects.toMatchObject({
          _tag: "SubagentProcessError",
          code: "herdr_harness_cleanup_unconfirmed",
        }),
      );
      const root = join(test.agentDirectory, "subagents", "herdr-host-v1");
      const entries = yield* step(() => fs.readdir(root));
      expect(entries).toHaveLength(1);
      expect(yield* step(() => fs.readdir(join(root, entries[0]!)))).toContain(
        "claude-settings.json",
      );
    },
  );

  it("preserves Pi registry @ context variants as one Herdr model argument", () =>
    setup().then((test) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* test.harness.prepare(
              "pi",
              { ...launch("pi"), model: "openai/gpt-5.5@1m" },
              test.supervisor,
            );
            expect(valueAfter(prepared.argv, "--model")).toBe("openai/gpt-5.5@1m");
            prepared.authorizeCleanup();
          }),
        ),
      ),
    ));

  it("inherits and deterministically deduplicates Pi tools without an intent-based built-in set", () =>
    setup().then((test) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const activeTools = ["code_mode", "edit", "supervisor_progress", "code_mode"];
            const expected = [
              "code_mode",
              "edit",
              ...SUPERVISOR_MCP_TOOL_NAMES,
              ...SUBAGENT_TOOL_NAMES,
            ];
            const readOnly = yield* test.harness.prepare(
              "pi",
              { ...launch("pi"), activeTools },
              test.supervisor,
            );
            const writer = yield* test.harness.prepare(
              "pi",
              { ...launch("pi", "writer"), activeTools },
              test.supervisor,
            );
            const readOnlyTools = valueAfter(readOnly.argv, "--tools")?.split(",") ?? [];
            const writerTools = valueAfter(writer.argv, "--tools")?.split(",") ?? [];

            expect(readOnlyTools).toEqual(expected);
            expect(writerTools).toEqual(expected);
            for (const fixedTool of ["read", "grep", "find", "ls", "bash", "write"])
              expect(readOnlyTools).not.toContain(fixedTool);
            readOnly.authorizeCleanup();
            writer.authorizeCleanup();
          }),
        ),
      ),
    ));

  it("mirrors Pi project trust while retaining private resources and competing-tool exclusion", () =>
    setup().then((test) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const untrusted = yield* test.harness.prepare("pi", launch("pi"), test.supervisor);
            const trusted = yield* test.harness.prepare(
              "pi",
              { ...launch("pi"), projectTrusted: true },
              test.supervisor,
            );

            expect(untrusted.argv).toContain("--no-approve");
            expect(untrusted.argv).not.toContain("--approve");
            expect(trusted.argv).toContain("--approve");
            expect(trusted.argv).not.toContain("--no-approve");
            for (const prepared of [untrusted, trusted]) {
              expect(valueAfter(prepared.argv, "--model")).toBe("openai-codex/gpt-5.6-sol");
              expect(valueAfter(prepared.argv, "--thinking")).toBe("xhigh");
              expect(prepared.argv).toEqual(
                expect.arrayContaining([
                  "--no-skills",
                  "--no-prompt-templates",
                  "--no-context-files",
                ]),
              );
              expect(prepared.argv).not.toContain("--no-extensions");
              expect(prepared.argv).not.toContain("--no-themes");
              const extensions = prepared.argv.flatMap((value, index) =>
                value === "--extension" ? [prepared.argv[index + 1]] : [],
              );
              expect(extensions).toEqual([
                test.integrations.pi,
                expect.stringContaining("host-pi-supervisor-extension.ts"),
              ]);
              expect(valueAfter(prepared.argv, "--exclude-tools")).toBe(
                PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_ARGUMENT,
              );
              expect(valueAfter(prepared.argv, "--exclude-tools")).not.toContain("subagent_start");
              expect(valueAfter(prepared.argv, "--exclude-tools")).toContain("workflow_control");
              expect(prepared.argv.every((argument) => !hasControlCharacter(argument))).toBe(true);
            }
            const promptPath = valueAfter(untrusted.argv, "--append-system-prompt")!;
            expect(yield* Effect.promise(() => fs.readFile(promptPath, "utf8"))).toBe(
              launch("pi").systemPrompt,
            );
            expect(untrusted.secretCommand).not.toContain("pi-runtime-secret");
            expect(untrusted.secretCommand).toContain(
              untrusted.startupAttestation.secretReadyReceipt.path,
            );
            const bootstrapPath = join(untrusted.directory, "pi-environment.sh");
            const bootstrap = yield* Effect.promise(() => fs.readFile(bootstrapPath, "utf8"));
            expect(bootstrap).toContain("PI_SUBAGENT_RUNTIME_API_KEY='pi-runtime-secret'");
            expect((yield* Effect.promise(() => fs.stat(bootstrapPath))).mode & 0o777).toBe(0o600);
            expect(
              untrusted.environmentCommand({ paneId: "p", tabId: "t", workspaceId: "w" }),
            ).toContain("PI_SUBAGENT_CHILD='1'");
            untrusted.authorizeCleanup();
            trusted.authorizeCleanup();
          }),
        ),
      ),
    ));
});
