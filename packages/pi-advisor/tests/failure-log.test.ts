// Effect test entry point owns the temporary filesystem fixtures for the failure log.
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { provideBuiltLayer } from "pi-cosmic-core";
import { advisorPlatformLayer } from "../src/boundary/executor.ts";
import {
  AdvisorFailureRecordSchema,
  getAdvisorFailureLogPath,
  logAdvisorFailureEffect,
} from "../src/logging/log.ts";

const decodeFailureRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(AdvisorFailureRecordSchema),
);
const decodeFailureLabels = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ provider: Schema.String, model: Schema.String })),
);

const agentFixture = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const agentDir = yield* fs.makeTempDirectoryScoped({ prefix });
    const configPath = path.join(agentDir, "extensions", "pi-advisor.json");
    return { agentDir, configPath, fs, path };
  });

const hostileError = () =>
  Object.defineProperty({}, "message", {
    get() {
      throw new Error("getter executed");
    },
  });

layer(advisorPlatformLayer)("advisor failure log", (it) => {
  it.effect("writes a structured diagnostic without prompt or credential data", () =>
    Effect.gen(function* () {
      const { agentDir, configPath, fs, path } = yield* agentFixture("pi-advisor-log-");
      yield* fs.makeDirectory(path.join(agentDir, "extensions"), { recursive: true });
      const error = new Error("provider request timed out");

      const logPath = yield* logAdvisorFailureEffect(configPath, {
        contextChars: 12_345,
        durationMs: 30_001.6,
        error,
        model: "review-model",
        provider: "review-provider",
        timeoutMs: 30_000,
      });

      expect(logPath).toBe(path.join(agentDir, "logs", "pi-advisor.jsonl"));
      const persisted = yield* fs.readFileString(logPath!);
      const entry = decodeFailureRecord(persisted.trim());
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
      expect(persisted).not.toContain("prompt");
      expect(persisted).not.toContain("credential");
    }),
  );

  it.effect("does not invoke hostile error accessors", () =>
    Effect.gen(function* () {
      const { configPath, fs } = yield* agentFixture("pi-advisor-hostile-log-");
      const logPath = yield* logAdvisorFailureEffect(configPath, {
        contextChars: 1,
        durationMs: 2,
        error: hostileError(),
        timeoutMs: 3,
      });
      expect(logPath).toBeDefined();
      expect(yield* fs.readFileString(getAdvisorFailureLogPath(configPath))).toContain(
        "Unknown error.",
      );
    }),
  );

  it.effect("redacts and clips provider and model labels before persistence", () =>
    Effect.gen(function* () {
      const { agentDir, configPath, fs, path } = yield* agentFixture("pi-advisor-label-log-");
      yield* fs.makeDirectory(path.join(agentDir, "extensions"), { recursive: true });

      const logPath = yield* logAdvisorFailureEffect(configPath, {
        contextChars: 1,
        durationMs: 2,
        error: new Error("failed"),
        model: `model-token=secret-value-${"x".repeat(400)}`,
        provider: "provider-api_key=sk-abcdefghijklmnop",
        timeoutMs: 3,
      });
      const persisted = yield* fs.readFileString(logPath!);
      const entry = decodeFailureLabels(persisted.trim());

      expect(persisted).not.toMatch(/secret-value|sk-abcdefghijklmnop/);
      expect(persisted).toContain("REDACTED");
      expect(entry.provider.length).toBeLessThanOrEqual(256);
      expect(entry.model.length).toBeLessThanOrEqual(256);
    }),
  );

  it.effect("redacts credential-like text from persisted error messages and stacks", () =>
    Effect.gen(function* () {
      const { agentDir, configPath, fs, path } = yield* agentFixture("pi-advisor-secret-log-");
      yield* fs.makeDirectory(path.join(agentDir, "extensions"), { recursive: true });
      const error = new Error(
        "Authorization: Bearer abc.def.ghi OPENAI_API_KEY=sk-abcdefghijklmnop",
      );
      error.name = "Provider_OPENAI_API_KEY=name-secret-value";
      error.stack = `Error: token=generic-secret-value\n at provider (api_key=sk-secondsecretvalue)`;

      const logPath = yield* logAdvisorFailureEffect(configPath, {
        contextChars: 1,
        durationMs: 2,
        error,
        timeoutMs: 3,
      });
      const persisted = yield* fs.readFileString(logPath!);

      expect(persisted).not.toMatch(
        /abc\.def\.ghi|sk-abcdefghijklmnop|generic-secret-value|sk-secondsecretvalue|name-secret-value/,
      );
      expect(persisted).toContain("REDACTED");
    }),
  );

  it.effect("serializes concurrent production appends and enforces private mode", () =>
    Effect.gen(function* () {
      const { configPath, fs } = yield* agentFixture("pi-advisor-concurrent-log-");
      yield* Effect.forEach(
        Array.from({ length: 50 }, (_, index) => index),
        (index) =>
          logAdvisorFailureEffect(configPath, {
            contextChars: index,
            durationMs: index,
            error: new Error(`failure-${index}`),
            timeoutMs: 30_000,
          }),
        { concurrency: "unbounded" },
      );
      const path = getAdvisorFailureLogPath(configPath);
      const lines = (yield* fs.readFileString(path)).trim().split("\n");
      expect(lines).toHaveLength(50);
      expect(lines.every((line) => Boolean(decodeFailureRecord(line)))).toBe(true);
      expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600);
    }),
  );

  it.effect("serializes exported helpers across separately provided Layers", () =>
    Effect.gen(function* () {
      const { configPath, fs } = yield* agentFixture("pi-advisor-exported-log-");
      const paths = yield* Effect.forEach(
        Array.from({ length: 30 }, (_, index) => index),
        (index) =>
          logAdvisorFailureEffect(configPath, {
            contextChars: index,
            durationMs: index,
            error: new Error(`exported-${index}`),
            timeoutMs: 30_000,
          }).pipe(provideBuiltLayer(advisorPlatformLayer)),
        { concurrency: "unbounded" },
      );
      expect(paths.every(Boolean)).toBe(true);
      const lines = (yield* fs.readFileString(getAdvisorFailureLogPath(configPath)))
        .trim()
        .split("\n");
      expect(lines).toHaveLength(30);
    }),
  );

  it.effect("tightens existing log directories and rotated files", () =>
    Effect.gen(function* () {
      const { agentDir, configPath, fs, path } = yield* agentFixture("pi-advisor-legacy-log-");
      const logPath = getAdvisorFailureLogPath(configPath);
      const logDirectory = path.join(agentDir, "logs");
      yield* fs.makeDirectory(logDirectory, { recursive: true });
      yield* fs.chmod(logDirectory, 0o777);
      yield* fs.writeFileString(logPath, "x".repeat(1_000_000));
      yield* fs.chmod(logPath, 0o644);

      yield* logAdvisorFailureEffect(configPath, {
        contextChars: 1,
        durationMs: 2,
        error: new Error("effect rotation"),
        timeoutMs: 3,
      });
      expect((yield* fs.stat(logDirectory)).mode & 0o777).toBe(0o700);
      expect((yield* fs.stat(`${logPath}.1`)).mode & 0o777).toBe(0o600);
      expect((yield* fs.stat(logPath)).mode & 0o777).toBe(0o600);
    }),
  );

  it.effect("derives the log alongside the agent extensions directory", () =>
    Effect.sync(() => {
      expect(getAdvisorFailureLogPath("/home/user/.pi/agent/extensions/pi-advisor.json")).toBe(
        "/home/user/.pi/agent/logs/pi-advisor.jsonl",
      );
    }),
  );
});
