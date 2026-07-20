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
import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_ADVISOR_CONFIG,
  MAX_CONTEXT_CHARS,
  MAX_TIMEOUT_MS,
  MIN_CONTEXT_CHARS,
  MIN_TIMEOUT_MS,
  clampContextChars,
  clampTimeoutMs,
  getAdvisorConfigPath,
  loadAdvisorConfig,
  normalizeAdvisorConfig,
  patchAdvisorConfig,
  readRawAdvisorConfig,
  writeAdvisorConfigPatch,
  writeAdvisorConfigPatchAsync,
  writeRawAdvisorConfig,
} from "../src/config.ts";

function withTempDir<T>(run: (tempDir: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-advisor-config-"));
  try {
    return run(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("advisor config", () => {
  test("serializes exported async patches across Layers and protects new paths", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-advisor-config-async-"));
    const path = join(tempDir, "private", "advisor.json");
    const previousUmask = process.umask(0);
    try {
      await Promise.all([
        writeAdvisorConfigPatchAsync({ enabled: false }, path),
        writeAdvisorConfigPatchAsync({ provider: "p" }, path),
        writeAdvisorConfigPatchAsync({ model: "m" }, path),
      ]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        enabled: false,
        provider: "p",
        model: "m",
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(tempDir, "private")).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("tightens existing config directories in Effect and sync compatibility writes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-advisor-config-mode-"));
    const directory = join(tempDir, "extensions");
    const path = join(directory, "advisor.json");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o777 });
      chmodSync(directory, 0o777);
      await writeAdvisorConfigPatchAsync({ enabled: false }, path);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);

      chmodSync(directory, 0o777);
      writeAdvisorConfigPatch({ model: "m" }, path);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("uses capability-first review defaults", () => {
    expect(DEFAULT_ADVISOR_CONFIG).toEqual({
      enabled: true,
      fastMode: true,
      thinkingLevel: "high",
      reviewPolicy: "corrective",
      timeoutMs: 90_000,
      maxContextChars: 240_000,
    });
  });

  test("builds the config path from an injected SDK-resolved agent directory", () => {
    expect(getAdvisorConfigPath("/home/alice/.pi/agent")).toBe(
      "/home/alice/.pi/agent/extensions/pi-advisor.json",
    );
    expect(getAdvisorConfigPath("/var/lib/pi")).toBe("/var/lib/pi/extensions/pi-advisor.json");
  });

  test("ignores accessors and hostile Proxy traps before field Schema decoding", () => {
    const accessor = Object.defineProperty({}, "provider", {
      enumerable: true,
      get() {
        throw new Error("getter executed");
      },
    });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxy trap executed");
        },
      },
    );
    expect(normalizeAdvisorConfig(accessor, "/tmp/config")).toMatchObject({
      configured: false,
      ...DEFAULT_ADVISOR_CONFIG,
    });
    expect(normalizeAdvisorConfig(hostile, "/tmp/config")).toMatchObject({
      configured: false,
      ...DEFAULT_ADVISOR_CONFIG,
    });
  });

  test("applies defaults when config is absent or invalid", () => {
    const configPath = "/tmp/pi-advisor.json";

    expect(normalizeAdvisorConfig(undefined, configPath)).toEqual({
      configPath,
      ...DEFAULT_ADVISOR_CONFIG,
      configured: false,
    });
    expect(
      normalizeAdvisorConfig(
        {
          enabled: "yes",
          provider: 42,
          model: " ",
          fastMode: "yes",
          thinkingLevel: "extreme",
          revisionCooldownTurns: "many",
          timeoutMs: Number.NaN,
          maxContextChars: "large",
        },
        configPath,
      ),
    ).toEqual({ configPath, ...DEFAULT_ADVISOR_CONFIG, configured: false });
  });

  test("normalizes model selection and configuration state", () => {
    expect(
      normalizeAdvisorConfig(
        {
          enabled: false,
          provider: " openai ",
          model: " gpt-5.5 ",
          fastMode: true,
          thinkingLevel: "high",
          reviewPolicy: "advisory",
          timeoutMs: 90_000,
          maxContextChars: 80_000,
        },
        "/config.json",
      ),
    ).toEqual({
      configPath: "/config.json",
      enabled: false,
      provider: "openai",
      model: "gpt-5.5",
      fastMode: true,
      thinkingLevel: "high",
      reviewPolicy: "advisory",
      timeoutMs: 90_000,
      maxContextChars: 80_000,
      configured: true,
    });
  });

  test.each([
    ["strict", "corrective", true],
    ["advice", "advisory", true],
    ["manual", "advisory", false],
  ] as const)(
    "migrates legacy %s behavior consistently during normalization and persistence",
    (legacyPolicy, reviewPolicy, enabled) => {
      expect(
        normalizeAdvisorConfig({ enabled: true, reviewPolicy: legacyPolicy }, "/config.json"),
      ).toMatchObject({ enabled, reviewPolicy });

      withTempDir((tempDir) => {
        const path = join(tempDir, "advisor.json");
        writeRawAdvisorConfig({ enabled: true, reviewPolicy: legacyPolicy }, path);
        expect(writeAdvisorConfigPatch({}, path)).toMatchObject({ enabled, reviewPolicy });
        expect(readRawAdvisorConfig(path)).toMatchObject({ enabled, reviewPolicy });
      });
    },
  );

  test("an explicit patch can re-enable a migrated legacy Manual config", () => {
    withTempDir((tempDir) => {
      const path = join(tempDir, "advisor.json");
      writeRawAdvisorConfig({ enabled: true, reviewPolicy: "manual" }, path);
      expect(writeAdvisorConfigPatch({ enabled: true }, path)).toMatchObject({
        enabled: true,
        reviewPolicy: "advisory",
      });
      expect(readRawAdvisorConfig(path)).toMatchObject({
        enabled: true,
        reviewPolicy: "advisory",
      });
    });
  });

  test("clamps numeric settings to documented bounds", () => {
    expect(clampTimeoutMs(1)).toBe(MIN_TIMEOUT_MS);
    expect(clampTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMEOUT_MS);
    expect(clampContextChars(1)).toBe(MIN_CONTEXT_CHARS);
    expect(clampContextChars(Number.MAX_SAFE_INTEGER)).toBe(MAX_CONTEXT_CHARS);
    expect(clampTimeoutMs(20_000.9)).toBe(20_000);
    expect(clampContextChars(undefined)).toBe(DEFAULT_ADVISOR_CONFIG.maxContextChars);
  });

  test("reads missing, malformed, and non-object files safely", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    withTempDir((tempDir) => {
      const missingPath = join(tempDir, "missing.json");
      const malformedPath = join(tempDir, "malformed.json");
      const arrayPath = join(tempDir, "array.json");
      writeFileSync(malformedPath, "{not-json", "utf8");
      writeFileSync(arrayPath, "[]", "utf8");

      expect(readRawAdvisorConfig(missingPath)).toEqual({});
      expect(readRawAdvisorConfig(malformedPath)).toEqual({});
      expect(readRawAdvisorConfig(arrayPath)).toEqual({});
      expect(loadAdvisorConfig(missingPath)).toEqual({
        configPath: missingPath,
        ...DEFAULT_ADVISOR_CONFIG,
        configured: false,
      });
      expect(warn).toHaveBeenCalledTimes(2);
    });
    warn.mockRestore();
  });

  test("refuses to overwrite malformed config", () => {
    withTempDir((tempDir) => {
      const path = join(tempDir, "advisor.json");
      writeFileSync(path, "{not-json", "utf8");

      expect(() => writeAdvisorConfigPatch({ enabled: false }, path)).toThrow();
      expect(readFileSync(path, "utf8")).toBe("{not-json");
    });
  });

  test("ignores accessor properties without invoking untrusted getters", () => {
    const getter = vi.fn(() => {
      throw new Error("getter must not run");
    });
    const raw = Object.defineProperty({ provider: "p", model: "m" }, "enabled", {
      enumerable: true,
      get: getter,
    });
    expect(normalizeAdvisorConfig(raw, "/tmp/advisor.json")).toMatchObject({
      enabled: true,
      configured: true,
    });
    expect(getter).not.toHaveBeenCalled();
  });

  test("patches known fields without discarding unknown fields", () => {
    const raw = {
      enabled: true,
      provider: "legacy",
      futureSetting: { nested: true },
    };

    expect(
      patchAdvisorConfig(raw, {
        enabled: false,
        provider: " openai ",
        model: " gpt-5.5 ",
        fastMode: true,
        thinkingLevel: "high",
        reviewPolicy: "corrective",
        timeoutMs: 1,
        maxContextChars: 999_999,
      }),
    ).toEqual({
      enabled: false,
      provider: "openai",
      model: "gpt-5.5",
      fastMode: true,
      thinkingLevel: "high",
      reviewPolicy: "corrective",
      timeoutMs: MIN_TIMEOUT_MS,
      maxContextChars: MAX_CONTEXT_CHARS,
      futureSetting: { nested: true },
    });
    expect(raw).toEqual({
      enabled: true,
      provider: "legacy",
      futureSetting: { nested: true },
    });
  });

  test("an undefined or blank patch clears an optional setting", () => {
    expect(
      patchAdvisorConfig(
        {
          provider: "openai",
          model: "gpt-5.5",
          fastMode: true,
          thinkingLevel: "high",
          timeoutMs: 30_000,
        },
        {
          provider: " ",
          model: undefined,
          fastMode: undefined,
          thinkingLevel: undefined,
          timeoutMs: undefined,
        },
      ),
    ).toEqual({});
  });

  test("write helpers create directories and preserve unknown fields across updates", () => {
    withTempDir((tempDir) => {
      const configPath = join(tempDir, "agent", "extensions", "pi-advisor.json");
      writeRawAdvisorConfig(
        {
          enabled: true,
          provider: "openai",
          unknownField: "keep me",
          future: { enabled: true },
          revisionCooldownTurns: 5,
          tools: ["all", "bash", "write"],
          command: "rm -rf .",
          customTools: { provider: "injected" },
        },
        configPath,
      );

      const resolved = writeAdvisorConfigPatch(
        {
          enabled: false,
          model: "gpt-5.5",
          fastMode: true,
          thinkingLevel: "xhigh",
          timeoutMs: 500_000,
        },
        configPath,
      );

      expect(resolved).toMatchObject({
        configPath,
        enabled: false,
        provider: "openai",
        model: "gpt-5.5",
        fastMode: true,
        thinkingLevel: "xhigh",
        timeoutMs: MAX_TIMEOUT_MS,
        configured: true,
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        enabled: false,
        provider: "openai",
        model: "gpt-5.5",
        fastMode: true,
        thinkingLevel: "xhigh",
        timeoutMs: MAX_TIMEOUT_MS,
        unknownField: "keep me",
        future: { enabled: true },
        revisionCooldownTurns: 5,
        tools: ["all", "bash", "write"],
        command: "rm -rf .",
        customTools: { provider: "injected" },
      });
      expect("revisionCooldownTurns" in resolved).toBe(false);
      expect("tools" in resolved).toBe(false);
      expect("command" in resolved).toBe(false);
      expect("customTools" in resolved).toBe(false);
    });
  });
});
