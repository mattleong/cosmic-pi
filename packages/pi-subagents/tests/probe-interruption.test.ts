// Private process-boundary integration tests intentionally use Node process probes.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect } from "vitest";
import { makeHerdrCli } from "../src/boundary/herdr-cli.ts";
import { runIsolatedCodexAuthProbe, runProbeEffect } from "../src/boundary/local-cli-harness.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";

const { join } = nodePath;

const fixture = fileURLToPath(new URL("./fixtures/hanging-probe-fixture.mjs", import.meta.url));
const directories: string[] = [];
const ownedPids = new Set<number>();
const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Real-time polling of live child processes deliberately runs on the live default clock.
const waitForPid = (path: string): Promise<number> =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200; attempt++) {
        const value = yield* Effect.promise(() => fs.readFile(path, "utf8").catch(() => undefined));
        const pid = value === undefined ? undefined : Number(value);
        if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) return pid;
        yield* Effect.sleep(Duration.millis(10));
      }
      return yield* Effect.die(new Error("probe pid was not published"));
    }),
  );

const waitForDead = (pid: number): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200 && processAlive(pid); attempt++)
        yield* Effect.sleep(Duration.millis(10));
    }),
  );

const executableFixture = () =>
  fs.mkdtemp(join(tmpdir(), "pi-subagents-probe-")).then((directory) => {
    directories.push(directory);
    const executable = join(directory, "probe.mjs");
    return fs
      .copyFile(fixture, executable)
      .then(() => fs.chmod(executable, 0o700))
      .then(() => ({ directory, executable, pidPath: join(directory, "probe.pid") }));
  });

afterEach(() => {
  for (const pid of ownedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The tested finalizer already released it.
    }
  }
  ownedPids.clear();
  return Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  ).then(() => undefined);
});

describe("probe interruption cleanup", () => {
  effectTest("terminates an interrupted Herdr command", function* () {
    const test = yield* step(executableFixture);
    const cli = makeHerdrCli({
      executable: test.executable,
      environment: { ...process.env, HERDR_CONFIG_PATH: test.pidPath },
      commandTimeoutMillis: 10_000,
    });
    const fiber = Effect.runFork(cli.snapshot);
    const pid = yield* step(() => waitForPid(test.pidPath));
    ownedPids.add(pid);

    yield* step(() => Effect.runPromise(Fiber.interrupt(fiber)));
    yield* step(() => waitForDead(pid));
    expect(processAlive(pid)).toBe(false);
    ownedPids.delete(pid);
  });

  effectTest("terminates an interrupted local CLI readiness probe", function* () {
    const test = yield* step(executableFixture);
    const fiber = Effect.runFork(
      runProbeEffect(test.executable, [], {
        ...process.env,
        PI_SUBAGENT_TEST_PID: test.pidPath,
      }),
    );
    const pid = yield* step(() => waitForPid(test.pidPath));
    ownedPids.add(pid);

    yield* step(() => Effect.runPromise(Fiber.interrupt(fiber)));
    yield* step(() => waitForDead(pid));
    expect(processAlive(pid)).toBe(false);
    ownedPids.delete(pid);
  });

  effectTest("interrupts an isolated Codex probe and removes its private harness", function* () {
    const test = yield* step(executableFixture);
    const agentDirectory = join(test.directory, "agent");
    yield* step(() => fs.mkdir(agentDirectory, { mode: 0o700 }));
    const fiber = Effect.runFork(
      runIsolatedCodexAuthProbe(test.executable, agentDirectory, {
        HOME: test.directory,
        PATH: inheritedPath(process.env),
        OPENAI_API_KEY: "fixture-key",
      }),
    );
    const pid = yield* step(() => waitForPid(test.pidPath));
    ownedPids.add(pid);

    yield* step(() => Effect.runPromise(Fiber.interrupt(fiber)));
    yield* step(() => waitForDead(pid));
    expect(processAlive(pid)).toBe(false);
    ownedPids.delete(pid);
    const harnessRoot = join(agentDirectory, "subagents", "native-model-catalog-v1");
    const entries = yield* step(() =>
      fs.readdir(harnessRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }),
    );
    expect(entries).toEqual([]);
  });
});
