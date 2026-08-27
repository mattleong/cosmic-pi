// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { provideBuiltLayer } from "pi-cosmic-core";
import {
  LocalProcess,
  LocalProcessError,
  type LocalProcessExit,
  type LocalProcessHandle,
} from "../src/boundary/local-process.ts";
import { normalizeConfig } from "../src/config/options.ts";
import { BackgroundTaskConfigStore } from "../src/config/store.ts";
import type { BackgroundTaskConfig } from "../src/config/schema.ts";
import type { BackgroundTaskState, BackgroundTaskProjection } from "../src/task/model.ts";
import { BackgroundTaskService } from "../src/task/service.ts";

interface FakeProcessControl {
  readonly handle: LocalProcessHandle;
  readonly modes: Array<"graceful" | "force">;
  readonly offer: (stream: "stdout" | "stderr", text: string) => void;
  readonly complete: (exit?: LocalProcessExit) => void;
}

interface FakeSpawnBehavior {
  readonly completeOnGraceful?: boolean;
  readonly completeOnForce?: boolean;
  readonly failTermination?: boolean;
}

interface FakeProcessOptions extends FakeSpawnBehavior {
  readonly spawnGate?: Deferred.Deferred<void>;
  /** Per-spawn behavior overrides by spawn index; missing entries fall back to the base options. */
  readonly bySpawn?: ReadonlyArray<FakeSpawnBehavior | undefined>;
}

function fakeProcessLayer(options: FakeProcessOptions = {}) {
  const controls: FakeProcessControl[] = [];
  const spawned = Deferred.makeUnsafe<void>();
  const layer = Layer.succeed(LocalProcess, {
    spawn: () =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          if (options.spawnGate) yield* Deferred.await(options.spawnGate);
          const behavior: FakeSpawnBehavior = { ...options, ...options.bySpawn?.[controls.length] };
          const output = yield* Queue.unbounded<
            {
              readonly stream: "stdout" | "stderr";
              readonly text: string;
              readonly droppedBytes: number;
            },
            Cause.Done
          >();
          const exited = yield* Deferred.make<LocalProcessExit>();
          const modes: Array<"graceful" | "force"> = [];
          let completed = false;
          const complete = (exit: LocalProcessExit = { exitCode: 0 }) => {
            if (completed) return;
            completed = true;
            Queue.endUnsafe(output);
            Deferred.doneUnsafe(exited, Effect.succeed(exit));
          };
          const handle: LocalProcessHandle = {
            pid: 10_000 + controls.length,
            output: Stream.fromQueue(output),
            awaitExit: Deferred.await(exited),
            droppedOutputBytes: () => 0,
            terminate: (mode) =>
              Effect.suspend(() => {
                modes.push(mode);
                if (behavior.failTermination)
                  return Effect.fail(
                    new LocalProcessError({
                      operation: "terminate process tree",
                      message: "Fixture termination failed.",
                    }),
                  );
                if (
                  (mode === "force" && behavior.completeOnForce !== false) ||
                  (mode === "graceful" && behavior.completeOnGraceful !== false)
                ) {
                  complete({
                    exitCode: null,
                    signal: mode === "force" ? "SIGKILL" : "SIGTERM",
                  });
                }
                return Effect.void;
              }),
          };
          controls.push({
            handle,
            modes,
            offer: (stream, text) =>
              void Queue.offerUnsafe(output, { stream, text, droppedBytes: 0 }),
            complete,
          });
          yield* Deferred.succeed(spawned, undefined);
          return handle;
        }),
        () => Effect.void,
      ),
  });
  return { layer, controls, spawned };
}

function serviceHarness(
  overrides: Partial<BackgroundTaskConfig> = {},
  onProjection: (projection: BackgroundTaskProjection) => void = () => {},
  fakeOptions: FakeProcessOptions = {},
) {
  const fake = fakeProcessLayer(fakeOptions);
  const config = Layer.succeed(
    BackgroundTaskConfigStore,
    normalizeConfig({ stopGraceMs: 0, ...overrides }),
  );
  const dependencies = Layer.mergeAll(fake.layer, config, Path.layer);
  const layer = BackgroundTaskService.layer({ publish: onProjection }).pipe(
    Layer.provide(dependencies),
  );
  return { ...fake, layer };
}

