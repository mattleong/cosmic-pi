import { describe, expect, it } from "vitest";
import {
  claudeArgv,
  claudeSettings,
  CLAUDE_DENIED_TOOLS,
  CLAUDE_NATIVE_AGENT_TOOLS,
} from "../src/backend/claude-policy.ts";

const launch = (writeIntent: "read-only" | "writer") => ({
  cwd: "/repo",
  writeIntent,
  model: "claude-native",
  effort: "high" as const,
});

const harness = {
  settingsPath: "/private/settings.json",
  mcpPath: "/private/mcp.json",
  promptPath: "/private/prompt.md",
};

describe("Claude native-agent policy", () => {
  it("allows native agent controls while preserving the parent's sandbox policy", () => {
    for (const writeIntent of ["read-only", "writer"] as const) {
      const writerPolicy =
        writeIntent === "writer" ? { cwd: "/repo", scopedEditRule: "Edit(//repo/**)" } : undefined;
      const settings = claudeSettings(launch(writeIntent), writerPolicy);
      for (const tool of CLAUDE_NATIVE_AGENT_TOOLS) {
        expect(settings.permissions.allow).toContain(tool);
        expect(settings.permissions.deny).not.toContain(tool);
      }
      expect(settings.sandbox.filesystem.allowWrite).toEqual(
        writeIntent === "writer" ? ["/repo"] : [],
      );
      expect(settings.sandbox.filesystem.denyWrite).toEqual(
        writeIntent === "read-only" ? ["/repo"] : [],
      );
      expect(claudeArgv(launch(writeIntent), harness, writerPolicy)).toContain(
        "--forward-subagent-text",
      );
    }
    expect(CLAUDE_DENIED_TOOLS).not.toEqual(
      expect.arrayContaining(["Agent", "Task", "TaskOutput", "TaskStop", "SendMessage"]),
    );
  });
});
