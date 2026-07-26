// Test-owned process fixture is boundary code.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
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
