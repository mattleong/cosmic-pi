// Host log sink coverage intentionally uses real Node filesystem primitives.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { nodeFsPromises, nodePath } from "../src/platform/node-builtins.ts";
import { piHostFileLoggerLayer } from "../src/runtime/runtime.ts";
import { silencedConsole } from "./support/spies.ts";
import { temporaryDirectory } from "../testing.ts";

const { mkdir, readFile, writeFile } = nodeFsPromises;
const { join } = nodePath;
const logDirectory = temporaryDirectory("cosmic-host-log-");

/** Emits one record through the `pi-test` layer and closes the scope so the batch flushes. */
const logThrough = (agentDirectory: () => string, message: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const layer = piHostFileLoggerLayer({ agentDirectory, packageName: "pi-test" });
      const context = yield* Layer.build(layer);
      const loggers = yield* Logger.CurrentLoggers.pipe(Effect.provide(context));
      yield* Effect.logWarning(message).pipe(Effect.provide(context));
      return [...loggers];
    }),
  );

/** A temporary agent directory whose existing `pi-test` host log holds `contents`. */
const existingLog = (contents: string) =>
  Effect.gen(function* () {
    const directory = yield* logDirectory;
    const logPath = join(directory, "logs", "pi-test.jsonl");
    yield* Effect.promise(() => mkdir(join(directory, "logs"), { recursive: true }));
    yield* Effect.promise(() => writeFile(logPath, contents));
    return { directory, logPath };
  });

it.live("writes host logs to the package JSONL file and stays off the TTY", () =>
  Effect.gen(function* () {
    const directory = yield* logDirectory;
    const consoleCalls = yield* silencedConsole;
    yield* logThrough(() => directory, "usage refresh failed");

    const contents = yield* Effect.promise(() =>
      readFile(join(directory, "logs", "pi-test.jsonl"), "utf8"),
    );
    expect(contents).toContain("usage refresh failed");
    expect(consoleCalls()).toBe(0);
  }),
);

it.live("rotates one generation once the host log passes its size bound", () =>
  Effect.gen(function* () {
    const { directory, logPath } = yield* existingLog("x".repeat(1_000_001));
    yield* logThrough(() => directory, "after rotation");

    const rotated = yield* Effect.promise(() => readFile(`${logPath}.1`, "utf8"));
    const current = yield* Effect.promise(() => readFile(logPath, "utf8"));
    expect(rotated).toHaveLength(1_000_001);
    expect(current).toContain("after rotation");
    expect(current).not.toContain("xxx");
  }),
);

it.live("leaves a host log below its size bound in place", () =>
  Effect.gen(function* () {
    const { directory, logPath } = yield* existingLog('{"message":"earlier session"}\n');
    yield* logThrough(() => directory, "appended");

    const current = yield* Effect.promise(() => readFile(logPath, "utf8"));
    expect(current).toContain("earlier session");
    expect(current).toContain("appended");
  }),
);

it.live("absorbs an unresolvable agent directory instead of failing the layer", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      logThrough(() => {
        throw new Error("agent directory unavailable");
      }, "must not escape as a failure"),
    );

    expect(exit._tag).toBe("Success");
    // The span-event logger survives so tracing is unaffected by a missing file sink.
    if (exit._tag === "Success") expect(exit.value).toContain(Logger.tracerLogger);
  }),
);

it.live("absorbs an uncreatable log directory and writes nothing", () =>
  Effect.gen(function* () {
    const directory = yield* logDirectory;
    // A regular file at `logs` makes the recursive directory creation fail.
    const blocked = join(directory, "logs");
    yield* Effect.promise(() => writeFile(blocked, ""));

    const exit = yield* Effect.exit(logThrough(() => directory, "must not escape as a failure"));

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") expect(exit.value).toContain(Logger.tracerLogger);
    // Proves the sink really was unavailable rather than quietly succeeding elsewhere.
    expect(yield* Effect.promise(() => readFile(blocked, "utf8"))).toBe("");
  }),
);
