import { describe, expect, it } from "vitest";
import {
  claudeArgv,
  claudeSettings,
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

const SHARED_CLAUDE_TEMPORARY_DIRECTORY = "/private/tmp/claude-501";

describe("Claude native-agent policy", () => {
  it("allows native agent controls while preserving the parent's sandbox policy", () => {
    for (const writeIntent of ["read-only", "writer"] as const) {
      const writerPolicy =
        writeIntent === "writer" ? { cwd: "/repo", scopedEditRule: "Edit(//repo/**)" } : undefined;
      const settings = claudeSettings(
        launch(writeIntent),
        writerPolicy,
        SHARED_CLAUDE_TEMPORARY_DIRECTORY,
      );
      expect(settings.crossSessionInbound).toBe("refuse");
      for (const tool of CLAUDE_NATIVE_AGENT_TOOLS) {
        expect(settings.permissions.allow).toContain(tool);
        expect(settings.permissions.deny).not.toContain(tool);
      }
      expect(settings.sandbox.filesystem.allowWrite).toEqual(
        writeIntent === "writer" ? ["/repo"] : [],
      );
      expect(settings.sandbox.filesystem.denyWrite).toEqual(
        writeIntent === "read-only"
          ? ["/repo", SHARED_CLAUDE_TEMPORARY_DIRECTORY]
          : [SHARED_CLAUDE_TEMPORARY_DIRECTORY],
      );
      expect(claudeArgv(launch(writeIntent), harness, writerPolicy)).toContain(
        "--forward-subagent-text",
      );
    }
  });
});
