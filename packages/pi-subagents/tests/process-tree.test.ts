import { describe, expect, it } from "@effect/vitest";
import {
  confirmProcessGroupExit,
  signalProcess,
  signalProcessGroup,
  type BoundedProcessResult,
} from "pi-cosmic-core";
import { once } from "node:events";
import * as Effect from "effect/Effect";
import {
  descendantGroupsFromTable,
  detachedDescendantGroups,
  terminateProcessTree,
} from "../src/boundary/process-tree.ts";
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

  it("finds process groups that owned members started, however deeply nested", () => {
    const table = [
      "    2     0     0 S", // Linux kernel processes need not belong to a user process group.
      "  100     1   100 Ss",
      "  101   100   100 S",
      "  200   100   200 Ss",
      "  201   200   200 S",
      "  300   201   300 Ss",
      "  400   101   400 Z",
      "  500     1   500 S",
      "  600   500   600 S",
    ].join("\n");
    expect(new Set(descendantGroupsFromTable(table, 100))).toEqual(new Set([200, 300]));
  });

  it("rejects malformed or ownerless snapshots rather than silently dropping process rows", () => {
    for (const table of [
      "100 1 100 S\nmalformed",
      "100 1 100 S extra",
      "0 1 100 S",
      "100 1 999 S",
      "100 1 100 S\n101 100 0 S",
      "",
    ])
      expect(descendantGroupsFromTable(table, 100)).toBeUndefined();
  });

  for (const fault of [
    "failed",
    "overflowed",
    "timedOut",
    "cleanupUnconfirmed",
    "malformed",
  ] as const)
    it.effect(`fails closed on ${fault} detached descendant discovery`, () =>
      Effect.gen(function* () {
        const result: BoundedProcessResult = {
          code: fault === "failed" ? 1 : 0,
          signal: null,
          stdout: fault === "malformed" ? "not a process table" : "100 1 100 S",
          stderr: "process table unavailable",
          overflowed: fault === "overflowed",
          timedOut: fault === "timedOut",
          cleanupUnconfirmed: fault === "cleanupUnconfirmed",
        };
        const error = yield* detachedDescendantGroups(100, () => Effect.succeed(result)).pipe(
          Effect.flip,
        );
        expect(error.code).toMatch(/^descendant_snapshot_/);
      }),
    );

  it.live("finds a detached command group that survives its owner's group signal", () =>
    Effect.gen(function* () {
      const leader = spawn(
        process.execPath,
        [
          "-e",
          `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
process.stdout.write(String(child.pid) + "\\n");
setInterval(() => {}, 1000);`,
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      let output = "";
      leader.stdout?.setEncoding("utf8");
      leader.stdout?.on("data", (chunk: string) => {
        output += chunk;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          signalProcessGroup(leader.pid, "SIGKILL");
          const commandPid = Number(output.trim());
          if (commandPid > 0) signalProcessGroup(commandPid, "SIGKILL");
        }),
      );
      for (let attempt = 0; attempt < 200 && !output.includes("\n"); attempt++)
        yield* Effect.sleep("10 millis");
      const commandPid = Number(output.trim());
      expect(Number.isSafeInteger(commandPid) && commandPid > 0).toBe(true);
      expect(yield* detachedDescendantGroups(leader.pid ?? 0)).toEqual([commandPid]);

      yield* terminateProcessTree(leader, "force");
      expect(yield* confirmProcessGroupExit(leader.pid, 2_000)).toBe(true);
      expect(yield* confirmProcessGroupExit(commandPid, 200)).toBe(false);
    }),
  );
});
