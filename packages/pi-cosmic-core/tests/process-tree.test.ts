import { once } from "node:events";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";
import {
  processGroupSignalError,
  signalProcess,
  signalProcessGroup,
  terminateWindowsProcessTree,
  type ProcessTreeTerminatorSpawn,
} from "../index.ts";
import { nodeSpawn } from "../src/platform/node-builtins.ts";
import { fakeProcessTreeTerminator } from "../testing.ts";

const terminate = (
  spawnTaskkill: ProcessTreeTerminatorSpawn,
  targetExited?: () => boolean,
  mode: "graceful" | "force" = "force",
) => terminateWindowsProcessTree({ pid: 42, mode, spawnTaskkill, targetExited });
const started = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.forkScoped({ startImmediately: true }));

describe("windows process-tree terminator", () => {
  it.effect("confirms a zero exit, detaches, and passes the mode to taskkill", () =>
    Effect.gen(function* () {
      for (const mode of ["force", "graceful"] as const) {
        const fake = fakeProcessTreeTerminator();
        const fiber = yield* started(terminate(fake.spawn, undefined, mode));
        fake.emit("exit", 0);
        yield* Fiber.join(fiber);
        expect(fake.spawns).toEqual([
          { command: "taskkill", args: ["/pid", "42", "/T", ...(mode === "force" ? ["/F"] : [])] },
        ]);
        expect(fake.listenerCounts()).toEqual({ exit: 0, error: 0 });
        expect(fake.killed).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("reports a synchronous spawn throw with only its errno code", () =>
    Effect.gen(function* () {
      const failure = yield* terminate(() => {
        throw Object.assign(new Error("private spawn details"), { code: "ENOENT" });
      }).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "ProcessTreeError",
        operation: "spawn taskkill",
        code: "taskkill_spawn_failed",
        message: "Unable to start the Windows process-tree terminator. (ENOENT)",
      });
      expect(String(failure)).not.toContain("private spawn details");
    }),
  );

  it.effect("fails a nonzero exit unless the target has exited by then", () =>
    Effect.gen(function* () {
      let exited = false;
      const running = fakeProcessTreeTerminator();
      const failed = yield* started(terminate(running.spawn, () => exited));
      running.emit("exit", 1);
      expect(yield* Fiber.join(failed).pipe(Effect.flip)).toMatchObject({
        code: "taskkill_exit",
        message: "The Windows process-tree terminator exited with code 1.",
      });

      const unknown = fakeProcessTreeTerminator();
      const signalled = yield* started(terminate(unknown.spawn));
      unknown.emit("exit", null);
      expect(yield* Fiber.join(signalled).pipe(Effect.flip)).toMatchObject({
        message: "The Windows process-tree terminator exited with code unknown.",
      });

      const late = fakeProcessTreeTerminator();
      const settled = yield* started(terminate(late.spawn, () => exited));
      exited = true;
      late.emit("exit", 128);
      yield* Fiber.join(settled);
    }).pipe(Effect.scoped),
  );

  it.effect("skips taskkill for an already-exited target but always fails an error event", () =>
    Effect.gen(function* () {
      let exited = false;
      const skipped = fakeProcessTreeTerminator();
      // Built while the target runs; the exit check happens when the Effect runs.
      const skip = terminate(skipped.spawn, () => exited);
      exited = true;
      yield* skip;
      expect(skipped.spawns).toEqual([]);

      exited = false;
      const errored = fakeProcessTreeTerminator();
      const fiber = yield* started(terminate(errored.spawn, () => exited));
      exited = true;
      errored.emit(
        "error",
        Object.assign(new Error("exposed FAKE_SECRET_123"), { code: "EACCES" }),
      );
      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(failure).toMatchObject({
        operation: "run taskkill",
        code: "taskkill_spawn_failed",
        message: "The Windows process-tree terminator failed to start. (EACCES)",
      });
      expect(String(failure)).not.toContain("FAKE_SECRET_123");
      expect(errored.listenerCounts()).toEqual({ exit: 0, error: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("cleans up a helper whose listener install or removal throws", () =>
    Effect.gen(function* () {
      const install = fakeProcessTreeTerminator();
      const failed = yield* terminate((command, args, options) => {
        const child = install.spawn(command, args, options);
        return {
          ...child,
          on: (event, listener) => {
            if (event === "error") throw new Error("listener setup failed");
            child.on(event, listener);
          },
        };
      }).pipe(Effect.flip);
      expect(failed).toMatchObject({ code: "taskkill_spawn_failed" });
      expect(install.killed).toEqual(["SIGKILL"]);
      expect(install.isUnrefed()).toBe(true);
      expect(install.listenerCounts()).toEqual({ exit: 0, error: 0 });

      const removal = fakeProcessTreeTerminator();
      const fiber = yield* started(
        terminate((command, args, options) => {
          const child = removal.spawn(command, args, options);
          return {
            ...child,
            removeListener: (event, listener) => {
              child.removeListener(event, listener);
              throw new Error("listener removal failed");
            },
          };
        }),
      );
      removal.emit("exit", 0);
      expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
        code: "taskkill_detach_failed",
      });
      expect(removal.killed).toEqual(["SIGKILL"]);
      expect(removal.isUnrefed()).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("bounds a never-exiting helper with synchronous kill, unref, and a late listener", () =>
    Effect.gen(function* () {
      const fake = fakeProcessTreeTerminator();
      const fiber = yield* started(
        terminateWindowsProcessTree({
          pid: 42,
          mode: "force",
          spawnTaskkill: fake.spawn,
          taskkillTimeoutMillis: 5,
        }),
      );
      yield* TestClock.adjust(5);
      // Under TestClock a cleanup that awaited taskkill's exit would hang this join forever.
      expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
        code: "taskkill_timeout",
        message: "The Windows process-tree terminator timed out after 5 ms.",
      });
      expect(fake.killed).toEqual(["SIGKILL"]);
      expect(fake.isUnrefed()).toBe(true);
      expect(fake.listenerCounts()).toEqual({ exit: 0, error: 1 });
      fake.emit("error", new Error("late error"));
    }).pipe(Effect.scoped),
  );

  it.effect("kills the helper when its owner is interrupted and contains late errors", () =>
    Effect.gen(function* () {
      const fake = fakeProcessTreeTerminator();
      const fiber = yield* started(terminate(fake.spawn));
      yield* Fiber.interrupt(fiber);
      expect(fake.killed).toEqual(["SIGKILL"]);
      expect(fake.listenerCounts()).toEqual({ exit: 0, error: 1 });
      fake.emit("error", new Error("late error"));
      fake.emit("exit", 0);
    }).pipe(Effect.scoped),
  );
});

describe("process signals", () => {
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

  it.skipIf(process.platform === "win32")(
    "classifies ESRCH as absent and EPERM as permission",
    () => {
      const child = nodeSpawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      return once(child, "exit").then(() => {
        expect(signalProcess(child.pid, 0)).toBe("absent");
        expect(signalProcess(process.pid, 0)).toBe("present");
        if (process.getuid?.() !== 0) expect(signalProcess(1, 0)).toBe("permission");
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills a live detached group after its leader exits",
    () => {
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
    },
  );

  it("classifies POSIX group-signal failures and names only the EPERM errno", () => {
    expect(processGroupSignalError("permission")).toMatchObject({
      operation: "signal process group",
      code: "group_signal_failed",
    });
    expect(processGroupSignalError("permission").message).toContain("(EPERM)");
    expect(processGroupSignalError("failed").message).not.toContain("EPERM");
  });
});
