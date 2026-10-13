import { describe, expect, it } from "@effect/vitest";
import { signalProcess } from "pi-cosmic-core";
import { once } from "node:events";
import * as Effect from "effect/Effect";
import { terminateProcessTree } from "../src/boundary/process-tree.ts";
import { nodeSpawn as spawn } from "./support/node-builtins.ts";
import { processAlive, waitForDead } from "./support/process-liveness.ts";

describe("subagent process-tree boundary", () => {
  it.live("kills descendants in the detached process group after its leader exits", () =>
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
      yield* Effect.addFinalizer(() => Effect.sync(() => signalProcess(grandchildPid, "SIGKILL")));
      expect(processAlive(grandchildPid)).toBe(true);
      yield* terminateProcessTree(leader, "force");
      yield* waitForDead(grandchildPid);
      expect(processAlive(grandchildPid)).toBe(false);
    }),
  );
});
