import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { vi } from "vitest";
import { signalProcessGroup } from "pi-cosmic-core";
import { spawnIpcChild, provideBuiltLayer } from "pi-cosmic-core/testing";
import { LocalProcess } from "../src/boundary/local-process.ts";
import { normalizeConfig } from "../src/config/options.ts";
import { BackgroundTaskConfigStore } from "../src/config/store.ts";
import { BackgroundTaskService } from "../src/task/service.ts";

vi.setConfig({ testTimeout: 60_000 });

const hostScript = fileURLToPath(new URL("./fixtures/abrupt-exit-host.ts", import.meta.url));

// Polls until a deadline generous enough for loaded runners; a gone group returns at once.
const groupGone = (pid: number) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 10_000;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (signalProcessGroup(pid, 0) === "absent") return true;
      yield* Effect.sleep("10 millis");
    }
    return signalProcessGroup(pid, 0) === "absent";
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
      const host = yield* spawnIpcChild(hostScript, [], { timeout: "40 seconds" });
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
    const graceMillis = 2_000;
    const taskCount = 12;
    const layer = BackgroundTaskService.layer().pipe(
      Layer.provide(
        Layer.mergeAll(
          LocalProcess.layer,
          Layer.succeed(
            BackgroundTaskConfigStore,
            normalizeConfig({ maxRunning: taskCount, stopGraceMs: graceMillis }),
          ),
          Path.layer,
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      // Each task reports SIGTERM and keeps running, so only the forced stop ends it.
      const tasks = yield* Effect.forEach(Array.from({ length: taskCount }), () =>
        service.start({
          command: "trap 'echo term' TERM; echo ready; while :; do sleep 1; done",
          cwd: ".",
        }),
      );
      const pids = Arr.flatMapNullishOr(tasks, (task) => task.pid);
      expect(pids).toHaveLength(tasks.length);
      yield* killGroupsAfterward(pids);
      for (const task of tasks) {
        const ready = yield* service.wait({
          id: task.id,
          until: "output",
          contains: "ready",
          waitSeconds: 30,
        });
        expect(ready.outcome).toBe("matched");
      }

      const startedAt = yield* Clock.currentTimeMillis;
      const stopped = yield* service.stopAll();
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt;

      expect(stopped.map((task) => task.state)).toEqual(tasks.map(() => "stopped"));
      expect(elapsed).toBeGreaterThanOrEqual(graceMillis - 50);
      // Ordering rather than elapsed time: every task saw SIGTERM before the shared window
      // ended any of them. Stopping in batches signals later tasks only after earlier ones end.
      const termedAt = yield* Effect.forEach(tasks, (task) =>
        service
          .logs({ id: task.id, afterCursor: 0 })
          .pipe(
            Effect.map(
              (logs) => logs.events.find((event) => event.text.includes("term"))?.timestamp,
            ),
          ),
      );
      const endedAt = stopped.map((task) => task.endedAt);
      expect(termedAt.every(Predicate.isNumber)).toBe(true);
      expect(endedAt.every(Predicate.isNumber)).toBe(true);
      expect(Math.max(...termedAt.filter(Predicate.isNumber))).toBeLessThan(
        Math.min(...endedAt.filter(Predicate.isNumber)),
      );
      for (const pid of pids) expect(yield* groupGone(pid)).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });
});
