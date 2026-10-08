// Private process-boundary integration tests intentionally use Node process probes.
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { runIsolatedCodexAuthProbe, runProbeEffect } from "../src/boundary/local-cli-harness.ts";
import { step } from "./support/effect-test.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";
import { processAlive, waitForDead, waitForPid } from "./support/process-liveness.ts";

const { join } = nodePath;

const fixture = fileURLToPath(new URL("./fixtures/hanging-probe-fixture.mjs", import.meta.url));
const ownedPids = new Set<number>();
const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const executableFixture = Effect.gen(function* () {
  const directory = yield* temporaryDirectory("pi-subagents-probe-");
  const executable = join(directory, "probe.mjs");
  yield* step(() => fs.copyFile(fixture, executable));
  yield* step(() => fs.chmod(executable, 0o700));
  return { directory, executable, pidPath: join(directory, "probe.pid") };
});

/** Interrupts a probe once its fixture publishes a pid, then requires that process to be gone. */
const expectInterruptKills = <A, E>(fiber: Fiber.Fiber<A, E>, pidPath: string) =>
  Effect.gen(function* () {
    const pid = yield* waitForPid(pidPath);
    ownedPids.add(pid);
    yield* Fiber.interrupt(fiber);
    yield* waitForDead(pid);
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
});

describe("probe interruption cleanup", () => {
  it.live("terminates an interrupted local CLI readiness probe", () =>
    Effect.gen(function* () {
      const test = yield* executableFixture;
      const fiber = yield* Effect.forkChild(
        runProbeEffect(test.executable, [], {
          ...process.env,
          PI_SUBAGENT_TEST_PID: test.pidPath,
        }),
      );
      yield* expectInterruptKills(fiber, test.pidPath);
    }),
  );

  it.live("interrupts an isolated Codex probe and removes its private harness", () =>
    Effect.gen(function* () {
      const test = yield* executableFixture;
      const agentDirectory = join(test.directory, "agent");
      yield* step(() => fs.mkdir(agentDirectory, { mode: 0o700 }));
      const fiber = yield* Effect.forkChild(
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
    }),
  );
});