const awaitState = (state: BackgroundTaskState) => {
  const reached = Deferred.makeUnsafe<void>();
  return {
    reached,
    publish: (projection: BackgroundTaskProjection) => {
      if (projection.tasks.some((task) => task.state === state)) {
        Deferred.doneUnsafe(reached, Effect.void);
      }
    },
  };
};

describe("BackgroundTaskService", () => {
  it.effect("publishes output once at the leading edge and once at the trailing deadline", () => {
    const projections: BackgroundTaskProjection[] = [];
    const trailing = Deferred.makeUnsafe<void>();
    const harness = serviceHarness({}, (projection) => {
      projections.push(projection);
      const text = projection.tasks[0]?.logs.map((entry) => entry.text).join("") ?? "";
      if (text === "abc") Deferred.doneUnsafe(trailing, Effect.void);
    });
    const outputTexts = () =>
      projections
        .map((projection) => projection.tasks[0]?.logs.map((entry) => entry.text).join(""))
        .filter((text): text is string => Boolean(text));
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const started = yield* service.start({ command: "watch", cwd: "." });

      const first = yield* service
        .logs({ id: started.id, afterCursor: 0, waitSeconds: 30 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      harness.controls[0]?.offer("stdout", "a");
      const firstSlice = yield* Fiber.join(first);
      expect(firstSlice.events.map((event) => event.cursor)).toEqual([1]);
      expect(outputTexts()).toEqual(["a"]);

      const second = yield* service
        .logs({ id: started.id, afterCursor: firstSlice.nextCursor, waitSeconds: 30 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      harness.controls[0]?.offer("stdout", "b");
      const secondSlice = yield* Fiber.join(second);
      const third = yield* service
        .logs({ id: started.id, afterCursor: secondSlice.nextCursor, waitSeconds: 30 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      harness.controls[0]?.offer("stdout", "c");
      const thirdSlice = yield* Fiber.join(third);
      expect([firstSlice.nextCursor, secondSlice.nextCursor, thirdSlice.nextCursor]).toEqual([
        1, 2, 3,
      ]);
      expect(outputTexts()).toEqual(["a"]);

      yield* TestClock.adjust("999 millis");
      expect(outputTexts()).toEqual(["a"]);
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(trailing);
      expect(outputTexts()).toEqual(["a", "abc"]);
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("starts, long-polls logs, and publishes process exit", () => {
    const terminal = awaitState("exited");
    const harness = serviceHarness({}, terminal.publish);
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const started = yield* service.start({ command: "watch", cwd: ".", name: "watcher" });
      expect(started).toMatchObject({ id: "task-1", state: "running", pid: 10_000 });

      const waiting = yield* service
        .logs({ id: started.id, waitSeconds: 30 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      harness.controls[0]?.offer("stdout", "ready\n");
      const logs = yield* Fiber.join(waiting);
      expect(logs.events.map((event) => event.text).join("")).toContain("ready");

      harness.controls[0]?.complete();
      yield* Deferred.await(terminal.reached);
      expect(yield* service.status(started.id)).toMatchObject({ state: "exited", exitCode: 0 });
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("stops a process tree idempotently", () => {
    const terminal = awaitState("stopped");
    const harness = serviceHarness({}, terminal.publish);
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const started = yield* service.start({ command: "server", cwd: "." });
      const stopped = yield* service.stop(started.id);
      expect(stopped.state).toBe("stopped");
      expect(harness.controls[0]?.modes).toEqual(["graceful"]);
      expect((yield* service.stop(started.id)).state).toBe("stopped");
      expect(harness.controls[0]?.modes).toEqual(["graceful"]);
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("escalates graceful stop after the configured grace period", () => {
    const harness = serviceHarness({ stopGraceMs: 2_000 }, () => {}, { completeOnGraceful: false });
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const started = yield* service.start({ command: "server", cwd: "." });
      const stopping = yield* service
        .stop(started.id)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.yieldNow;
      expect(harness.controls[0]?.modes).toEqual(["graceful"]);
      yield* TestClock.adjust("2 seconds");
      expect((yield* Fiber.join(stopping)).state).toBe("stopped");
      expect(harness.controls[0]?.modes).toEqual(["graceful", "force"]);
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("forces an owner stop interrupted after graceful dispatch", () => {
    const harness = serviceHarness({ stopGraceMs: 2_000 }, () => {}, { completeOnGraceful: false });
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const started = yield* service.start({ command: "server", cwd: "." });
      const stopping = yield* service
        .stop(started.id)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.yieldNow;
      expect(harness.controls[0]?.modes).toEqual(["graceful"]);
      yield* TestClock.adjust("1999 millis");
      yield* Fiber.interrupt(stopping);
      expect(harness.controls[0]?.modes).toEqual(["graceful", "force"]);
      expect((yield* service.stop(started.id)).state).toBe("stopped");
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("retains capacity until a process confirms exit after stop times out", () => {
    const harness = serviceHarness({ stopGraceMs: 0, maxRunning: 1 }, () => {}, {
      completeOnGraceful: false,
      completeOnForce: false,
    });
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const started = yield* service.start({ command: "server", cwd: "." });
      const stopping = yield* service
        .stop(started.id)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      const failure = yield* Fiber.join(stopping).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "BackgroundTerminationError",
        id: started.id,
      });
      expect(yield* service.status(started.id)).toMatchObject({ state: "stopping" });
      expect((yield* service.list("active")).map((task) => task.id)).toEqual([started.id]);
      expect(yield* service.start({ command: "second", cwd: "." }).pipe(Effect.flip)).toMatchObject(
        {
          _tag: "BackgroundTaskCapacityError",
        },
      );

      harness.controls[0]?.complete({ exitCode: null, signal: "SIGKILL" });
      yield* Effect.yieldNow;
      expect(yield* service.status(started.id)).toMatchObject({ state: "stopped" });
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("reports process-tree termination failures without fabricating completion", () => {
    const harness = serviceHarness({}, () => {}, { failTermination: true });
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const started = yield* service.start({ command: "server", cwd: "." });
      const failure = yield* service.stop(started.id).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "BackgroundTerminationError",
        id: started.id,
        message: "Fixture termination failed.",
      });
      expect(yield* service.status(started.id)).toMatchObject({ state: "stopping" });
      harness.controls[0]?.complete({ exitCode: null, signal: "SIGTERM" });
      yield* Effect.yieldNow;
      expect(yield* service.status(started.id)).toMatchObject({ state: "stopped" });
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("stops every sibling despite one failed termination and aggregates the failure", () => {
    const harness = serviceHarness({ stopGraceMs: 2_000, maxRunning: 2 }, () => {}, {
      bySpawn: [{ failTermination: true }, { completeOnGraceful: false }],
    });
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const first = yield* service.start({ command: "first", cwd: "." });
      const second = yield* service.start({ command: "second", cwd: "." });
      const stopping = yield* service.stopAll().pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      const failure = yield* Fiber.join(stopping).pipe(Effect.flip);
      expect(failure._tag).toBe("BackgroundTerminationError");
      expect(failure).toMatchObject({ id: first.id });
      // The sibling's graceful-to-force workflow completed despite the first task's typed failure.
      expect(yield* service.status(second.id)).toMatchObject({ state: "stopped" });
      expect(harness.controls[1]?.modes).toEqual(["graceful", "force"]);
      // The failed task keeps stopping ownership until its process confirms exit.
      expect(yield* service.status(first.id)).toMatchObject({ state: "stopping" });
      harness.controls[0]?.complete({ exitCode: null, signal: "SIGTERM" });
      yield* Effect.yieldNow;
      expect((yield* service.status(first.id)).state).toBe("stopped");
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("stops all active tasks and preserves the captured input order", () => {
    const harness = serviceHarness({ maxRunning: 3 });
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      yield* service.start({ command: "first", cwd: "." });
      yield* service.start({ command: "second", cwd: "." });
      yield* service.start({ command: "third", cwd: "." });
      const stopped = yield* service.stopAll();
      expect(stopped.map((task) => task.id)).toEqual(["task-1", "task-2", "task-3"]);
      expect(stopped.every((task) => task.state === "stopped")).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("marks runtime timeouts without a default timeout", () => {
    const terminal = awaitState("timed_out");
    const harness = serviceHarness({}, terminal.publish);
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const started = yield* service.start({ command: "server", cwd: ".", timeoutSeconds: 10 });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(terminal.reached);
      expect((yield* service.status(started.id)).state).toBe("timed_out");
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("keeps an interrupted start owned by session shutdown", () => {
    const spawnGate = Deferred.makeUnsafe<void>();
    const harness = serviceHarness({}, () => {}, { spawnGate });
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const starting = yield* service
        .start({ command: "server", cwd: "." })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(starting);
      yield* Deferred.succeed(spawnGate, undefined);
      expect((yield* service.stopAll()).map((task) => task.state)).toEqual(["stopped"]);
      expect(harness.controls[0]?.modes).toContain("graceful");
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("updates snapshot metadata when the shared log budget evicts output", () => {
    const harness = serviceHarness({
      maxRunning: 2,
      logBufferBytesPerTask: 4_096,
      totalLogBufferBytes: 8_192,
    });
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const first = yield* service.start({ command: "first", cwd: "." });
      const second = yield* service.start({ command: "second", cwd: "." });
      const firstLogs = yield* service
        .logs({ id: first.id, afterCursor: 0, waitSeconds: 30 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      harness.controls[0]?.offer("stdout", "a".repeat(3_000));
      yield* Fiber.join(firstLogs);
      const secondLogs = yield* service
        .logs({ id: second.id, afterCursor: 0, waitSeconds: 30 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      harness.controls[1]?.offer("stdout", "b".repeat(3_000));
      yield* Fiber.join(secondLogs);
      expect((yield* service.status(first.id)).droppedLogBytes).toBe(3_000);
      yield* service.stopAll();
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("terminates a late handle while retaining stopping ownership until exit", () => {
    const spawnGate = Deferred.makeUnsafe<void>();
    const harness = serviceHarness({}, () => {}, { spawnGate });
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const starting = yield* service
        .start({ command: "server", cwd: "." })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.yieldNow;
      const stopping = yield* service
        .stop("task-1")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(stopping).pipe(Effect.flip)).toMatchObject({
        _tag: "BackgroundTerminationError",
        id: "task-1",
      });
      expect((yield* service.status("task-1")).state).toBe("stopping");
      yield* Deferred.succeed(spawnGate, undefined);
      yield* Deferred.await(harness.spawned);
      yield* Effect.yieldNow;
      expect((yield* service.status("task-1")).state).toBe("stopped");
      expect(harness.controls[0]?.modes).toContain("force");
      yield* Fiber.await(starting);
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("enforces active capacity", () => {
    const harness = serviceHarness({ maxRunning: 1 });
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      yield* service.start({ command: "first", cwd: "." });
      const second = yield* Effect.result(service.start({ command: "second", cwd: "." }));
      expect(second._tag).toBe("Failure");
      yield* service.stopAll();
    }).pipe(Effect.scoped, provideBuiltLayer(harness.layer));
  });

  it.effect("confirms active termination before the fixed monitor scope closes", () => {
    const terminal = awaitState("stopped");
    const harness = serviceHarness({}, terminal.publish);
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(harness.layer, scope);
      const service = Context.get(context, BackgroundTaskService);
      yield* service.start({ command: "server", cwd: "." });
      yield* Scope.close(scope, Exit.void);
      expect(harness.controls[0]?.modes).toContain("graceful");
      expect(Deferred.isDoneUnsafe(terminal.reached)).toBe(true);
    });
  });

  it.effect("rejects starts after the service scope closes", () => {
    const harness = serviceHarness();
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(harness.layer, scope);
      const service = Context.get(context, BackgroundTaskService);
      yield* Scope.close(scope, Exit.void);
      expect(yield* service.start({ command: "late", cwd: "." }).pipe(Effect.flip)).toMatchObject({
        _tag: "BackgroundRuntimeClosedError",
      });
    });
  });
});
