// Test-owned process fixture is boundary code.
import { it as effectIt } from "@effect/vitest";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { EventEmitter, once } from "node:events";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vitest";
import { terminateProcessTree, terminateProcessTreeEffect } from "../src/boundary/process-tree.ts";
import { nodeSpawn as spawn, type NodeChildProcess } from "./support/node-builtins.ts";

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      hasObjectRuntimeType(error) &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
};

// Real-time polling of live child processes deliberately runs on the live default clock.
const waitForExit = (pid: number): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 100 && processExists(pid); attempt += 1)
        yield* Effect.sleep(Duration.millis(10));
    }),
  );

describe("subagent process-tree boundary", () => {
  it("does not target an already-exited Windows PID", () => {
    const spawnTaskkill = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const child = { pid: 42, exitCode: 0, signalCode: null } as NodeChildProcess;
    return terminateProcessTree(child, "force", { platform: "win32", spawnTaskkill }).then(() => {
      expect(spawnTaskkill).not.toHaveBeenCalled();
    });
  });

  effectIt.effect("bounds and cancels a hanging Windows taskkill helper", () =>
    Effect.gen(function* () {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const killer = new EventEmitter() as NodeChildProcess;
      const kill = vi.fn(() => true);
      const unref = vi.fn(() => killer);
      killer.kill = kill;
      killer.unref = unref;
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const child = { pid: 43, exitCode: null, signalCode: null } as NodeChildProcess;
      const failure = yield* terminateProcessTreeEffect(child, "force", {
        platform: "win32",
        taskkillTimeoutMillis: 5,
        spawnTaskkill: () => killer,
      }).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(5);

      expect(yield* Fiber.join(failure)).toMatchObject({
        _tag: "ProcessTreeTerminationError",
        code: "taskkill_timeout",
      });
      expect(kill).toHaveBeenCalledOnce();
      expect(unref).toHaveBeenCalledOnce();
    }),
  );

  effectIt.effect("kills the taskkill helper when its owner is interrupted", () =>
    Effect.gen(function* () {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const killer = new EventEmitter() as NodeChildProcess;
      const kill = vi.fn(() => true);
      killer.kill = kill;
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const child = { pid: 45, exitCode: null, signalCode: null } as NodeChildProcess;
      const running = yield* terminateProcessTreeEffect(child, "force", {
        platform: "win32",
        spawnTaskkill: () => killer,
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(running);

      expect(kill).toHaveBeenCalledOnce();
    }),
  );

  it("preserves typed failures through the Promise compatibility door", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const child = { pid: 46, exitCode: null, signalCode: null } as NodeChildProcess;
    return expect(
      terminateProcessTree(child, "force", {
        platform: "win32",
        spawnTaskkill: () => {
          throw Object.assign(new Error("missing taskkill"), { code: "ENOENT" });
        },
      }),
    ).rejects.toMatchObject({
      _tag: "ProcessTreeTerminationError",
      code: "taskkill_spawn_failed",
      message: expect.stringContaining("ENOENT"),
    });
  });

  it("passes live Windows trees to bounded taskkill", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const killer = new EventEmitter() as NodeChildProcess;
    killer.kill = vi.fn(() => true);
    const modes: string[] = [];
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const child = { pid: 44, exitCode: null, signalCode: null } as NodeChildProcess;
    const pending = terminateProcessTree(child, "force", {
      platform: "win32",
      spawnTaskkill: (_pid, mode) => {
        modes.push(mode);
        return killer;
      },
    });
    killer.emit("close", 0);
    return pending.then(() => {
      expect(modes).toEqual(["force"]);
    });
  });

  it.skipIf(process.platform === "win32")(
    "kills descendants in the detached process group after its leader exits",
    () => {
      const leader = spawn(
        process.execPath,
        [
          "-e",
          `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
child.unref();
process.stdout.write(String(child.pid) + "\\n");`,
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      let grandchildPid = 0;
      let output = "";
      leader.stdout?.setEncoding("utf8");
      leader.stdout?.on("data", (chunk: string) => {
        output += chunk;
      });
      return once(leader, "close")
        .then(() => {
          grandchildPid = Number(output.trim());
          expect(Number.isSafeInteger(grandchildPid)).toBe(true);
          expect(processExists(grandchildPid)).toBe(true);
          return terminateProcessTree(leader, "force");
        })
        .then(() => waitForExit(grandchildPid))
        .then(() => {
          expect(processExists(grandchildPid)).toBe(false);
        })
        .finally(() => {
          if (grandchildPid > 0 && processExists(grandchildPid)) {
            try {
              process.kill(grandchildPid, "SIGKILL");
            } catch {
              // Best-effort fixture cleanup.
            }
          }
        });
    },
  );
});
