// Private harness files are intentional boundary-test IO.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrCodexHooksError, makeHerdrCodexHooks } from "../src/boundary/herdr-codex-hooks.ts";
import { makeHerdrHarness } from "../src/boundary/herdr-harness.ts";
import type { SupervisorConnectionMetadata } from "../src/boundary/supervisor-channel.ts";
import type { BackendLaunchRequest } from "../src/backend/model.ts";

const codexHookFixture = fileURLToPath(
  new URL("./fixtures/codex-hook-trust-fixture.mjs", import.meta.url),
);
const directories: string[] = [];
const valueAfter = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });

const setup = async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-herdr-harness-"));
  directories.push(directory);
  const home = join(directory, "home");
  const agentDirectory = join(directory, "agent");
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  const integrations = {
    pi: join(directory, "pi-integration.ts"),
    claude: join(directory, "claude-integration.sh"),
    codex: join(directory, "codex-integration.sh"),
  } as const;
  const integrationVersions = { pi: 8, claude: 7, codex: 7 } as const;
  for (const [runtime, path] of Object.entries(integrations))
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    await fs.writeFile(
      path,
      `# installed by herdr\nHERDR_INTEGRATION_ID=${runtime}\nHERDR_INTEGRATION_VERSION=${integrationVersions[runtime as keyof typeof integrationVersions]}\n`,
      { mode: 0o600 },
    );
  const codexSource = join(home, ".codex");
  await fs.mkdir(codexSource, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    join(codexSource, "auth.json"),
    JSON.stringify({ tokens: { access: "private" } }),
    {
      mode: 0o600,
    },
  );
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
    PATH: process.env.PATH,
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
  fastMode: false,
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

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Herdr native harness security", () => {
  it("rejects unrepresentable Claude writer cwd rules during topology-free preflight", async () => {
    const test = await setup();
    for (const cwd of ["/repo,other", "/repo/(group)", "/repo/*/glob"]) {
      await expect(
        Effect.runPromise(
          test.harness.preflight("claude", {
            ...launch("claude", "writer"),
            cwd,
          }),
        ),
      ).rejects.toMatchObject({ code: "claude_writer_confinement_unsupported" });
    }
    await expect(
      Effect.runPromise(
        test.harness.preflight("claude", {
          ...launch("claude", "writer"),
          cwd: "/repo-safe/path_1",
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("uses the shared safe model-selector grammar for every Herdr runtime", async () => {
    const test = await setup();
    for (const runtime of ["pi", "claude", "codex"] as const)
      for (const model of ["-leading-option", "model with spaces", "model,(glob)*"]) {
        await expect(
          Effect.runPromise(test.harness.preflight(runtime, { ...launch(runtime), model })),
        ).rejects.toMatchObject({ code: `${runtime}_model_unsupported` });
      }
  });

  it("requires the current Herdr 0.8 integration marker versions", async () => {
    const test = await setup();
    await fs.writeFile(
      test.integrations.pi,
      "// installed by herdr\n// HERDR_INTEGRATION_ID=pi\n// HERDR_INTEGRATION_VERSION=6\n",
    );
    await expect(
      Effect.runPromise(test.harness.preflight("pi", launch("pi"))),
    ).rejects.toMatchObject({ code: "pi_herdr_integration_unavailable" });
  });

  it("rejects control-bearing inherited harness values before topology ownership", async () => {
    const test = await setup();
    const harness = makeHerdrHarness({
      agentDirectory: test.agentDirectory,
      environment: { ...test.environment, PATH: "bad\u0085path" },
      integrationPaths: test.integrations,
    });
    await expect(Effect.runPromise(harness.preflight("pi", launch("pi")))).rejects.toMatchObject({
      code: "herdr_environment_invalid",
    });
  });

  it("rejects every Windows Herdr harness before topology ownership", async () => {
    const test = await setup();
    const harness = makeHerdrHarness({
      agentDirectory: test.agentDirectory,
      environment: test.environment,
      integrationPaths: test.integrations,
      platform: "win32",
    });
    await expect(Effect.runPromise(harness.preflight("pi", launch("pi")))).rejects.toMatchObject({
      code: "herdr_platform_unsupported",
    });
  });

  it("rejects read-only Claude Bash where the strict sandbox is unsupported", async () => {
    const test = await setup();
    const harness = makeHerdrHarness({
      agentDirectory: test.agentDirectory,
      environment: test.environment,
      integrationPaths: test.integrations,
      platform: "freebsd",
    });
    await expect(
      Effect.runPromise(harness.preflight("claude", launch("claude"))),
    ).rejects.toMatchObject({ code: "claude_shell_confinement_unsupported" });
  });

  it("exposes read-only Claude Bash only through the strict sandbox", async () => {
    const test = await setup();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prepared = yield* test.harness.prepare("claude", launch("claude"), test.supervisor);
          expect(valueAfter(prepared.argv, "--tools")).toContain("Bash");
          expect(valueAfter(prepared.argv, "--tools")).not.toContain("Edit");
          const allowed = valueAfter(prepared.argv, "--allowedTools")?.split(",") ?? [];
          expect(allowed).not.toContain("Bash");
          expect(allowed).not.toContain("Edit");
          expect(allowed).not.toContain("Write");
          const settings = JSON.parse(
            yield* Effect.promise(() =>
              fs.readFile(valueAfter(prepared.argv, "--settings")!, "utf8"),
            ),
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
    );
  });

  it("fixes Claude args and reuses strict cwd-scoped writer policy", async () => {
    const test = await setup();
    await Effect.runPromise(
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
          expect(environmentCommand).not.toContain(prepared.environmentReadyMarker);
          const firstActivation = prepared.activationProbe(1);
          const secondActivation = prepared.activationProbe(2);
          expect(firstActivation.marker).not.toBe(secondActivation.marker);
          expect(firstActivation.command).toContain(firstActivation.marker.slice(0, 20));
          expect(secondActivation.command).toContain(secondActivation.marker.slice(0, 20));
          const environmentShell = prepared.shellReadinessProbe("environment");
          const secretShell = prepared.shellReadinessProbe("secrets");
          expect(environmentShell.marker).not.toBe(secretShell.marker);
          expect(environmentShell.command).toContain(environmentShell.marker.slice(0, 20));
          expect(secretShell.command).toContain(secretShell.marker.slice(0, 20));
          const settings = JSON.parse(
            yield* Effect.promise(() =>
              fs.readFile(valueAfter(prepared.argv, "--settings")!, "utf8"),
            ),
          );
          expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true });
          expect(settings.env).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
          expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
            "claude-integration.sh",
          );
          prepared.authorizeCleanup();
        }),
      ),
    );
  });

  it("propagates fast mode to Herdr Pi and Codex without exposing a credential", async () => {
    const test = await setup();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pi = yield* test.harness.prepare(
            "pi",
            { ...launch("pi"), fastMode: true },
            test.supervisor,
          );
          expect(pi.argv).toContain("--pi-subagents-fast-mode");

          const codex = yield* test.harness.prepare(
            "codex",
            { ...launch("codex"), fastMode: true },
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
    );
  });

  it("isolates Codex auth/config and never places secrets in Herdr agent argv", async () => {
    const test = await setup();
    await Effect.runPromise(
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
          const hooks = JSON.parse(
            yield* Effect.promise(() => fs.readFile(join(codexHome, "hooks.json"), "utf8")),
          );
          const sessionStart = hooks.hooks.SessionStart[0];
          expect(sessionStart.matcher).toBe("startup");
          expect(sessionStart.hooks[0]).toMatchObject({ type: "command", timeout: 10 });
          expect(sessionStart.hooks[0].command).toContain("herdr-codex-session-hook.mjs");
          const config = yield* Effect.promise(() =>
            fs.readFile(join(codexHome, "config.toml"), "utf8"),
          );
          expect(config).toContain('approval_policy = "never"');
          expect(config).toContain("multi_agent = false");
          expect(config).toContain("[mcp_servers.pi_subagents_supervisor]");
          const auth = yield* Effect.promise(() =>
            fs.readFile(join(codexHome, "auth.json"), "utf8"),
          );
          expect(JSON.parse(auth)).toEqual({
            tokens: { access: "private" },
          });
          prepared.authorizeCleanup();
        }),
      ),
    );
  });

  it("removes private Codex state when exact hook trust cannot be established", async () => {
    const test = await setup();
    const failing = makeHerdrHarness({
      agentDirectory: test.agentDirectory,
      environment: test.environment,
      integrationPaths: test.integrations,
      codexHooks: {
        establishTrust: () =>
          Effect.fail(new HerdrCodexHooksError({ code: "codex_herdr_hook_unavailable" })),
      },
    });
    await expect(
      Effect.runPromise(Effect.scoped(failing.prepare("codex", launch("codex"), test.supervisor))),
    ).rejects.toMatchObject({ code: "codex_herdr_hook_unavailable" });
    await expect(
      fs.readdir(join(test.agentDirectory, "subagents", "herdr-host-v1")),
    ).resolves.toEqual([]);
  });

  it("pins the sanitized inherited environment at harness construction", async () => {
    const test = await setup();
    test.environment.HOME = join(test.directory, "redirected-home");
    test.environment.HERDR_SOCKET_PATH = "/redirected/herdr.sock";
    test.environment.OPENAI_API_KEY = "redirected-secret";
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prepared = yield* test.harness.prepare("codex", launch("codex"), test.supervisor);
          const auth = yield* Effect.promise(() =>
            fs.readFile(join(prepared.directory, "codex-home", "auth.json"), "utf8"),
          );
          expect(JSON.parse(auth)).toEqual({ tokens: { access: "private" } });
          expect(prepared.secretCommand).not.toContain("redirected-secret");
          expect(
            prepared.environmentCommand({ paneId: "p", tabId: "t", workspaceId: "w" }),
          ).toContain("HERDR_SOCKET_PATH='/private/herdr.sock'");
          prepared.authorizeCleanup();
        }),
      ),
    );
  });

  it("surfaces partial preparation cleanup uncertainty and preserves private state", async () => {
    const test = await setup();
    const harness = makeHerdrHarness({
      agentDirectory: test.agentDirectory,
      environment: test.environment,
      integrationPaths: test.integrations,
      harnessFault: "after-claude-settings",
      harnessCleanupFault: true,
    });
    await expect(
      Effect.runPromise(
        Effect.scoped(harness.prepare("claude", launch("claude"), test.supervisor)),
      ),
    ).rejects.toMatchObject({
      _tag: "SubagentProcessError",
      code: "herdr_harness_cleanup_unconfirmed",
    });
    const root = join(test.agentDirectory, "subagents", "herdr-host-v1");
    const entries = await fs.readdir(root);
    expect(entries).toHaveLength(1);
    expect(await fs.readdir(join(root, entries[0]!))).toContain("claude-settings.json");
  });

  it("preserves Pi registry @ context variants as one Herdr model argument", async () => {
    const test = await setup();
    await Effect.runPromise(
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
    );
  });

  it("loads only fixed Pi resources, fresh session state, child marker, and bridge tools", async () => {
    const test = await setup();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prepared = yield* test.harness.prepare("pi", launch("pi"), test.supervisor);
          expect(valueAfter(prepared.argv, "--model")).toBe("openai-codex/gpt-5.6-sol");
          expect(valueAfter(prepared.argv, "--thinking")).toBe("xhigh");
          expect(prepared.argv).toContain("--no-extensions");
          expect(prepared.argv).toContain("--no-skills");
          expect(prepared.argv).toContain("--no-prompt-templates");
          expect(prepared.argv).toContain("--no-themes");
          expect(prepared.argv).toContain("--no-context-files");
          expect(prepared.argv.filter((value) => value === "--extension")).toHaveLength(2);
          expect(valueAfter(prepared.argv, "--tools")).toContain("bash");
          expect(valueAfter(prepared.argv, "--tools")).not.toContain("edit");
          expect(valueAfter(prepared.argv, "--tools")).not.toContain("write");
          expect(valueAfter(prepared.argv, "--tools")).toContain("supervisor_submit_report");
          expect(valueAfter(prepared.argv, "--exclude-tools")).toContain("subagent_start");
          expect(valueAfter(prepared.argv, "--exclude-tools")).toContain("workflow_control");
          const promptPath = valueAfter(prepared.argv, "--append-system-prompt")!;
          expect(yield* Effect.promise(() => fs.readFile(promptPath, "utf8"))).toBe(
            launch("pi").systemPrompt,
          );
          expect(prepared.argv.every((argument) => !hasControlCharacter(argument))).toBe(true);
          expect(prepared.secretCommand).not.toContain("pi-runtime-secret");
          expect(prepared.secretCommand).not.toContain(prepared.secretReadyMarker);
          const bootstrapPath = join(prepared.directory, "pi-environment.sh");
          const bootstrap = yield* Effect.promise(() => fs.readFile(bootstrapPath, "utf8"));
          expect(bootstrap).toContain("PI_SUBAGENT_RUNTIME_API_KEY='pi-runtime-secret'");
          expect((yield* Effect.promise(() => fs.stat(bootstrapPath))).mode & 0o777).toBe(0o600);
          expect(
            prepared.environmentCommand({ paneId: "p", tabId: "t", workspaceId: "w" }),
          ).toContain("PI_SUBAGENT_CHILD='1'");
          prepared.authorizeCleanup();
        }),
      ),
    );
  });
});
