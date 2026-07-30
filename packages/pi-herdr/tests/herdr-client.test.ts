import { describe, expect, it } from "vitest";
import {
  buildAgentPromptArgs,
  buildClaudeStartArgs,
  buildCodexEnvironmentArgs,
  buildCodexStartArgs,
  buildPiStartArgs,
} from "../src/boundary/herdr-client.ts";

const valueAfter = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

const expectPrefix = (args: ReadonlyArray<string>, kind: "claude" | "pi" | "codex"): void => {
  expect(args.slice(0, 10)).toEqual([
    "agent",
    "start",
    "pih-review",
    "--kind",
    kind,
    "--pane",
    "w1:p2",
    "--timeout",
    "60000",
    "--",
  ]);
};

const expectNoControls = (args: ReadonlyArray<string>): void => {
  expect(args.every((arg) => ![...arg].some((character) => /\p{Cc}/u.test(character)))).toBe(true);
};

describe("Herdr multi-harness launch policy", () => {
  it("fixes Claude model, report MCP, and read-only tools", () => {
    const args = buildClaudeStartArgs({
      paneId: "w1:p2",
      name: "pih-review",
      model: "opus",
      mcpConfigPath: "/private/mcp.json",
      settingsPath: "/private/claude-settings.json",
    });
    expectPrefix(args, "claude");
    expect(valueAfter(args, "--model")).toBe("opus");
    expect(valueAfter(args, "--tools")).toBe("Read,Glob,Grep,WebFetch,WebSearch");
    expect(valueAfter(args, "--allowedTools")).toContain("mcp__herdr_report__submit_report");
    expect(valueAfter(args, "--disallowedTools")).toBe(
      "Bash,Edit,Write,NotebookEdit,MultiEdit,Agent,Task,Workflow",
    );
    expect(valueAfter(args, "--permission-mode")).toBe("dontAsk");
    expect(valueAfter(args, "--mcp-config")).toBe("/private/mcp.json");
    expect(valueAfter(args, "--setting-sources")).toBe("");
    expect(valueAfter(args, "--settings")).toBe("/private/claude-settings.json");
    expect(args).not.toContain("user");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--safe-mode");
    expect(args).not.toContain("--bare");
    expectNoControls(args);
  });

  it("isolates Pi resources and exposes only read tools plus the reporter", () => {
    const args = buildPiStartArgs({
      paneId: "w1:p2",
      name: "pih-review",
      model: "openai-codex/gpt-5.6-sol",
      integrationPath: "/agent/extensions/herdr-agent-state.ts",
      reportExtensionPath: "/package/host-report-extension.ts",
      reportDirectory: "/agent/herdr/reports/herdr-test",
      runId: "herdr-test",
      sessionDirectory: "/agent/herdr/reports/herdr-test/pi-sessions",
    });
    expectPrefix(args, "pi");
    expect(valueAfter(args, "--model")).toBe("openai-codex/gpt-5.6-sol");
    expect(valueAfter(args, "--tools")).toBe("read,grep,find,ls,herdr_report_submit");
    expect(valueAfter(args, "--exclude-tools")).toBe("bash,edit,write");
    expect(args).toContain("--no-approve");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-prompt-templates");
    expect(args).toContain("--no-context-files");
    expect(args.filter((arg) => arg === "--extension")).toHaveLength(2);
    expect(valueAfter(args, "--herdr-report-run-id")).toBe("herdr-test");
    expectNoControls(args);
  });

  it("pins Codex to its read-only sandbox and disables broad native features", () => {
    const args = buildCodexStartArgs({
      paneId: "w1:p2",
      name: "pih-review",
      model: "gpt-5.4",
    });
    expectPrefix(args, "codex");
    expect(valueAfter(args, "--model")).toBe("gpt-5.4");
    expect(valueAfter(args, "--sandbox")).toBe("read-only");
    expect(valueAfter(args, "--ask-for-approval")).toBe("never");
    expect(args).toContain("--no-alt-screen");
    expect(args).toContain("--dangerously-bypass-hook-trust");
    expect(args).toContain("multi_agent");
    expect(args).toContain("plugins");
    expect(args).toContain("apps");
    expect(args).not.toContain("hooks");
    expectNoControls(args);
  });

  it("prepares the isolated Codex home in the target shell", () => {
    expect(buildCodexEnvironmentArgs("w1:p2", "/private/codex home'; touch /tmp/pwn")).toEqual([
      "pane",
      "run",
      "w1:p2",
      "export CODEX_HOME='/private/codex home'\\''; touch /tmp/pwn'",
    ]);
  });

  it("dispatches prompts without synchronously waiting for task completion", () => {
    const args = buildAgentPromptArgs("pih-review", "Review this");
    expect(args).toEqual(["agent", "prompt", "pih-review", "Review this"]);
    expect(args).not.toContain("--wait");
  });
});
