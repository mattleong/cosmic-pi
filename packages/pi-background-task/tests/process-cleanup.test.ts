import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { vi } from "vitest";
import { provideBuiltLayer, signalProcessGroup } from "pi-cosmic-core";
import { spawnIpcChild } from "pi-cosmic-core/testing";
import { LocalProcess } from "../src/boundary/local-process.ts";
import { normalizeConfig } from "../src/config/options.ts";
import { BackgroundTaskConfigStore } from "../src/config/store.ts";
import { BackgroundTaskService } from "../src/task/service.ts";

vi.setConfig({ testTimeout: 30_000 });

const hostScript = fileURLToPath(new URL("./fixtures/abrupt-exit-host.ts", import.meta.url));

const groupGone = (pid: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (signalProcessGroup(pid, 0) === "absent") return true;
      yield* Effect.sleep("10 millis");
    }
    return false;
  });

const killGroupsAfterward = (pids: ReadonlyArray<number>) =>
  Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const pid of pids) signalProcessGroup(pid, "SIGKILL");
    }),
  );

describe("real process cleanup", () => {
  it.live("kills a task's process group when its host exits without session shutdown", () =>
    Effect.gen(function* () {
      // The host transpiles the service graph on a cold start, which takes over 10 seconds on
      // loaded CI runners.
      const host = yield* spawnIpcChild(hostScript, [], { timeout: "25 seconds" });
      yield* host.wait("ready");
      const announced = host.messages.find(
        (message): message is string => Predicate.isString(message) && message.startsWith("group:"),
      );
      const pid = Number(announced?.slice("group:".length));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      yield* killGroupsAfterward([pid]);
      expect(signalProcessGroup(pid, 0)).toBe("present");

      host.child.send?.("exit");
      yield* host.exited;
      expect(host.child.exitCode).toBe(9);
      expect(yield* groupGone(pid)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("stops more than eight SIGTERM-ignoring tasks within one shared grace window", () => {
    const graceMillis = 1_000;
    const layer = BackgroundTaskService.layer().pipe(
      Layer.provide(
        Layer.mergeAll(
          LocalProcess.layer,
          Layer.succeed(
            BackgroundTaskConfigStore,
            normalizeConfig({ maxRunning: 12, stopGraceMs: graceMillis }),
          ),
          Path.layer,
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const tasks = yield* Effect.forEach(Array.from({ length: 10 }), () =>
        service.start({ command: "trap '' TERM; while :; do sleep 1; done", cwd: "." }),
      );
      const pids = tasks.flatMap((task) => (task.pid === undefined ? [] : [task.pid]));
      expect(pids).toHaveLength(tasks.length);
      yield* killGroupsAfterward(pids);

      const startedAt = yield* Clock.currentTimeMillis;
      const stopped = yield* service.stopAll();
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt;

      expect(stopped.map((task) => task.state)).toEqual(tasks.map(() => "stopped"));
      expect(elapsed).toBeGreaterThanOrEqual(graceMillis - 50);
      expect(elapsed).toBeLessThan(graceMillis * 1.8);
      for (const pid of pids) expect(yield* groupGone(pid)).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });
});
