import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { nodeFsPromises, nodePath } from "../src/platform/node-builtins.ts";
import { piHostFileLoggerLayer } from "../src/runtime/runtime.ts";
import { silencedConsole } from "./support/spies.ts";
import { temporaryDirectory } from "../testing.ts";

const fs = nodeFsPromises;
const logDirectory = temporaryDirectory("cosmic-host-log-");

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

const existingLog = (contents: string) =>
  Effect.gen(function* () {
    const directory = yield* logDirectory;
    const logPath = nodePath.join(directory, "logs", "pi-test.jsonl");
    yield* Effect.promise(() => fs.mkdir(nodePath.join(directory, "logs"), { recursive: true }));
    yield* Effect.promise(() => fs.writeFile(logPath, contents));
    return { directory, logPath };
  });

it.live("writes host logs to the package JSONL file and stays off the TTY", () =>
  Effect.gen(function* () {
    const directory = yield* logDirectory;
    const consoleCalls = yield* silencedConsole;
    yield* logThrough(() => directory, "usage refresh failed");

    const contents = yield* Effect.promise(() =>
      fs.readFile(nodePath.join(directory, "logs", "pi-test.jsonl"), "utf8"),
    );
    expect(contents).toContain("usage refresh failed");
    expect(consoleCalls()).toBe(0);
  }),
);

it.live("rotates one generation once the host log passes its size bound", () =>
  Effect.gen(function* () {
    const { directory, logPath } = yield* existingLog("x".repeat(1_000_001));
    yield* logThrough(() => directory, "after rotation");

    const rotated = yield* Effect.promise(() => fs.readFile(`${logPath}.1`, "utf8"));
    const current = yield* Effect.promise(() => fs.readFile(logPath, "utf8"));
    expect(rotated).toHaveLength(1_000_001);
    expect(current).toContain("after rotation");
    expect(current).not.toContain("xxx");
  }),
);

it.live("leaves a host log below its size bound in place", () =>
  Effect.gen(function* () {
    const { directory, logPath } = yield* existingLog('{"message":"earlier session"}\n');
    yield* logThrough(() => directory, "appended");

    const current = yield* Effect.promise(() => fs.readFile(logPath, "utf8"));
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
    if (Exit.isSuccess(exit)) expect(exit.value).toContain(Logger.tracerLogger);
  }),
);

it.live("absorbs an uncreatable log directory and writes nothing", () =>
  Effect.gen(function* () {
    const directory = yield* logDirectory;
    const blocked = nodePath.join(directory, "logs");
    yield* Effect.promise(() => fs.writeFile(blocked, ""));

    const exit = yield* Effect.exit(logThrough(() => directory, "must not escape as a failure"));

    expect(exit._tag).toBe("Success");
    if (Exit.isSuccess(exit)) expect(exit.value).toContain(Logger.tracerLogger);
    expect(yield* Effect.promise(() => fs.readFile(blocked, "utf8"))).toBe("");
  }),
);
