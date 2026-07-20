// Test harness boundary: only the diagnostics used by this file are suppressed.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, test } from "vitest";
import { standaloneAdvisorExecutor } from "../src/boundary/executor.ts";
import {
  getAdvisorFailureLogPath,
  logAdvisorFailure,
  logAdvisorFailureAsync,
  logAdvisorFailureEffect,
} from "../src/failure-log.ts";

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

  test("does not invoke hostile error accessors", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-advisor-hostile-log-"));
    tempDirectories.push(agentDir);
    const configPath = join(agentDir, "extensions", "pi-advisor.json");
    const error = Object.defineProperty({}, "message", {
      get() {
        throw new Error("getter executed");
      },
    });
    expect(() =>
      logAdvisorFailure(configPath, {
        contextChars: 1,
        durationMs: 2,
        error,
        timeoutMs: 3,
      }),
    ).not.toThrow();
    expect(readFileSync(getAdvisorFailureLogPath(configPath), "utf8")).toContain("Unknown error.");
  });

  test("redacts and clips provider and model labels before persistence", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-advisor-label-log-"));
    tempDirectories.push(agentDir);
    const configPath = join(agentDir, "extensions", "pi-advisor.json");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });

    const logPath = logAdvisorFailure(configPath, {
      contextChars: 1,
      durationMs: 2,
      error: new Error("failed"),
      model: `model-token=secret-value-${"x".repeat(400)}`,
      provider: "provider-api_key=sk-abcdefghijklmnop",
      timeoutMs: 3,
    });
    const persisted = readFileSync(logPath!, "utf8");
    const entry = JSON.parse(persisted) as { provider: string; model: string };

    expect(persisted).not.toMatch(/secret-value|sk-abcdefghijklmnop/);
    expect(persisted).toContain("REDACTED");
    expect(entry.provider.length).toBeLessThanOrEqual(256);
    expect(entry.model.length).toBeLessThanOrEqual(256);
  });

  test("redacts credential-like text from persisted error messages and stacks", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-advisor-secret-log-"));
    tempDirectories.push(agentDir);
    const configPath = join(agentDir, "extensions", "pi-advisor.json");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    const error = new Error("Authorization: Bearer abc.def.ghi OPENAI_API_KEY=sk-abcdefghijklmnop");
    error.name = "Provider_OPENAI_API_KEY=name-secret-value";
    error.stack = `Error: token=generic-secret-value\n at provider (api_key=sk-secondsecretvalue)`;

    const logPath = logAdvisorFailure(configPath, {
      contextChars: 1,
      durationMs: 2,
      error,
      timeoutMs: 3,
    });
    const persisted = readFileSync(logPath!, "utf8");

    expect(persisted).not.toMatch(
      /abc\.def\.ghi|sk-abcdefghijklmnop|generic-secret-value|sk-secondsecretvalue|name-secret-value/,
    );
    expect(persisted).toContain("REDACTED");
  });

  test("serializes concurrent production appends and enforces private mode", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-advisor-concurrent-log-"));
    tempDirectories.push(agentDir);
    const configPath = join(agentDir, "extensions", "pi-advisor.json");
    await standaloneAdvisorExecutor.run(
      Effect.forEach(
        Array.from({ length: 50 }, (_, index) => index),
        (index) =>
          logAdvisorFailureEffect(configPath, {
            contextChars: index,
            durationMs: index,
            error: new Error(`failure-${index}`),
            timeoutMs: 30_000,
          }),
        { concurrency: "unbounded" },
      ),
    );
    const path = getAdvisorFailureLogPath(configPath);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(50);
    expect(lines.every((line) => JSON.parse(line))).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("serializes exported helpers across separately provided Layers", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-advisor-exported-log-"));
    tempDirectories.push(agentDir);
    const configPath = join(agentDir, "extensions", "pi-advisor.json");
    const paths = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        logAdvisorFailureAsync(configPath, {
          contextChars: index,
          durationMs: index,
          error: new Error(`exported-${index}`),
          timeoutMs: 30_000,
        }),
      ),
    );
    expect(paths.every(Boolean)).toBe(true);
    const lines = readFileSync(getAdvisorFailureLogPath(configPath), "utf8").trim().split("\n");
    expect(lines).toHaveLength(30);
  });

  test("tightens existing log directories and legacy rotated files in Effect and sync paths", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-advisor-legacy-log-"));
    tempDirectories.push(agentDir);
    const configPath = join(agentDir, "extensions", "pi-advisor.json");
    const logPath = getAdvisorFailureLogPath(configPath);
    const logDirectory = join(agentDir, "logs");
    mkdirSync(logDirectory, { recursive: true, mode: 0o777 });
    chmodSync(logDirectory, 0o777);
    writeFileSync(logPath, "x".repeat(1_000_000), { mode: 0o644 });
    chmodSync(logPath, 0o644);

    await logAdvisorFailureAsync(configPath, {
      contextChars: 1,
      durationMs: 2,
      error: new Error("effect rotation"),
      timeoutMs: 3,
    });
    expect(statSync(logDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(`${logPath}.1`).mode & 0o777).toBe(0o600);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);

    writeFileSync(logPath, "y".repeat(1_000_000));
    chmodSync(logDirectory, 0o777);
    chmodSync(logPath, 0o644);
    expect(
      logAdvisorFailure(configPath, {
        contextChars: 1,
        durationMs: 2,
        error: new Error("sync rotation"),
        timeoutMs: 3,
      }),
    ).toBe(logPath);
    expect(statSync(logDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(`${logPath}.1`).mode & 0o777).toBe(0o600);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  test("derives the log alongside the agent extensions directory", () => {
    expect(getAdvisorFailureLogPath("/home/user/.pi/agent/extensions/pi-advisor.json")).toBe(
      "/home/user/.pi/agent/logs/pi-advisor.jsonl",
    );
  });
});
