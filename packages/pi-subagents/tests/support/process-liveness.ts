// Live-process probes for tests that own real children; callers poll them on the live clock.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { signalProcess } from "pi-cosmic-core";
import { nodeFsPromises as fs } from "./node-builtins.ts";

/** Only ESRCH proves a process is gone; any other probe result counts as alive. */
export const processAlive = (pid: number): boolean => signalProcess(pid, 0) !== "absent";

/** Waits up to 2 s for a fixture to publish its positive pid to `path`. */
export const waitForPid = (path: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const pid = Number(yield* Effect.promise(() => fs.readFile(path, "utf8").catch(() => "")));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
      yield* Effect.sleep(Duration.millis(10));
    }
    return yield* Effect.die(new Error(`No fixture pid was published to ${path}.`));
  });

/** Waits up to 2 s for `pid` to exit; callers assert the outcome. */
export const waitForDead = (pid: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200 && processAlive(pid); attempt++)
      yield* Effect.sleep(Duration.millis(10));
  });
