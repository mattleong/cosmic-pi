import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getAdvisorFailureLogPath, logAdvisorFailure } from "../src/failure-log.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("advisor failure log", () => {
  test("writes a structured diagnostic without prompt or credential data", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-advisor-log-"));
    tempDirectories.push(agentDir);
    const configPath = join(agentDir, "extensions", "pi-advisor.json");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    const error = new Error("provider request timed out");

    const logPath = logAdvisorFailure(configPath, {
      contextChars: 12_345,
      durationMs: 30_001.6,
      error,
      model: "review-model",
      provider: "review-provider",
      timeoutMs: 30_000,
    });

    expect(logPath).toBe(join(agentDir, "logs", "pi-advisor.jsonl"));
    const entry = JSON.parse(readFileSync(logPath!, "utf8")) as Record<string, unknown>;
    expect(entry).toMatchObject({
      provider: "review-provider",
      model: "review-model",
      timeoutMs: 30_000,
      contextChars: 12_345,
      durationMs: 30_002,
      error: {
        name: "Error",
        message: "provider request timed out",
      },
    });
    expect(entry.timestamp).toEqual(expect.any(String));
    expect(JSON.stringify(entry)).not.toContain("prompt");
    expect(JSON.stringify(entry)).not.toContain("credential");
  });

  test("derives the log alongside the agent extensions directory", () => {
    expect(getAdvisorFailureLogPath("/home/user/.pi/agent/extensions/pi-advisor.json")).toBe(
      "/home/user/.pi/agent/logs/pi-advisor.jsonl",
    );
  });
});
