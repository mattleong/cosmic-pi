import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
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
      const announced = Option.getOrUndefined(
        Arr.findFirst(Arr.filter(host.messages, Predicate.isString), (message) =>
          Fn.pipe(message, Str.startsWith("group:")),
        ),
      );
      const pid = Number(announced && Fn.pipe(announced, Str.slice("group:".length)));
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
          contains: ["ready"],
          waitSeconds: 30,
        });
        expect(ready.outcome).toBe("matched");
      }

      const startedAt = yield* Clock.currentTimeMillis;
      const stopped = yield* service.stopAll();
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt;

      expect(Arr.map(stopped, (task) => task.state)).toEqual(Arr.map(tasks, () => "stopped"));
      expect(elapsed).toBeGreaterThanOrEqual(graceMillis - 50);
      // Ordering rather than elapsed time: every task saw SIGTERM before the shared window
      // ended any of them. Stopping in batches signals later tasks only after earlier ones end.
      const termedAt = yield* Effect.forEach(tasks, (task) =>
        service.logs({ id: task.id, afterCursor: 0 }).pipe(
          Effect.map((logs) =>
            Option.getOrUndefined(
              Option.map(
                Arr.findFirst(logs.events, (event) => Fn.pipe(event.text, Str.includes("term"))),
                (event) => event.timestamp,
              ),
            ),
          ),
        ),
      );
      const endedAt = Arr.map(stopped, (task) => task.endedAt);
      expect(Arr.every(termedAt, Predicate.isNumber)).toBe(true);
      expect(Arr.every(endedAt, Predicate.isNumber)).toBe(true);
      expect(Math.max(...Arr.filter(termedAt, Predicate.isNumber))).toBeLessThan(
        Math.min(...Arr.filter(endedAt, Predicate.isNumber)),
      );
      for (const pid of pids) expect(yield* groupGone(pid)).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });
});
