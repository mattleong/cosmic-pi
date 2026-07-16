import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadAdvisorInstructions } from "../src/instructions.ts";

function withTempDir<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "pi-advisor-instructions-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("advisor instructions", () => {
  test("loads global guidance before trusted project guidance", () => {
    withTempDir((directory) => {
      const agentDir = join(directory, "agent");
      const projectDir = join(directory, "project");
      const configPath = join(agentDir, "extensions", "pi-advisor.json");
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "ADVISOR.md"), "Watch global invariants.", "utf8");
      writeFileSync(join(projectDir, ".pi", "ADVISOR.md"), "Watch the project queue.", "utf8");

      const loaded = loadAdvisorInstructions(configPath, projectDir, true);

      expect(loaded.paths).toEqual([
        join(agentDir, "ADVISOR.md"),
        join(projectDir, ".pi", "ADVISOR.md"),
      ]);
      expect(loaded.content).toContain("Watch global invariants.");
      expect(loaded.content).toContain("Watch the project queue.");
      expect(loaded.content?.indexOf("global")).toBeLessThan(
        loaded.content?.indexOf("project") ?? 0,
      );
    });
  });

  test("does not load project guidance for an untrusted project", () => {
    withTempDir((directory) => {
      const agentDir = join(directory, "agent");
      const projectDir = join(directory, "project");
      const configPath = join(agentDir, "extensions", "pi-advisor.json");
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(join(projectDir, ".pi", "ADVISOR.md"), "Untrusted guidance.", "utf8");

      expect(loadAdvisorInstructions(configPath, projectDir, false)).toEqual({ paths: [] });
    });
  });

  test("ignores missing, empty, and unreadable-looking guidance paths", () => {
    withTempDir((directory) => {
      const configPath = join(directory, "agent", "extensions", "pi-advisor.json");
      mkdirSync(join(directory, "agent"), { recursive: true });
      writeFileSync(join(directory, "agent", "ADVISOR.md"), "   ", "utf8");

      expect(loadAdvisorInstructions(configPath, join(directory, "project"), true)).toEqual({
        paths: [],
      });
    });
  });
});
