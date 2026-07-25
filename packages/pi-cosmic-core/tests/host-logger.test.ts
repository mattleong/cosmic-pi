// Host log sink coverage intentionally uses real Node filesystem primitives.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/strictEffectProvide:off
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { piHostFileLoggerLayer, type PiHostLogTarget } from "../src/runtime/runtime.ts";

class TestFileSystemError extends Schema.TaggedErrorClass<TestFileSystemError>()(
  "TestFileSystemError",
  { operation: Schema.String },
) {}

const testFileSystem = <A>(
  operation: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, TestFileSystemError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => new TestFileSystemError({ operation }),
  });

const withDirectory = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | TestFileSystemError, R> =>
  Effect.acquireUseRelease(
    testFileSystem("make temp directory", () => mkdtemp(join(tmpdir(), "cosmic-host-log-"))),
    use,
    (directory) =>
      testFileSystem("remove temp directory", () =>
        rm(directory, { recursive: true, force: true }),
      ),
  );

/** Emits one record through the layer and closes the scope so the batch flushes. */
const logThrough = (target: PiHostLogTarget, message: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(piHostFileLoggerLayer(target));
      const loggers = yield* Logger.CurrentLoggers.pipe(Effect.provide(context));
      yield* Effect.logWarning(message).pipe(Effect.provide(context));
      return [...loggers];
    }),
  );

it.live("writes host logs to the package JSONL file and stays off the TTY", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const originalLog = console.log;
      const originalError = console.error;
      const consoleCalls: string[] = [];
      console.log = (...args: unknown[]) => void consoleCalls.push(args.map(String).join(" "));
      console.error = (...args: unknown[]) => void consoleCalls.push(args.map(String).join(" "));
      try {
        yield* logThrough(
          { agentDirectory: () => directory, packageName: "pi-test" },
          "usage refresh failed",
        );
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }

      const contents = yield* testFileSystem("read host log", () =>
        readFile(join(directory, "logs", "pi-test.jsonl"), "utf8"),
      );
      expect(contents).toContain("usage refresh failed");
      expect(consoleCalls).toEqual([]);
    }),
  ),
);

it.live("rotates one generation once the host log passes its size bound", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const logPath = join(directory, "logs", "pi-test.jsonl");
      yield* testFileSystem("make log directory", () =>
        mkdir(join(directory, "logs"), { recursive: true }),
      );
      yield* testFileSystem("seed oversized log", () => writeFile(logPath, "x".repeat(1_000_001)));

      yield* logThrough(
        { agentDirectory: () => directory, packageName: "pi-test" },
        "after rotation",
      );

      const rotated = yield* testFileSystem("read rotated log", () =>
        readFile(`${logPath}.1`, "utf8"),
      );
      const current = yield* testFileSystem("read current log", () => readFile(logPath, "utf8"));
      expect(rotated).toHaveLength(1_000_001);
      expect(current).toContain("after rotation");
      expect(current).not.toContain("xxx");
    }),
  ),
);

it.live("leaves a host log below its size bound in place", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const logPath = join(directory, "logs", "pi-test.jsonl");
      yield* testFileSystem("make log directory", () =>
        mkdir(join(directory, "logs"), { recursive: true }),
      );
      yield* testFileSystem("seed small log", () =>
        writeFile(logPath, '{"message":"earlier session"}\n'),
      );

      yield* logThrough({ agentDirectory: () => directory, packageName: "pi-test" }, "appended");

      const current = yield* testFileSystem("read current log", () => readFile(logPath, "utf8"));
      expect(current).toContain("earlier session");
      expect(current).toContain("appended");
    }),
  ),
);

it.live("absorbs an unresolvable agent directory instead of failing the layer", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      logThrough(
        {
          agentDirectory: () => {
            throw new Error("agent directory unavailable");
          },
          packageName: "pi-test",
        },
        "must not escape as a failure",
      ),
    );

    expect(exit._tag).toBe("Success");
    // The span-event logger survives so tracing is unaffected by a missing file sink.
    if (exit._tag === "Success") expect(exit.value).toContain(Logger.tracerLogger);
  }),
);

it.live("absorbs an uncreatable log directory and writes nothing", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      // A regular file at `logs` makes the recursive directory creation fail.
      const blocked = join(directory, "logs");
      yield* testFileSystem("write blocking file", () => writeFile(blocked, ""));

      const exit = yield* Effect.exit(
        logThrough(
          { agentDirectory: () => directory, packageName: "pi-test" },
          "must not escape as a failure",
        ),
      );

      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") expect(exit.value).toContain(Logger.tracerLogger);
      // Proves the sink really was unavailable rather than quietly succeeding elsewhere.
      expect(yield* testFileSystem("read blocking file", () => readFile(blocked, "utf8"))).toBe("");
    }),
  ),
);
