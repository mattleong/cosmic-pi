// Test-owned process fixture is boundary code.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { terminateProcessTree } from "../src/boundary/process-tree.ts";

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
};

const waitForExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 100 && processExists(pid); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("subagent process-tree boundary", () => {
  it("does not target an already-exited Windows PID", async () => {
    const spawnTaskkill = vi.fn();
    const child = { pid: 42, exitCode: 0, signalCode: null } as NodeChildProcess;
    await terminateProcessTree(child, "force", { platform: "win32", spawnTaskkill });
    expect(spawnTaskkill).not.toHaveBeenCalled();
  });

  it("bounds a hanging Windows taskkill helper", async () => {
    const killer = new EventEmitter() as NodeChildProcess;
    const kill = vi.fn(() => true);
    const unref = vi.fn(() => killer);
    killer.kill = kill;
    killer.unref = unref;
    const child = { pid: 43, exitCode: null, signalCode: null } as NodeChildProcess;
    await expect(
      terminateProcessTree(child, "force", {
        platform: "win32",
        taskkillTimeoutMillis: 5,
        spawnTaskkill: () => killer,
      }),
    ).rejects.toThrow("taskkill timed out after 5 ms");
    expect(kill).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
  });

  it("passes live Windows trees to bounded taskkill", async () => {
    const killer = new EventEmitter() as NodeChildProcess;
    killer.kill = vi.fn(() => true);
    const modes: string[] = [];
    const child = { pid: 44, exitCode: null, signalCode: null } as NodeChildProcess;
    const pending = terminateProcessTree(child, "force", {
      platform: "win32",
      spawnTaskkill: (_pid, mode) => {
        modes.push(mode);
        return killer;
      },
    });
    killer.emit("close", 0);
    await pending;
    expect(modes).toEqual(["force"]);
  });

  it.skipIf(process.platform === "win32")(
    "kills descendants in the detached process group after its leader exits",
    async () => {
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
      try {
        let output = "";
        leader.stdout?.setEncoding("utf8");
        leader.stdout?.on("data", (chunk: string) => {
          output += chunk;
        });
        await once(leader, "close");
        grandchildPid = Number(output.trim());
        expect(Number.isSafeInteger(grandchildPid)).toBe(true);
        expect(processExists(grandchildPid)).toBe(true);

        await terminateProcessTree(leader, "force");
        await waitForExit(grandchildPid);
        expect(processExists(grandchildPid)).toBe(false);
      } finally {
        if (grandchildPid > 0 && processExists(grandchildPid)) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // Best-effort fixture cleanup.
          }
        }
      }
    },
  );
});
