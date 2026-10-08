// Test-owned process fixture is boundary code.
import { describe, expect, it } from "@effect/vitest";
import { signalProcess } from "pi-cosmic-core";
import { fakeProcessTreeTerminator } from "pi-cosmic-core/testing";
import { once } from "node:events";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { terminateProcessTree } from "../src/boundary/process-tree.ts";
import { nodeSpawn as spawn, type NodeChildProcess } from "./support/node-builtins.ts";
import { processAlive, waitForDead } from "./support/process-liveness.ts";

const childStub = (pid: number, exitCode: number | null = null): NodeChildProcess => {
  // SAFETY: The process-tree boundary reads only pid, exitCode, and signalCode from this stub.
  return { pid, exitCode, signalCode: null } as NodeChildProcess;
};

describe("subagent process-tree boundary", () => {
  it.effect("does not target an already-exited Windows PID", () =>
    Effect.gen(function* () {
      const taskkill = fakeProcessTreeTerminator();
      yield* terminateProcessTree(childStub(42, 0), "force", {
        platform: "win32",
        spawnTaskkill: taskkill.spawn,
      });
      expect(taskkill.spawns).toEqual([]);
    }),
  );

  it.effect("accepts a failed taskkill once the live Windows leader has exited", () =>
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

  it.live.skipIf(process.platform === "win32")(
    "kills descendants in the detached process group after its leader exits",
    () =>
      Effect.gen(function* () {
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
        let output = "";
        leader.stdout?.setEncoding("utf8");
        leader.stdout?.on("data", (chunk: string) => {
          output += chunk;
        });
        yield* Effect.promise(() => once(leader, "close"));
        const grandchildPid = Number(output.trim());
        expect(Number.isSafeInteger(grandchildPid)).toBe(true);
        // Best-effort fixture cleanup.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => signalProcess(grandchildPid, "SIGKILL")),
        );
        expect(processAlive(grandchildPid)).toBe(true);
        yield* terminateProcessTree(leader, "force");
        yield* waitForDead(grandchildPid);
        expect(processAlive(grandchildPid)).toBe(false);
      }),
  );
});
