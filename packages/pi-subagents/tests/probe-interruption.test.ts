// Private process-boundary integration tests intentionally use Node process probes.
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect } from "vitest";
import { runIsolatedCodexAuthProbe, runProbeEffect } from "../src/boundary/local-cli-harness.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";
import { processAlive, waitForDead, waitForPid } from "./support/process-liveness.ts";
import {
  makeTemporaryDirectory,
  removeTemporaryDirectories,
} from "./support/temporary-directories.ts";

const { join } = nodePath;

const fixture = fileURLToPath(new URL("./fixtures/hanging-probe-fixture.mjs", import.meta.url));
const ownedPids = new Set<number>();
const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const executableFixture = () =>
  makeTemporaryDirectory("pi-subagents-probe-").then((directory) => {
    const executable = join(directory, "probe.mjs");
    return fs
      .copyFile(fixture, executable)
      .then(() => fs.chmod(executable, 0o700))
      .then(() => ({ directory, executable, pidPath: join(directory, "probe.pid") }));
  });

/** Interrupts a probe once its fixture publishes a pid, then requires that process to be gone. */
const expectInterruptKills = <A, E>(fiber: Fiber.Fiber<A, E>, pidPath: string) =>
  Effect.gen(function* () {
    const pid = yield* step(() => waitForPid(pidPath));
    ownedPids.add(pid);
    yield* Fiber.interrupt(fiber);
    yield* step(() => waitForDead(pid));
    expect(processAlive(pid)).toBe(false);
    ownedPids.delete(pid);
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
  return removeTemporaryDirectories();
});

describe("probe interruption cleanup", () => {
  effectTest("terminates an interrupted local CLI readiness probe", function* () {
    const test = yield* step(executableFixture);
    const fiber = Effect.runFork(
      runProbeEffect(test.executable, [], {
        ...process.env,
        PI_SUBAGENT_TEST_PID: test.pidPath,
      }),
    );
    yield* expectInterruptKills(fiber, test.pidPath);
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
    yield* expectInterruptKills(fiber, test.pidPath);
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
