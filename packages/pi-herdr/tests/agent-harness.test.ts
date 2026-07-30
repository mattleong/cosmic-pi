// Node filesystem setup characterizes the isolated child-harness boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentDirectory } from "pi-cosmic-core";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../src/boundary/agent-harness.ts";
import type { PreparedReportChannel } from "../src/boundary/report-channel.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-harness-"));
  roots.push(root);
  const agentDirectory = join(root, "agent");
  const sourceCodexHome = join(root, "source-codex");
  const piIntegrationPath = join(root, "herdr-pi.ts");
  const claudeIntegrationPath = join(root, "herdr-claude.sh");
  const codexIntegrationPath = join(sourceCodexHome, "herdr-agent-state.sh");
  const directory = join(agentDirectory, "herdr", "reports", "herdr-test");
  await mkdir(sourceCodexHome, { recursive: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(sourceCodexHome, "auth.json"), "{}\n", { mode: 0o600 });
  await writeFile(
    codexIntegrationPath,
    "#!/bin/sh\n# installed by herdr\n# HERDR_INTEGRATION_ID=codex\n",
    { mode: 0o700 },
  );
  await writeFile(
    claudeIntegrationPath,
    "#!/bin/sh\n# installed by herdr\n# HERDR_INTEGRATION_ID=claude\n",
    { mode: 0o700 },
  );
  await writeFile(
    piIntegrationPath,
    "// installed by herdr\n// HERDR_INTEGRATION_ID=pi\nexport default () => {};\n",
    { mode: 0o600 },
  );
  const channel: PreparedReportChannel = {
    runId: "herdr-test",
    agentName: "pih-test",
    generation: "herdr-test",
    directory,
    helperPath: join(root, "report-helper.mjs"),
    mcpConfigPath: join(directory, "mcp.json"),
  };
  const layer = AgentHarness.layer({
    claudeIntegrationPath,
    sourceCodexHome,
    piIntegrationPath,
  }).pipe(Layer.provide(AgentDirectory.layer(agentDirectory)));
  const prepare = (kind: "claude" | "pi" | "codex") =>
    Effect.runPromise(
      AgentHarness.use((service) => service.prepare(kind, join(root, "repo"), channel)).pipe(
        Effect.provide(layer),
      ),
    );
  return {
    root,
    sourceCodexHome,
    piIntegrationPath,
    claudeIntegrationPath,
    codexIntegrationPath,
    channel,
    prepare,
  };
};

describe("AgentHarness", () => {
  it("prepares provider-specific private launch artifacts", async () => {
    const test = await fixture();
    const claude = await test.prepare("claude");
    expect(claude).toMatchObject({
      kind: "claude",
      mcpConfigPath: test.channel.mcpConfigPath,
    });
    if (claude.kind !== "claude") throw new Error("expected Claude harness");
    const claudeSettings = JSON.parse(await readFile(claude.settingsPath, "utf8"));
    expect(claudeSettings).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: `bash '${test.claudeIntegrationPath}' session`,
                timeout: 10,
              },
            ],
          },
        ],
      },
    });

    const pi = await test.prepare("pi");
    expect(pi).toMatchObject({
      kind: "pi",
      integrationPath: test.piIntegrationPath,
      runId: "herdr-test",
      reportDirectory: test.channel.directory,
    });
    if (pi.kind !== "pi") throw new Error("expected Pi harness");
    expect((await stat(pi.sessionDirectory)).mode & 0o777).toBe(0o700);

    const codex = await test.prepare("codex");
    if (codex.kind !== "codex") throw new Error("expected Codex harness");
    expect(await readFile(join(codex.codexHome, "auth.json"), "utf8")).toBe("{}\n");
    expect((await stat(join(codex.codexHome, "auth.json"))).isSymbolicLink()).toBe(false);
    expect((await stat(join(codex.codexHome, "auth.json"))).mode & 0o777).toBe(0o600);
    const config = await readFile(join(codex.codexHome, "config.toml"), "utf8");
    expect(config).toContain('sandbox_mode = "read-only"');
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain("[mcp_servers.herdr_report]");
    expect(config).toContain('enabled_tools = ["submit_report"]');
    expect(config).toContain('trust_level = "untrusted"');
    expect(config).toContain("multi_agent = false");
    expect(config).toContain("hooks = true");
    const hooks = JSON.parse(await readFile(join(codex.codexHome, "hooks.json"), "utf8"));
    expect(hooks).toEqual({
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: `bash '${test.codexIntegrationPath}' session` }],
          },
        ],
      },
    });
    expect((await stat(join(codex.codexHome, "config.toml"))).mode & 0o777).toBe(0o600);
  });

  it("fails closed when the selected Herdr integration is absent", async () => {
    const test = await fixture();
    await rm(test.piIntegrationPath);
    await expect(test.prepare("pi")).rejects.toMatchObject({
      _tag: "HerdrHarnessError",
      code: "pi_integration_required",
    });
  });
});
