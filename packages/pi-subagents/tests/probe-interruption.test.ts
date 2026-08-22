// Private process-boundary integration tests intentionally use Node process probes.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/newPromise:off
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect, it } from "vitest";
import { makeHerdrCli } from "../src/boundary/herdr-cli.ts";
import { runProbeEffect } from "../src/boundary/local-cli-harness.ts";

const fixture = fileURLToPath(new URL("./fixtures/hanging-probe-fixture.mjs", import.meta.url));
const directories: string[] = [];
const ownedPids = new Set<number>();

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForPid = async (path: string): Promise<number> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await fs.readFile(path, "utf8").catch(() => undefined);
    const pid = value === undefined ? undefined : Number(value);
    if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("probe pid was not published");
};

const waitForDead = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 200 && processAlive(pid); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
};

const executableFixture = async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-probe-"));
  directories.push(directory);
  const executable = join(directory, "probe.mjs");
  await fs.copyFile(fixture, executable);
  await fs.chmod(executable, 0o700);
  return { directory, executable, pidPath: join(directory, "probe.pid") };
};

afterEach(async () => {
  for (const pid of ownedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The tested finalizer already released it.
    }
  }
  ownedPids.clear();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("probe interruption cleanup", () => {
  it("terminates an interrupted Herdr command", async () => {
    const test = await executableFixture();
    const cli = makeHerdrCli({
      executable: test.executable,
      environment: { ...process.env, HERDR_CONFIG_PATH: test.pidPath },
      commandTimeoutMillis: 10_000,
    });
    const fiber = Effect.runFork(cli.snapshot);
    const pid = await waitForPid(test.pidPath);
    ownedPids.add(pid);

    await Effect.runPromise(Fiber.interrupt(fiber));
    await waitForDead(pid);
    expect(processAlive(pid)).toBe(false);
    ownedPids.delete(pid);
  });

  it("terminates an interrupted local CLI readiness probe", async () => {
    const test = await executableFixture();
    const fiber = Effect.runFork(
      runProbeEffect(test.executable, [], {
        ...process.env,
        PI_SUBAGENT_TEST_PID: test.pidPath,
      }),
    );
    const pid = await waitForPid(test.pidPath);
    ownedPids.add(pid);

    await Effect.runPromise(Fiber.interrupt(fiber));
    await waitForDead(pid);
    expect(processAlive(pid)).toBe(false);
    ownedPids.delete(pid);
  });
});
