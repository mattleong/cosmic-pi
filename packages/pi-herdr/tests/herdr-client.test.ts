import { describe, expect, it } from "vitest";
import { buildClaudePromptArgs, buildClaudeStartArgs } from "../src/boundary/herdr-client.ts";

const valueAfter = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

describe("Herdr Claude launch policy", () => {
  it("fixes the harness, pane, no-focus automation, and read-only tool policy", () => {
    const args = buildClaudeStartArgs({
      paneId: "w1:p2",
      name: "pih-review",
      mcpConfigPath: "/private/mcp.json",
    });
    expect(args.slice(0, 10)).toEqual([
      "agent",
      "start",
      "pih-review",
      "--kind",
      "claude",
      "--pane",
      "w1:p2",
      "--timeout",
      "60000",
      "--",
    ]);
    expect(valueAfter(args, "--tools")).toBe("Read,Glob,Grep,WebFetch,WebSearch");
    expect(valueAfter(args, "--allowedTools")).toContain("mcp__herdr_report__submit_report");
    expect(valueAfter(args, "--disallowedTools")).toBe(
      "Bash,Edit,Write,NotebookEdit,MultiEdit,Agent,Task,Workflow",
    );
    expect(valueAfter(args, "--permission-mode")).toBe("dontAsk");
    expect(valueAfter(args, "--mcp-config")).toBe("/private/mcp.json");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--safe-mode");
    expect(args).not.toContain("--bare");
    expect(args.every((arg) => ![...arg].some((character) => /\p{Cc}/u.test(character)))).toBe(
      true,
    );
  });

  it("dispatches prompts without synchronously waiting for task completion", () => {
    const args = buildClaudePromptArgs("pih-review", "Review this");
    expect(args).toEqual(["agent", "prompt", "pih-review", "Review this"]);
    expect(args).not.toContain("--wait");
  });
});
