// Test-owned process fixture is boundary code.
import { it as effectIt } from "@effect/vitest";
import { signalProcess } from "pi-cosmic-core";
import { fakeProcessTreeTerminator } from "pi-cosmic-core/testing";
import { once } from "node:events";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import { terminateProcessTree } from "../src/boundary/process-tree.ts";
import { nodeSpawn as spawn, type NodeChildProcess } from "./support/node-builtins.ts";

const processExists = (pid: number): boolean => signalProcess(pid, 0) !== "absent";

// Real-time polling of live child processes deliberately runs on the live default clock.
const waitForExit = (pid: number): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 100 && processExists(pid); attempt += 1)
        yield* Effect.sleep(Duration.millis(10));
    }),
  );

const childStub = (pid: number, exitCode: number | null = null): NodeChildProcess => {
  // SAFETY: The process-tree boundary reads only pid, exitCode, and signalCode from this stub.
  return { pid, exitCode, signalCode: null } as NodeChildProcess;
};

describe("subagent process-tree boundary", () => {
  effectIt.effect("does not target an already-exited Windows PID", () =>
    Effect.gen(function* () {
      const taskkill = fakeProcessTreeTerminator();
      yield* terminateProcessTree(childStub(42, 0), "force", {
        platform: "win32",
        spawnTaskkill: taskkill.spawn,
      });
      expect(taskkill.spawns).toEqual([]);
    }),
  );

  effectIt.effect("accepts a failed taskkill once the live Windows leader has exited", () =>
    Effect.gen(function* () {
      const taskkill = fakeProcessTreeTerminator();
      const leader = childStub(44);
      const pending = yield* terminateProcessTree(leader, "force", {
        platform: "win32",
        spawnTaskkill: taskkill.spawn,
      }).pipe(Effect.forkChild({ startImmediately: true }));
      Object.assign(leader, { exitCode: 1 });
      taskkill.emit("exit", 1);
      yield* Fiber.join(pending);
      expect(taskkill.spawns).toEqual([{ command: "taskkill", args: ["/pid", "44", "/T", "/F"] }]);
    }),
  );

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
          return Effect.runPromise(terminateProcessTree(leader, "force"));
        })
        .then(() => waitForExit(grandchildPid))
        .then(() => {
          expect(processExists(grandchildPid)).toBe(false);
        })
        .finally(() => {
          // Best-effort fixture cleanup.
          if (grandchildPid > 0) signalProcess(grandchildPid, "SIGKILL");
        });
    },
  );
});
