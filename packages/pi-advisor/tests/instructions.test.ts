// Test harness boundary: only the diagnostics used by this file are suppressed.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  loadAdvisorInstructionsEffect,
  MAX_INSTRUCTION_BYTES,
} from "../src/review/instructions.ts";
import { standaloneAdvisorExecutor } from "./support/executor.ts";

const load = (configPath: string, cwd: string, projectTrusted: boolean) =>
  standaloneAdvisorExecutor.run(loadAdvisorInstructionsEffect(configPath, cwd, projectTrusted));

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "pi-advisor-instructions-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("advisor instructions", () => {
  test("loads global guidance before trusted project guidance", async () => {
    await withTempDir(async (directory) => {
      const agentDir = join(directory, "agent");
      const projectDir = join(directory, "project");
      const configPath = join(agentDir, "extensions", "pi-advisor.json");
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "ADVISOR.md"), "Watch global invariants.", "utf8");
      writeFileSync(join(projectDir, ".pi", "ADVISOR.md"), "Watch the project queue.", "utf8");

      const loaded = await load(configPath, projectDir, true);

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

  test("does not load project guidance for an untrusted project", async () => {
    await withTempDir(async (directory) => {
      const agentDir = join(directory, "agent");
      const projectDir = join(directory, "project");
      const configPath = join(agentDir, "extensions", "pi-advisor.json");
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(join(projectDir, ".pi", "ADVISOR.md"), "Untrusted guidance.", "utf8");

      expect(await load(configPath, projectDir, false)).toEqual({ paths: [] });
    });
  });

  test("bounds production guidance reads by bytes before decoding", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-advisor-instructions-"));
    try {
      const agentDir = join(directory, "agent");
      const configPath = join(agentDir, "extensions", "pi-advisor.json");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "ADVISOR.md"), "é".repeat(MAX_INSTRUCTION_BYTES), "utf8");

      const loaded = await load(configPath, directory, false);
      expect(loaded.content).toContain("[Advisor guidance truncated]");
      expect(loaded.content?.length).toBeLessThan(40_000);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("rejects symlink and FIFO guidance without blocking", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-advisor-instructions-special-"));
    try {
      const agentDir = join(directory, "agent");
      const configPath = join(agentDir, "extensions", "pi-advisor.json");
      mkdirSync(agentDir, { recursive: true });
      const outside = join(directory, "outside.md");
      writeFileSync(outside, "outside guidance");
      symlinkSync(outside, join(agentDir, "ADVISOR.md"));
      expect(await load(configPath, directory, false)).toEqual({ paths: [] });
      rmSync(join(agentDir, "ADVISOR.md"));
      if (process.platform !== "win32") {
        expect(spawnSync("mkfifo", [join(agentDir, "ADVISOR.md")]).status).toBe(0);
        const started = performance.now();
        expect(await load(configPath, directory, false)).toEqual({
          paths: [],
        });
        expect(performance.now() - started).toBeLessThan(1_000);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("ignores missing, empty, and unreadable-looking guidance paths", async () => {
    await withTempDir(async (directory) => {
      const configPath = join(directory, "agent", "extensions", "pi-advisor.json");
      mkdirSync(join(directory, "agent"), { recursive: true });
      writeFileSync(join(directory, "agent", "ADVISOR.md"), "   ", "utf8");

      expect(await load(configPath, join(directory, "project"), true)).toEqual({
        paths: [],
      });
    });
  });
});
