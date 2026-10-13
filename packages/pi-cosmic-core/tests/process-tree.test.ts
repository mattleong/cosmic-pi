import { once } from "node:events";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";
import {
  confirmProcessGroupExit,
  processGroupSignalError,
  signalProcess,
  signalProcessGroup,
} from "../index.ts";
import { nodeSpawn } from "../src/platform/node-builtins.ts";
describe("process signals", () => {
  for (const initial of ["present", "permission"] as const)
    it.effect(`confirms process-group absence after an initial ${initial} observation`, () =>
      Effect.gen(function* () {
        const inspected = yield* Deferred.make<void>();
        let alive = true;
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(process, "kill").mockImplementation(() => {
              Deferred.doneUnsafe(inspected, Effect.void);
              if (alive) {
                if (initial === "present") return true;
                throw Object.assign(new Error("settling"), { code: "EPERM" });
              }
              throw Object.assign(new Error("gone"), { code: "ESRCH" });
            }),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const pending = yield* confirmProcessGroupExit(42, 100).pipe(Effect.forkScoped);
        yield* Deferred.await(inspected);
        alive = false;
        yield* TestClock.adjust(10);
        expect(yield* Fiber.join(pending)).toBe(true);
      }),
    );

  for (const code of ["EPERM", "EIO"] as const)
    it.effect(`does not confirm process-group exit when inspection fails with ${code}`, () =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(process, "kill").mockImplementation(() => {
              throw Object.assign(new Error("unavailable"), { code });
            }),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const pending = yield* confirmProcessGroupExit(42, 100).pipe(Effect.forkScoped);
        yield* TestClock.adjust(100);
        expect(yield* Fiber.join(pending)).toBe(false);
      }),
    );

  it("never signals a pid that is not a positive safe integer", () => {
    const kill = vi.spyOn(process, "kill");
    try {
      for (const pid of [undefined, 0, -1, 1.5, Number.NaN, 2 ** 60]) {
        expect(signalProcessGroup(pid, "SIGKILL")).toBe("failed");
        expect(signalProcess(pid, 0)).toBe("failed");
      }
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("classifies ESRCH as absent and EPERM as permission", () => {
    const child = nodeSpawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    return once(child, "exit")
      .then(() => ({
        exited: signalProcess(child.pid, 0),
        current: signalProcess(process.pid, 0),
        init: process.getuid?.() === 0 ? "permission" : signalProcess(1, 0),
      }))
      .then((classified) =>
        expect(classified).toEqual({ exited: "absent", current: "present", init: "permission" }),
      );
  });

  it("kills a live detached group after its leader exits", () => {
    const leader = nodeSpawn(
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
    leader.stdout.setEncoding("utf8");
    leader.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    let descendant = 0;
    return once(leader, "close")
      .then(() => {
        descendant = Number(output.trim());
        expect(signalProcess(descendant, 0)).toBe("present");
        expect(signalProcessGroup(leader.pid, "SIGKILL")).toBe("present");
        return Effect.runPromise(
          Effect.gen(function* () {
            for (let attempt = 0; attempt < 200; attempt += 1) {
              if (signalProcess(descendant, 0) === "absent") return;
              yield* Effect.sleep(10);
            }
          }),
        );
      })
      .then(() => expect(signalProcess(descendant, 0)).toBe("absent"))
      .finally(() => {
        if (descendant > 0) signalProcess(descendant, "SIGKILL");
      });
  });

  it("classifies POSIX group-signal failures and names only the EPERM errno", () => {
    expect(processGroupSignalError("permission")).toMatchObject({
      operation: "signal process group",
      code: "group_signal_failed",
    });
    expect(processGroupSignalError("permission").message).toContain("(EPERM)");
    expect(processGroupSignalError("failed").message).not.toContain("EPERM");
  });
});
