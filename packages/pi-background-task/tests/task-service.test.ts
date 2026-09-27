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
import { issueMessageStyleProblems } from "pi-code-previews/testing";
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
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../src/task/bounds.ts";
import { OUTPUT_FAILURE_LINE_LIMIT } from "pi-code-previews";
import type { BackgroundTaskStatus } from "../src/task/model.ts";
import type {
  BackgroundTaskState,
  BackgroundTaskProjection,
  StartBackgroundTask,
  WaitForBackgroundTask,
} from "../src/task/model.ts";
import { BackgroundTaskService, type BackgroundTaskServiceContract } from "../src/task/service.ts";

interface FakeProcessControl {
  readonly handle: LocalProcessHandle;
  readonly modes: Array<"graceful" | "force">;
  readonly awaitMode: (mode: "graceful" | "force") => Effect.Effect<void>;
  readonly offer: (stream: "stdout" | "stderr", text: string, droppedBytes?: number) => void;
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
          const modeRequested = {
            graceful: yield* Deferred.make<void>(),
            force: yield* Deferred.make<void>(),
          };
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
                Deferred.doneUnsafe(modeRequested[mode], Effect.void);
                if (behavior.failTermination)
                  return Effect.fail(
                    new LocalProcessError({
                      operation: "terminate process tree",
                      reason: "terminate",
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
            awaitMode: (mode) => Deferred.await(modeRequested[mode]),
            offer: (stream, text, droppedBytes = 0) =>
              void Queue.offerUnsafe(output, { stream, text, droppedBytes }),
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
  // Preserve the original ownership order: the provided service outlives the test's inner scope.
  const run = <A, Eff extends Effect.Effect<unknown, unknown, unknown>>(
    test: (service: BackgroundTaskServiceContract) => Generator<Eff, A, unknown>,
  ) =>
    Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      return yield* test(service);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  return { ...fake, layer, run };
}

const taskInput = (overrides: Partial<StartBackgroundTask> = {}): StartBackgroundTask => ({
  command: "server",
  cwd: ".",
  ...overrides,
});

const outputWait = (
  id: string,
  overrides: Partial<Omit<WaitForBackgroundTask, "id" | "until">> = {},
): WaitForBackgroundTask => ({
  id,
  until: "output",
  contains: "ready",
  waitSeconds: 30,
  ...overrides,
});

const exitWait = (id: string, waitSeconds = 30): WaitForBackgroundTask => ({
  id,
  until: "exit",
  waitSeconds,
});
const forkNow = Effect.forkScoped({ startImmediately: true });
const emitAndRead = (
  service: BackgroundTaskServiceContract,
  control: FakeProcessControl | undefined,
  id: string,
  afterCursor: number,
  text: string,
  stream: "stdout" | "stderr" = "stdout",
) =>
  Effect.gen(function* () {
    const reading = yield* service.logs({ id, afterCursor, waitSeconds: 30 }).pipe(forkNow);
    control?.offer(stream, text);
    return yield* Fiber.join(reading);
  });

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
  for (const outcome of ["exit", "output", "timeout", "interrupt"] as const) {
    it.effect(`clears awaited activity after ${outcome}`, () => {
      const admitted = Deferred.makeUnsafe<void>();
      let latest: BackgroundTaskProjection = { tasks: [] };
      const harness = serviceHarness({}, (projection) => {
        latest = projection;
        if (projection.tasks.some((task) => task.awaited))
          Deferred.doneUnsafe(admitted, Effect.void);
      });
      return harness.run(function* (service) {
        const started = yield* service.start(taskInput());
        const waiting = yield* service
          .wait(outcome === "output" ? outputWait(started.id) : exitWait(started.id, 5))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(admitted);
        expect(latest.tasks[0]?.awaited).toBe(true);
        if (outcome === "exit") harness.controls[0]?.complete();
        else if (outcome === "output") harness.controls[0]?.offer("stdout", "ready");
        else if (outcome === "timeout") yield* TestClock.adjust("5 seconds");
        if (outcome === "interrupt") yield* Fiber.interrupt(waiting);
        else yield* Fiber.join(waiting);
        expect(latest.tasks[0]?.awaited).toBe(false);
      });
    });
  }

  it.effect("keeps a task awaited until its last concurrent waiter leaves", () => {
    let admitted = Deferred.makeUnsafe<void>();
    let latest: BackgroundTaskProjection = { tasks: [] };
    const harness = serviceHarness({}, (projection) => {
      latest = projection;
      if (projection.tasks.some((task) => task.awaited)) Deferred.doneUnsafe(admitted, Effect.void);
    });
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const first = yield* service.wait(outputWait(started.id)).pipe(Effect.forkScoped);
      yield* Deferred.await(admitted);
      admitted = Deferred.makeUnsafe<void>();
      const second = yield* service.wait(exitWait(started.id)).pipe(Effect.forkScoped);
      yield* Deferred.await(admitted);
      yield* Fiber.interrupt(first);
      expect(latest.tasks[0]?.awaited).toBe(true);
      yield* Fiber.interrupt(second);
      expect(latest.tasks[0]?.awaited).toBe(false);
      expect((yield* service.status(started.id)).state).toBe("running");
    });
  });
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
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput({ command: "watch" }));

      const read = (afterCursor: number, text: string) =>
        emitAndRead(service, harness.controls[0], started.id, afterCursor, text);
      const firstSlice = yield* read(0, "a");
      expect(firstSlice.events.map((event) => event.cursor)).toEqual([1]);
      expect(outputTexts()).toEqual(["a"]);

      const secondSlice = yield* read(firstSlice.nextCursor, "b");
      const thirdSlice = yield* read(secondSlice.nextCursor, "c");
      expect([firstSlice.nextCursor, secondSlice.nextCursor, thirdSlice.nextCursor]).toEqual([
        1, 2, 3,
      ]);
      expect(outputTexts()).toEqual(["a"]);

      yield* TestClock.adjust("999 millis");
      expect(outputTexts()).toEqual(["a"]);
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(trailing);
      expect(outputTexts()).toEqual(["a", "abc"]);
    });
  });

  it.effect("starts, long-polls logs, and publishes process exit", () => {
    const terminal = awaitState("exited");
    const harness = serviceHarness({}, terminal.publish);
    return harness.run(function* (service) {
      const started = yield* service.start({ command: "watch", cwd: ".", name: "watcher" });
      expect(started).toMatchObject({ id: "task-1", state: "running", pid: 10_000 });

      const waiting = yield* service.logs({ id: started.id, waitSeconds: 30 }).pipe(forkNow);
      harness.controls[0]?.offer("stdout", "ready\n");
      const logs = yield* Fiber.join(waiting);
      expect(logs.events.map((event) => event.text).join("")).toContain("ready");

      harness.controls[0]?.complete();
      yield* Deferred.await(terminal.reached);
      expect(yield* service.status(started.id)).toMatchObject({ state: "exited", exitCode: 0 });
    });
  });

  it.effect(
    "admits normalized start metadata at the bounds and rejects overflow before spawn",
    () => {
      const harness = serviceHarness();
      const cwdAtLimit = `/${"d".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxCwdChars - 1)}`;
      return harness.run(function* (service) {
        const started = yield* service.start({
          command: ` ${"c".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxCommandChars)} `,
          cwd: cwdAtLimit,
          name: ` ${"n".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars)} `,
        });
        expect(started).toMatchObject({
          id: "task-1",
          command: "c".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxCommandChars),
          cwd: cwdAtLimit,
          name: "n".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars),
        });
        expect(harness.controls).toHaveLength(1);

        expect(
          yield* service
            .start({
              command: ` ${"c".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxCommandChars + 1)} `,
              cwd: ".",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "InvalidBackgroundCommandError" });
        expect(
          yield* service
            .start({
              command: "valid",
              cwd: ".",
              name: ` ${"n".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars + 1)} `,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "InvalidBackgroundCommandError" });
        expect(
          yield* service.start({ command: "valid", cwd: `${cwdAtLimit}d` }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "InvalidBackgroundCwdError" });
        expect(harness.controls).toHaveLength(1);
        expect((yield* service.list()).map((task) => task.id)).toEqual(["task-1"]);

        const next = yield* service.start(taskInput({ command: "next" }));
        expect(next.id).toBe("task-2");
        expect(harness.controls).toHaveLength(2);
        yield* service.stopAll();
      });
    },
  );

  it.effect("waits for literal output across retained chunks", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const waiting = yield* service
        .wait(outputWait(started.id, { contains: "ready now", afterCursor: 0 }))
        .pipe(forkNow);

      harness.controls[0]?.offer("stdout", "rea");
      yield* Effect.yieldNow;
      harness.controls[0]?.offer("stdout", "dy now\n");
      const result = yield* Fiber.join(waiting);

      expect(result).toMatchObject({
        id: started.id,
        outcome: "matched",
        matchCursor: 2,
        nextCursor: 2,
        snapshot: { state: "running" },
      });
      yield* service.stop(started.id);
    });
  });

  it.effect("matches literal output already retained before the wait starts", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      yield* emitAndRead(service, harness.controls[0], started.id, 0, "server ready\n");

      expect(yield* service.wait(outputWait(started.id, { waitSeconds: 0 }))).toMatchObject({
        outcome: "matched",
        matchCursor: 1,
      });
      yield* service.stop(started.id);
    });
  });

  it.effect("does not match a literal across stdout and stderr boundaries", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const control = harness.controls[0];
      const first = yield* emitAndRead(service, control, started.id, 0, "rea");
      yield* emitAndRead(service, control, started.id, first.nextCursor, "dy", "stderr");

      expect(yield* service.wait(outputWait(started.id, { waitSeconds: 0 }))).toMatchObject({
        outcome: "timeout",
        snapshot: { state: "running" },
      });
      yield* service.stop(started.id);
    });
  });

  for (const { name, droppedStream, droppedText, suffix } of [
    {
      name: "does not match across discarded output",
      droppedStream: "stdout",
      droppedText: "dy",
      suffix: "",
    },
    {
      name: "resets every stream carry when dropped bytes attach to another stream",
      droppedStream: "stderr",
      droppedText: "diagnostic",
      suffix: "dy",
    },
  ] as const) {
    it.effect(name, () => {
      const harness = serviceHarness();
      return harness.run(function* (service) {
        const started = yield* service.start(taskInput());
        const waiting = yield* service.wait(outputWait(started.id)).pipe(forkNow);

        harness.controls[0]?.offer("stdout", "rea");
        yield* Effect.yieldNow;
        harness.controls[0]?.offer(droppedStream, droppedText, 10);
        if (suffix) harness.controls[0]?.offer("stdout", suffix);
        harness.controls[0]?.complete();
        expect(yield* Fiber.join(waiting)).toMatchObject({
          outcome: "completed",
          snapshot: { state: "exited" },
        });
      });
    });
  }

  it.effect("does not rebase a future output cursor", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const waiting = yield* service
        .wait(outputWait(started.id, { afterCursor: 10 }))
        .pipe(forkNow);

      harness.controls[0]?.offer("stdout", "ready");
      harness.controls[0]?.complete();
      expect(yield* Fiber.join(waiting)).toMatchObject({ outcome: "completed" });
    });
  });

  it.effect("waits for exit and returns the terminal snapshot", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput({ command: "check" }));
      const waiting = yield* service.wait(exitWait(started.id)).pipe(forkNow);

      harness.controls[0]?.complete({ exitCode: 1 });
      expect(yield* Fiber.join(waiting)).toMatchObject({
        outcome: "completed",
        snapshot: { state: "failed", exitCode: 1 },
      });
    });
  });

  it.effect("keeps one redacted, bounded line of a failed task's output in memory", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput({ command: "check" }));
      yield* emitAndRead(service, harness.controls[0], started.id, 0, "building\n> vitest run\n");
      yield* emitAndRead(
        service,
        harness.controls[0],
        started.id,
        1,
        `FAIL tests/auth.test.ts token=hunter2secret ${"x".repeat(200)}\nnpm ERR! code 1\n`,
        "stderr",
      );
      const waiting = yield* service.wait(exitWait(started.id)).pipe(forkNow);
      harness.controls[0]?.complete({ exitCode: 1 });
      const failed: BackgroundTaskStatus = (yield* Fiber.join(waiting)).snapshot;
      expect(failed).toMatchObject({ state: "failed", exitCode: 1 });
      const line = failed.failureCause ?? "";
      expect(line).toMatch(/^FAIL tests\/auth\.test\.ts/u);
      expect(line).not.toContain("hunter2secret");
      expect(line.length).toBeLessThanOrEqual(OUTPUT_FAILURE_LINE_LIMIT);

      // A clean exit keeps metadata only, even when its output mentions errors.
      const clean = yield* service.start(taskInput({ command: "check" }));
      yield* emitAndRead(service, harness.controls[1], clean.id, 0, "error handling tests ok\n");
      const exiting = yield* service.wait(exitWait(clean.id)).pipe(forkNow);
      harness.controls[1]?.complete({ exitCode: 0 });
      expect((yield* Fiber.join(exiting)).snapshot).not.toHaveProperty("failureCause");
    });
  });

  it.effect("returns a normal timeout result without stopping the task", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const waiting = yield* service.wait(exitWait(started.id, 5)).pipe(forkNow);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(waiting)).toMatchObject({
        outcome: "timeout",
        snapshot: { state: "running" },
      });
      expect((yield* service.status(started.id)).state).toBe("running");
      yield* service.stop(started.id);
    });
  });

  it.effect("rejects an invalid output wait predicate", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      expect(
        yield* service
          .wait({ id: started.id, until: "output", contains: "", waitSeconds: 1 })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "InvalidBackgroundCommandError" });
      expect(
        yield* service
          .wait({ id: started.id, until: "exit", contains: "irrelevant", waitSeconds: 1 })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "InvalidBackgroundCommandError" });
      yield* service.stop(started.id);
    });
  });

  it.effect("stops a process tree idempotently", () => {
    const terminal = awaitState("stopped");
    const harness = serviceHarness({}, terminal.publish);
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const stopped = yield* service.stop(started.id);
      expect(stopped.state).toBe("stopped");
      expect(harness.controls[0]?.modes).toEqual(["graceful"]);
      expect((yield* service.stop(started.id)).state).toBe("stopped");
      expect(harness.controls[0]?.modes).toEqual(["graceful"]);
    });
  });

  it.effect("settles concurrent graceful and force stops after one force escalation", () => {
    const harness = serviceHarness({ stopGraceMs: 2_000 }, () => {}, { completeOnGraceful: false });
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const control = harness.controls[0];
      if (!control) throw new Error("started process was not captured");

      const gracefulStop = yield* service.stop(started.id).pipe(forkNow);
      yield* control.awaitMode("graceful");
      const forceStop = yield* service.stop(started.id, true).pipe(forkNow);
      yield* control.awaitMode("force");

      const settled = yield* Effect.all([Fiber.join(gracefulStop), Fiber.join(forceStop)]);
      expect(settled.map((snapshot) => snapshot.state)).toEqual(["stopped", "stopped"]);
      expect(control.modes).toEqual(["graceful", "force"]);
    });
  });

  it.effect("escalates graceful stop after the configured grace period", () => {
    const harness = serviceHarness({ stopGraceMs: 2_000 }, () => {}, { completeOnGraceful: false });
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const stopping = yield* service.stop(started.id).pipe(forkNow);
      yield* Effect.yieldNow;
      expect(harness.controls[0]?.modes).toEqual(["graceful"]);
      yield* TestClock.adjust("2 seconds");
      expect((yield* Fiber.join(stopping)).state).toBe("stopped");
      expect(harness.controls[0]?.modes).toEqual(["graceful", "force"]);
    });
  });

  it.effect("forces an owner stop interrupted after graceful dispatch", () => {
    const harness = serviceHarness({ stopGraceMs: 2_000 }, () => {}, { completeOnGraceful: false });
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const stopping = yield* service.stop(started.id).pipe(forkNow);
      yield* Effect.yieldNow;
      expect(harness.controls[0]?.modes).toEqual(["graceful"]);
      yield* TestClock.adjust("1999 millis");
      yield* Fiber.interrupt(stopping);
      expect(harness.controls[0]?.modes).toEqual(["graceful", "force"]);
      expect((yield* service.stop(started.id)).state).toBe("stopped");
    });
  });

  it.effect("retains capacity until a process confirms exit after stop times out", () => {
    const harness = serviceHarness({ stopGraceMs: 0, maxRunning: 1 }, () => {}, {
      completeOnGraceful: false,
      completeOnForce: false,
    });
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const stopping = yield* service.stop(started.id).pipe(forkNow);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      const failure = yield* Fiber.join(stopping).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "BackgroundTerminationError",
        id: started.id,
      });
      expect(yield* service.status(started.id)).toMatchObject({ state: "stopping" });
      expect((yield* service.list("active")).map((task) => task.id)).toEqual([started.id]);
      expect(
        yield* service.start(taskInput({ command: "second" })).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "BackgroundTaskCapacityError",
      });

      harness.controls[0]?.complete({ exitCode: null, signal: "SIGKILL" });
      yield* Effect.yieldNow;
      expect(yield* service.status(started.id)).toMatchObject({ state: "stopped" });
    });
  });

  it.effect("reports process-tree termination failures without fabricating completion", () => {
    const harness = serviceHarness({}, () => {}, { failTermination: true });
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
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
    });
  });

  it.effect("stops every sibling despite one failed termination and aggregates the failure", () => {
    const harness = serviceHarness({ stopGraceMs: 2_000, maxRunning: 2 }, () => {}, {
      bySpawn: [{ failTermination: true }, { completeOnGraceful: false }],
    });
    return harness.run(function* (service) {
      const first = yield* service.start(taskInput({ command: "first" }));
      const second = yield* service.start(taskInput({ command: "second" }));
      const stopping = yield* service.stopAll().pipe(forkNow);
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
    });
  });

  it.effect("stops all active tasks and preserves the captured input order", () => {
    const harness = serviceHarness({ maxRunning: 3 });
    return harness.run(function* (service) {
      yield* service.start(taskInput({ command: "first" }));
      yield* service.start(taskInput({ command: "second" }));
      yield* service.start(taskInput({ command: "third" }));
      const stopped = yield* service.stopAll();
      expect(stopped.map((task) => task.id)).toEqual(["task-1", "task-2", "task-3"]);
      expect(stopped.every((task) => task.state === "stopped")).toBe(true);
    });
  });

  it.effect("marks runtime timeouts without a default timeout", () => {
    const terminal = awaitState("timed_out");
    const harness = serviceHarness({}, terminal.publish);
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput({ timeoutSeconds: 10 }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(terminal.reached);
      expect((yield* service.status(started.id)).state).toBe("timed_out");
    });
  });

  it.effect("keeps an interrupted start owned by session shutdown", () => {
    const spawnGate = Deferred.makeUnsafe<void>();
    const harness = serviceHarness({}, () => {}, { spawnGate });
    return harness.run(function* (service) {
      const starting = yield* service.start(taskInput()).pipe(forkNow);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(starting);
      yield* Deferred.succeed(spawnGate, undefined);
      expect((yield* service.stopAll()).map((task) => task.state)).toEqual(["stopped"]);
      expect(harness.controls[0]?.modes).toContain("graceful");
    });
  });

  it.effect("updates snapshot metadata when the shared log budget evicts output", () => {
    const harness = serviceHarness({
      maxRunning: 2,
      logBufferBytesPerTask: 4_096,
      totalLogBufferBytes: 8_192,
    });
    return harness.run(function* (service) {
      const first = yield* service.start(taskInput({ command: "first" }));
      const second = yield* service.start(taskInput({ command: "second" }));
      yield* emitAndRead(service, harness.controls[0], first.id, 0, "a".repeat(3_000));
      yield* emitAndRead(service, harness.controls[1], second.id, 0, "b".repeat(3_000));
      expect((yield* service.status(first.id)).droppedLogBytes).toBe(3_000);
      yield* service.stopAll();
    });
  });

  it.effect("terminates a late handle while retaining stopping ownership until exit", () => {
    const spawnGate = Deferred.makeUnsafe<void>();
    const harness = serviceHarness({}, () => {}, { spawnGate });
    return harness.run(function* (service) {
      const starting = yield* service.start(taskInput()).pipe(forkNow);
      yield* Effect.yieldNow;
      const stopping = yield* service.stop("task-1").pipe(forkNow);
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
    });
  });

  it.effect("retains completed tasks independently of active tasks", () => {
    const harness = serviceHarness({ maxRunning: 2, maxRetained: 2 });
    return harness.run(function* (service) {
      const active = yield* service.start(taskInput({ command: "active" }));
      const completed: string[] = [];

      for (const command of ["first", "second", "third"]) {
        yield* TestClock.adjust("1 millis");
        const started = yield* service.start({ command, cwd: "." });
        const control = harness.controls.at(-1);
        if (!control) throw new Error("completed task process was not captured");
        control.complete();
        expect(yield* service.wait({ id: started.id, until: "exit" })).toMatchObject({
          outcome: "completed",
          snapshot: { state: "exited" },
        });
        completed.push(started.id);
      }

      expect((yield* service.list("active")).map((task) => task.id)).toEqual([active.id]);
      expect((yield* service.list("completed")).map((task) => task.id)).toEqual([
        completed[2],
        completed[1],
      ]);
      expect((yield* service.list()).map((task) => task.id)).toEqual([
        active.id,
        completed[2],
        completed[1],
      ]);
      yield* service.stop(active.id);
    });
  });

  it.effect("finishes admitted log and wait reads after retention evicts their task", () => {
    const harness = serviceHarness({ maxRunning: 2, maxRetained: 1 });
    return harness.run(function* (service) {
      const first = yield* service.start(taskInput({ command: "first" }));
      const second = yield* service.start(taskInput({ command: "second" }));
      const readingLogs = yield* service
        .logs({ id: first.id, afterCursor: 0, waitSeconds: 30 })
        .pipe(forkNow);
      const waitingForExit = yield* service.wait(exitWait(first.id)).pipe(forkNow);
      yield* Effect.yieldNow;

      // Both monitors are ready before either runs. The first completion wakes the admitted
      // readers, then the second completion evicts that terminal record before they resume.
      harness.controls[0]?.complete();
      harness.controls[1]?.complete();
      expect(yield* service.wait(exitWait(second.id))).toMatchObject({
        outcome: "completed",
        snapshot: { state: "exited" },
      });
      const missing = yield* service.status(first.id).pipe(Effect.flip);
      expect(missing).toMatchObject({ _tag: "BackgroundTaskNotFoundError" });
      // People see the first line, without the ID; the agent's copy still names it.
      const [headline = ""] = missing.message.split("\n");
      expect(issueMessageStyleProblems(headline, { forbidden: [first.id] })).toEqual([]);
      expect(missing.message).toContain(first.id);

      const [logs, waited] = yield* Effect.all([
        Fiber.join(readingLogs),
        Fiber.join(waitingForExit),
      ]);
      expect(logs).toMatchObject({ id: first.id, state: "exited", nextCursor: 0 });
      expect(waited).toMatchObject({
        id: first.id,
        outcome: "completed",
        snapshot: { state: "exited", exitCode: 0 },
      });
    });
  });

  it.effect("confirms active termination before the fixed monitor scope closes", () => {
    const terminal = awaitState("stopped");
    const harness = serviceHarness({}, terminal.publish);
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(harness.layer, scope);
      const service = Context.get(context, BackgroundTaskService);
      yield* service.start(taskInput());
      yield* Scope.close(scope, Exit.void);
      expect(harness.controls[0]?.modes).toContain("graceful");
      expect(Deferred.isDoneUnsafe(terminal.reached)).toBe(true);
    });
  });
});
