import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type ResolvedAdvisorConfig, writeRawAdvisorConfig } from "../src/config.ts";
import { type AdvisorSessionMetrics, registerAdvisorCommands } from "../src/settings.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
const tempDirectories: string[] = [];

function tempConfigPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-advisor-settings-"));
  tempDirectories.push(directory);
  return join(directory, "extensions", "pi-advisor.json");
}

function configAt(configPath: string): ResolvedAdvisorConfig {
  return {
    configPath,
    enabled: true,
    timeoutMs: 30_000,
    maxContextChars: 48_000,
    configured: false,
  };
}

function createCommands(
  initial: ResolvedAdvisorConfig,
  metrics: AdvisorSessionMetrics = {
    attempted: 0,
    pass: 0,
    revise: 0,
    failure: 0,
    discarded: 0,
  },
) {
  const commands = new Map<string, CommandHandler>();
  let current = initial;
  registerAdvisorCommands(
    {
      registerCommand: (name: string, command: { handler: CommandHandler }) => {
        commands.set(name, command.handler);
      },
    } as unknown as ExtensionAPI,
    {
      get: () => current,
      getMetrics: () => metrics,
      update: (next) => {
        current = next;
      },
    },
  );
  return { commands, getConfig: () => current };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("advisor commands", () => {
  test("settings picker selects an authenticated model and preserves unknown fields", async () => {
    const configPath = tempConfigPath();
    writeRawAdvisorConfig({ enabled: true, futureSetting: { keep: true } }, configPath);
    const harness = createCommands(configAt(configPath));
    const selections = ["Advisor model: not configured", "anthropic/claude-reviewer", "Done"];
    const notify = vi.fn();
    const ctx = {
      hasUI: true,
      ui: {
        notify,
        select: vi.fn(async () => selections.shift()),
      },
      modelRegistry: {
        getAvailable: () => [{ provider: "anthropic", id: "claude-reviewer" }],
      },
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-settings")?.("", ctx);

    expect(harness.getConfig()).toMatchObject({
      provider: "anthropic",
      model: "claude-reviewer",
      configured: true,
    });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      enabled: true,
      provider: "anthropic",
      model: "claude-reviewer",
      futureSetting: { keep: true },
    });
    expect(notify).not.toHaveBeenCalled();
  });

  test("settings picker updates enablement and bounded preset values", async () => {
    const configPath = tempConfigPath();
    const harness = createCommands(configAt(configPath));
    const selections = [
      "Automatic review: on",
      "Review timeout: 30s",
      "90s",
      "Context cap: 48,000 characters",
      "240,000 characters",
      "Done",
    ];
    const ctx = {
      hasUI: true,
      ui: {
        notify: vi.fn(),
        select: vi.fn(async () => selections.shift()),
      },
      modelRegistry: { getAvailable: () => [] },
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-settings")?.("", ctx);

    expect(harness.getConfig()).toMatchObject({
      enabled: false,
      timeoutMs: 90_000,
      maxContextChars: 240_000,
    });
  });

  test("settings reports when no authenticated models are available", async () => {
    const harness = createCommands(configAt(tempConfigPath()));
    const selections = ["Advisor model: not configured", "Done"];
    const notify = vi.fn();
    const ctx = {
      hasUI: true,
      ui: { notify, select: vi.fn(async () => selections.shift()) },
      modelRegistry: { getAvailable: () => [] },
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-settings")?.("", ctx);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("No authenticated models"),
      "warning",
    );
  });

  test("settings can clear a stale model when no authenticated models remain", async () => {
    const configPath = tempConfigPath();
    writeRawAdvisorConfig({ provider: "stale", model: "removed" }, configPath);
    const harness = createCommands({
      ...configAt(configPath),
      provider: "stale",
      model: "removed",
      configured: true,
    });
    const selections = ["Advisor model: stale/removed", "Clear advisor model", "Done"];
    const ctx = {
      hasUI: true,
      ui: { notify: vi.fn(), select: vi.fn(async () => selections.shift()) },
      modelRegistry: { getAvailable: () => [] },
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-settings")?.("", ctx);

    expect(harness.getConfig()).toMatchObject({ configured: false });
    expect(harness.getConfig().provider).toBeUndefined();
    expect(harness.getConfig().model).toBeUndefined();
  });

  test("status reports availability without exposing credential values", async () => {
    const configPath = tempConfigPath();
    const configured = {
      ...configAt(configPath),
      provider: "openai",
      model: "reviewer",
      configured: true,
    };
    const harness = createCommands(configured, {
      attempted: 5,
      pass: 1,
      revise: 1,
      failure: 1,
      discarded: 1,
    });
    const notify = vi.fn();
    const model = { provider: "openai", id: "reviewer" };
    const ctx = {
      ui: { notify },
      modelRegistry: {
        find: () => model,
        hasConfiguredAuth: () => true,
      },
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-status")?.("", ctx);

    const output = String(notify.mock.calls[0]?.[0]);
    expect(output).toContain("Advisor model: openai/reviewer");
    expect(output).toContain("Credentials configured: yes");
    expect(output).toContain("Session review attempts: 5");
    expect(output).toContain(
      "Session review outcomes: pass 1, revise 1, failure 1, discarded 1, in progress 1",
    );
    expect(output).toContain(configPath);
    expect(output).not.toMatch(/api[_-]?key|token|secret/i);
  });
});
