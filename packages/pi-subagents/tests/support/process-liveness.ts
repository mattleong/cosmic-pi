// Live-process probes for tests that own real children; polling runs on the live default clock.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { nodeErrorCode } from "../../src/boundary/harness-shared.ts";
import { nodeFsPromises as fs } from "./node-builtins.ts";

/** Only ESRCH reads as dead. A non-positive pid would address a process group, so it reads false. */
export const processAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return nodeErrorCode(error) !== "ESRCH";
  }
};

/** Waits up to 2 s for a fixture to publish its positive pid to `path`. */
export const waitForPid = (path: string): Promise<number> =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200; attempt++) {
        const pid = Number(yield* Effect.promise(() => fs.readFile(path, "utf8").catch(() => "")));
        if (Number.isSafeInteger(pid) && pid > 0) return pid;
        yield* Effect.sleep(Duration.millis(10));
      }
      return yield* Effect.die(new Error(`No fixture pid was published to ${path}.`));
    }),
  );

/** Waits up to 2 s for `pid` to exit; callers assert the outcome. */
export const waitForDead = (pid: number): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200 && processAlive(pid); attempt++)
        yield* Effect.sleep(Duration.millis(10));
    }),
  );
