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
    fastMode: false,
    thinkingLevel: "medium",
    reviewPolicy: "guardrail",
    timeoutMs: 30_000,
    maxContextChars: 48_000,
    configured: false,
  };
}

function zeroOutcomes(): AdvisorSessionMetrics["outcomes"] {
  return {
    pass: 0,
    findings: 0,
    advice: 0,
    guidance: 0,
    revision: 0,
    recovery: 0,
    suppressed: 0,
    discarded: 0,
    failures: 0,
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
    outcomes: zeroOutcomes(),
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
    writeRawAdvisorConfig(
      {
        enabled: true,
        futureSetting: { keep: true },
        revisionCooldownTurns: 5,
        tools: ["all", "write"],
      },
      configPath,
    );
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
        getAvailable: () => [
          {
            provider: "anthropic",
            id: "claude-reviewer",
            name: "Claude Reviewer",
            reasoning: true,
          },
        ],
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
      thinkingLevel: "medium",
      futureSetting: { keep: true },
      revisionCooldownTurns: 5,
      tools: ["all", "write"],
    });
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Could not save"), "error");
  });

  test("TUI model picker fuzzy-searches provider, model ID, and display name", async () => {
    const configPath = tempConfigPath();
    const harness = createCommands(configAt(configPath));
    const selections = ["Advisor model: not configured", "Done"];
    const custom = vi.fn(async (factory: unknown) => {
      return await new Promise<string | null>((resolve) => {
        const createComponent = factory as (
          tui: { requestRender(): void },
          theme: { bold(text: string): string; fg(color: string, text: string): string },
          keybindings: { matches(data: string, binding: string): boolean },
          done: (value: string | null) => void,
        ) => { handleInput?(data: string): void; render(width: number): string[] };
        const component = createComponent(
          { requestRender: vi.fn() },
          {
            bold: (text: string) => text,
            fg: (_color: string, text: string) => text,
          },
          {
            matches: (data: string, binding: string) =>
              (binding === "tui.select.confirm" && data === "\r") ||
              (binding === "tui.select.cancel" && data === "\u001b"),
          },
          resolve,
        ) as { handleInput?(data: string): void; render(width: number): string[] };
        component.handleInput?.("sonnet");
        expect(component.render(100).join("\n")).toContain("anthropic/claude-reviewer");
        expect(component.render(100).join("\n")).not.toContain("openai/gpt-reviewer");
        component.handleInput?.("\r");
      });
    });
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        custom,
        notify: vi.fn(),
        select: vi.fn(async () => selections.shift()),
      },
      modelRegistry: {
        getAvailable: () => [
          {
            provider: "openai",
            id: "gpt-reviewer",
            name: "GPT Reviewer",
            reasoning: true,
          },
          {
            provider: "anthropic",
            id: "claude-reviewer",
            name: "Sonnet Review Model",
            reasoning: true,
          },
        ],
      },
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-settings")?.("", ctx);

    expect(custom).toHaveBeenCalledOnce();
    expect(harness.getConfig()).toMatchObject({
      provider: "anthropic",
      model: "claude-reviewer",
      thinkingLevel: "medium",
    });
  });

  test("settings toggles fast mode for supported OpenAI advisor models", async () => {
    const configPath = tempConfigPath();
    writeRawAdvisorConfig(
      { provider: "openai-codex", model: "gpt-5.6-sol", fastMode: false },
      configPath,
    );
    const harness = createCommands({
      ...configAt(configPath),
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      configured: true,
    });
    const selections = ["OpenAI fast mode: off", "Done"];
    const ctx = {
      hasUI: true,
      ui: {
        notify: vi.fn(),
        select: vi.fn(async () => selections.shift()),
      },
      modelRegistry: {},
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-settings")?.("", ctx);

    expect(harness.getConfig().fastMode).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ fastMode: true });
  });

  test("reasoning picker offers only levels supported by the selected model", async () => {
    const configPath = tempConfigPath();
    writeRawAdvisorConfig(
      { provider: "review-provider", model: "review-model", thinkingLevel: "medium" },
      configPath,
    );
    const harness = createCommands({
      ...configAt(configPath),
      provider: "review-provider",
      model: "review-model",
      configured: true,
    });
    const selections = ["Reasoning level: medium", "max", "Done"];
    const select = vi.fn(async () => selections.shift());
    const ctx = {
      hasUI: true,
      ui: { notify: vi.fn(), select },
      modelRegistry: {
        find: () => ({
          provider: "review-provider",
          id: "review-model",
          reasoning: true,
          thinkingLevelMap: { xhigh: null, max: "max" },
        }),
      },
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-settings")?.("", ctx);

    expect(select).toHaveBeenNthCalledWith(2, "Advisor reasoning level", [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(harness.getConfig().thinkingLevel).toBe("max");
  });

  test("settings picker updates enablement and bounded preset values", async () => {
    const configPath = tempConfigPath();
    const harness = createCommands(configAt(configPath));
    const selections = [
      "Advisor supervision: on",
      "Advisor operation timeout: 30s",
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

  test("settings applies each change immediately before the menu closes", async () => {
    const configPath = tempConfigPath();
    const harness = createCommands(configAt(configPath));
    const selections = ["Advisor supervision: on", "Done"];
    const ctx = {
      hasUI: true,
      ui: { notify: vi.fn(), select: vi.fn(async () => selections.shift()) },
      modelRegistry: { getAvailable: () => [] },
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-settings")?.("", ctx);

    expect(harness.getConfig().enabled).toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ enabled: false });
  });

  test("settings exposes every tuning control in one flat menu and applies immediately", async () => {
    const configPath = tempConfigPath();
    const harness = createCommands(configAt(configPath));
    const selections = [
      "Behavior: Guardrail",
      "Corrective (recommended)",
      "Reasoning level: medium",
      "high",
      "Advisor operation timeout: 30s",
      "90s",
      "Context cap: 48,000 characters",
      "240,000 characters",
      "Done",
    ];
    const select = vi.fn(async (_title: string, _options: string[]) => selections.shift());
    const ctx = {
      hasUI: true,
      ui: { notify: vi.fn(), select },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-settings")?.("", ctx);

    expect(select.mock.calls[0]?.[0]).toBe("Advisor settings · changes apply immediately");
    expect(select.mock.calls[0]?.[1]).toEqual([
      "Advisor supervision: on",
      "Behavior: Guardrail",
      "Advisor model: not configured",
      "OpenAI fast mode: off",
      "Reasoning level: medium",
      "Advisor operation timeout: 30s",
      "Context cap: 48,000 characters",
      "Done",
    ]);
    expect(select.mock.calls.flatMap((call) => call[1] ?? [])).not.toContain("Advanced settings");
    expect(select.mock.calls.flatMap((call) => call[1] ?? [])).not.toContain("Apply changes");
    expect(harness.getConfig()).toMatchObject({
      reviewPolicy: "corrective",
      thinkingLevel: "high",
      timeoutMs: 90_000,
      maxContextChars: 240_000,
    });
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
      outcomes: zeroOutcomes(),
      backgroundState: "reviewing",
      cacheReadTokens: 30,
      activeCatchUpWaits: 1,
      activeToolNames: ["read", "grep", "find", "ls"],
      backlog: 7,
      cacheWriteTokens: 10,
      catchUpCancellations: 1,
      catchUpFailures: 2,
      catchUpTimeouts: 3,
      catchUpWaits: 6,
      childResets: 4,
      cost: 0.012345,
      guidancePaths: ["/tmp/ADVISOR.md"],
      inputTokens: 100,
      lastAction: "revision",
      latestDurationMs: 1234,
      outputTokens: 50,
      processedSequence: 12,
      queuedReviews: 1,
      sequence: 19,
      settledReviews: 4,
      suppressedFindings: 2,
      totalTokens: 190,
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
    const concise = String(notify.mock.calls[0]?.[0]);
    expect(concise).toContain("Advisor: on · Guardrail · openai/reviewer");
    expect(concise).toContain("Session: reviewing");
    expect(concise).toContain("Last advisor action: revision");
    expect(concise).not.toContain("Advisor tokens:");

    notify.mockClear();
    await harness.commands.get("advisor-status")?.("--verbose", ctx);

    const output = String(notify.mock.calls[0]?.[0]);
    expect(output).toContain("Advisor: on · Guardrail · openai/reviewer");
    expect(output).toContain("Model access: ready");
    expect(output).toContain("OpenAI fast mode: disabled");
    expect(output).toContain("Background state: reviewing (1 checkpoints, 7 observations)");
    expect(output).toContain("Advisor guidance: /tmp/ADVISOR.md");
    expect(output).toContain("Latest review duration: 1,234 ms");
    expect(output).toContain("Advisor tokens: input 100, output 50");
    expect(output).toContain("Advisor cost: $0.012345");
    expect(output).toContain("Last advisor action: revision");
    expect(output).toContain("Suppressed duplicate findings: 2");
    expect(output).toContain(
      "Interruption immunity: fixed at 3 subsequently completed primary turns",
    );
    expect(output).toContain("no second raw transcript");
    expect(output).toContain("processed 12 / 19");
    expect(output).toContain("waits 6, active 1, timeouts 3, failures 2, cancellations 1");
    expect(output).toContain("Child resets/reprimes: 4");
    expect(output).toContain("Active Advisor tools: read, grep, find, ls");
    expect(output).toContain("Session review attempts: 5");
    expect(output).toContain("Session reviews: settled 4, in progress 1");
    expect(output).toContain("Session review results: pass 1, revise 1, discarded 1");
    expect(output).toContain("Operational failures: 1");
    expect(output).toContain(configPath);
    expect(output).not.toMatch(/api[_-]?key|secret/i);
  });

  test("reports session usage with timing and per-model attribution", async () => {
    const configPath = tempConfigPath();
    const configured = {
      ...configAt(configPath),
      provider: "openai",
      model: "reviewer",
      thinkingLevel: "high" as const,
      configured: true,
    };
    const harness = createCommands(configured, {
      attempted: 5,
      pass: 3,
      revise: 1,
      failure: 0,
      discarded: 0,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
      cost: 0.012345,
      inputTokens: 1_000,
      latestDurationMs: 1_200,
      modelResponses: 6,
      outputTokens: 200,
      blockerVerificationAttempts: 2,
      blockersVerified: 3,
      blockersRejected: 1,
      outcomes: {
        pass: 3,
        findings: 1,
        advice: 0,
        guidance: 0,
        revision: 1,
        recovery: 0,
        suppressed: 0,
        discarded: 0,
        failures: 0,
      },
      settledReviews: 4,
      totalDurationMs: 10_000,
      totalTokens: 1_540,
      usageByModel: {
        first: {
          provider: "openai",
          model: "reviewer",
          responses: 5,
          cacheReadTokens: 300,
          cacheWriteTokens: 40,
          cost: 0.01,
          inputTokens: 900,
          outputTokens: 180,
          totalTokens: 1_420,
        },
        second: {
          provider: "anthropic",
          model: "backup",
          responses: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0.002345,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
      },
    });
    const notify = vi.fn();
    const ctx = {
      ui: { notify },
      modelRegistry: {
        find: () => ({ provider: "openai", id: "reviewer", reasoning: true }),
      },
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-usage")?.("", ctx);
    const output = String(notify.mock.calls[0]?.[0]);
    expect(output).toContain("Advisor usage · this session");
    expect(output).toContain("Current model: openai/reviewer · high · standard");
    expect(output).toContain("Model responses: 6");
    expect(output).toContain("Reviews: 5 attempted · 4 settled · 1 in progress");
    expect(output).toContain("Pass: 3 (75.0%)");
    expect(output).toContain("Finding reviews: 1 (25.0%)");
    expect(output).toContain("Delivered: 1 (100.0% of finding reviews)");
    expect(output).toContain(
      "Verification reviews: 2 attempted · blocker fingerprints 3 confirmed · 1 rejected",
    );
    expect(output).toContain("Input:        1,000");
    expect(output).toContain("Reported cost: $0.012345");
    expect(output).toContain("Review time: 10.0s total · 2.5s average · 1.2s latest");
    expect(output).toContain("openai/reviewer: 5 responses · 1,420 tokens · $0.010000");
    expect(output).toContain("anthropic/backup: 1 response · 120 tokens · $0.002345");
  });

  test("redacts provider and model labels in usage output", async () => {
    const configPath = tempConfigPath();
    const harness = createCommands(
      {
        ...configAt(configPath),
        provider: "openai-api-key=sk-abcdefghijklmnop",
        model: "reviewer-token=secret-value",
        configured: true,
      },
      {
        attempted: 0,
        pass: 0,
        revise: 0,
        failure: 0,
        discarded: 0,
        outcomes: zeroOutcomes(),
        usageByModel: {
          secret: {
            provider: "anthropic-token=another-secret-value",
            model: "model-password=hunter2",
            responses: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
        },
      },
    );
    const notify = vi.fn();
    await harness.commands.get("advisor-usage")?.("", {
      ui: { notify },
      modelRegistry: { find: () => undefined },
    } as unknown as ExtensionCommandContext);
    const output = String(notify.mock.calls[0]?.[0]);
    expect(output).toContain("REDACTED");
    expect(output).not.toMatch(/sk-abcdefghijklmnop|secret-value|hunter2/);
  });

  test("renders zero session usage without a model breakdown", async () => {
    const harness = createCommands(configAt(tempConfigPath()));
    const notify = vi.fn();
    const ctx = {
      ui: { notify },
      modelRegistry: { find: () => undefined },
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-usage")?.("", ctx);
    const output = String(notify.mock.calls[0]?.[0]);
    expect(output).toContain("Model responses: 0");
    expect(output).toContain("Reviews: 0 attempted · 0 settled · 0 in progress");
    expect(output).toContain("Review time: not available");
    expect(output).toContain("not available");
    expect(output).not.toMatch(/NaN|Infinity/);
    expect(output).not.toContain("\nModels\n");
  });

  test("attributes single-model historical usage after the configured model changes", async () => {
    const configPath = tempConfigPath();
    const harness = createCommands(
      {
        ...configAt(configPath),
        provider: "openai",
        model: "new-reviewer",
        configured: true,
      },
      {
        attempted: 1,
        pass: 1,
        revise: 0,
        failure: 0,
        discarded: 0,
        outcomes: zeroOutcomes(),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0.01,
        inputTokens: 100,
        modelResponses: 1,
        outputTokens: 20,
        settledReviews: 1,
        totalTokens: 120,
        usageByModel: {
          historical: {
            provider: "anthropic",
            model: "old-reviewer",
            responses: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0.01,
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
          },
        },
      },
    );
    const notify = vi.fn();
    const ctx = {
      ui: { notify },
      modelRegistry: { find: () => ({ provider: "openai", id: "new-reviewer" }) },
    } as unknown as ExtensionCommandContext;

    await harness.commands.get("advisor-usage")?.("", ctx);
    const output = String(notify.mock.calls[0]?.[0]);
    expect(output).toContain("Current model: openai/new-reviewer");
    expect(output).toContain("Models");
    expect(output).toContain("anthropic/old-reviewer: 1 response · 120 tokens · $0.010000");
  });
});
