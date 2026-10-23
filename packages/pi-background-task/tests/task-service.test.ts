import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
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
import { makeCapturedLogger, provideBuiltLayer } from "pi-cosmic-core/testing";
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
import type {
  BackgroundTaskStatus,
  BackgroundTaskState,
  BackgroundTaskProjection,
  StartBackgroundTask,
  WaitForBackgroundTask,
} from "../src/task/model.ts";
import {
  BackgroundRuntimeClosedError,
  BackgroundSpawnError,
  BackgroundTaskCapacityError,
  BackgroundTaskNotFoundError,
  BackgroundTasksDisabledError,
  BackgroundTerminationError,
  InvalidBackgroundCommandError,
  InvalidBackgroundCwdError,
} from "../src/task/errors.ts";
import { BackgroundTaskService, type BackgroundTaskServiceContract } from "../src/task/service.ts";
import { combinedLogOutput } from "../src/tools/log-page.ts";

interface FakeProcessControl {
  readonly handle: LocalProcessHandle;
  readonly command: string;
  readonly modes: Array<"graceful" | "force">;
  readonly awaitMode: (mode: "graceful" | "force") => Effect.Effect<void>;
  readonly offer: (stream: "stdout" | "stderr", text: string, droppedBytes?: number) => void;
  /** The leader exits while its group, and so `awaitExit`, is still settling. */
  readonly exitLeader: () => void;
  /** Settles exit; with `holdOutput`, a process outside the group keeps the output open. */
  readonly complete: (exit?: LocalProcessExit, holdOutput?: boolean) => void;
  /** Output the boundary still queues; abandoning the output counts it as dropped. */
  readonly queueUndelivered: (bytes: number) => void;
}

interface FakeProcessOptions {
  readonly completeOnGraceful?: boolean;
  readonly completeOnForce?: boolean;
  readonly failTermination?: boolean;
  readonly spawnGate?: Deferred.Deferred<void>;
}

function fakeProcessLayer(options: FakeProcessOptions = {}) {
  const controls: FakeProcessControl[] = [];
  const spawned = Deferred.makeUnsafe<void>();
  const layer = Layer.succeed(LocalProcess, {
    spawn: (request) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          if (options.spawnGate) yield* Deferred.await(options.spawnGate);
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
          let leaderExited = false;
          let undeliveredBytes = 0;
          let droppedBytes = 0;
          const complete = (exit: LocalProcessExit = { exitCode: 0 }, holdOutput = false) => {
            if (completed) return;
            completed = true;
            leaderExited = true;
            if (!holdOutput) Queue.endUnsafe(output);
            Deferred.doneUnsafe(exited, Effect.succeed(exit));
          };
          const handle: LocalProcessHandle = {
            pid: 10_000 + controls.length,
            output: Stream.fromQueue(output),
            awaitExit: Deferred.await(exited),
            leaderExited: Effect.sync(() => leaderExited),
            droppedOutputBytes: () => droppedBytes,
            abandonOutput: Effect.sync(() => {
              droppedBytes += undeliveredBytes;
              undeliveredBytes = 0;
              Queue.endUnsafe(output);
            }),
            terminate: (mode) =>
              Effect.suspend(() => {
                modes.push(mode);
                Deferred.doneUnsafe(modeRequested[mode], Effect.void);
                if (options.failTermination)
                  return Effect.fail(
                    new LocalProcessError({
                      operation: "terminate process tree",
                      reason: "terminate",
                      message: "Fixture termination failed.",
                    }),
                  );
                if (
                  (mode === "force" && options.completeOnForce !== false) ||
                  (mode === "graceful" && options.completeOnGraceful !== false)
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
            command: request.command,
            modes,
            awaitMode: (mode) => Deferred.await(modeRequested[mode]),
            offer: (stream, text, gapBytes = 0) =>
              void Queue.offerUnsafe(output, { stream, text, droppedBytes: gapBytes }),
            exitLeader: () => {
              leaderExited = true;
            },
            complete,
            queueUndelivered: (bytes) => {
              undeliveredBytes += bytes;
            },
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
  const run = <A, Eff extends Effect.Effect<unknown, unknown, unknown>>(
    test: (service: BackgroundTaskServiceContract) => Generator<Eff, A, unknown>,
  ) =>
    Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      return yield* test(service);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  return { ...fake, layer, run };
}

const realServiceLayer = (overrides: Partial<BackgroundTaskConfig> = {}) =>
  BackgroundTaskService.layer().pipe(
    Layer.provide(
      Layer.mergeAll(
        LocalProcess.layer,
        Layer.succeed(BackgroundTaskConfigStore, normalizeConfig(overrides)),
        Path.layer,
      ),
    ),
  );

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

/** A clock that never answers the first time read after `stallNextRead`; all else is `base`. */
const stallingClock = (base: Clock.Clock) => {
  let stallNext = false;
  const stalled = Deferred.makeUnsafe<void>();
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
    currentTimeMillis: Effect.suspend(() => {
      if (!stallNext) return base.currentTimeMillis;
      stallNext = false;
      Deferred.doneUnsafe(stalled, Effect.void);
      return Effect.never;
    }),
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
    currentTimeNanos: base.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) => base.sleep(duration),
  };
  return {
    clock,
    stallNextRead: () => {
      stallNext = true;
    },
    stalled: Deferred.await(stalled),
  };
};

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
  it.effect(
    "consumer mutations cannot alter task projections, retained logs or byte accounting",
    () => {
      let latest: BackgroundTaskProjection = { tasks: [] };
      const harness = serviceHarness(
        { logBufferBytesPerTask: 4_096, totalLogBufferBytes: 8_192 },
        (projection) => void (latest = projection),
      );
      return harness.run(function* (service) {
        const started = yield* service.start(taskInput());
        const text = "a".repeat(4_000);
        const first = yield* emitAndRead(service, harness.controls[0], started.id, 0, text);
        const retained = latest;
        const row = retained.tasks[0]!;
        expect(Reflect.set(retained, "tasks", [])).toBe(false);
        expect(Reflect.set(retained.tasks, "length", 0)).toBe(false);
        expect(Reflect.set(row, "state", "failed")).toBe(false);
        expect(Reflect.set(row, "logs", [])).toBe(false);
        expect(Reflect.set(row.logs, "length", 0)).toBe(false);
        expect(Reflect.set(row.logs[0]!, "bytes", 0)).toBe(false);
        expect(Reflect.set(row.logs[0]!, "text", "corrupted")).toBe(false);
        expect(Reflect.set(first.events[0]!, "bytes", 0)).toBe(false);
        expect((yield* service.status(started.id)).state).toBe("running");
        expect((yield* service.logs({ id: started.id, afterCursor: 0 })).events[0]?.text).toBe(
          text,
        );

        const replacement = "🙂".repeat(1_000);
        const second = yield* emitAndRead(
          service,
          harness.controls[0],
          started.id,
          first.nextCursor,
          replacement,
        );
        expect(second).toMatchObject({
          droppedBytes: 4_000,
          earliestAvailableCursor: 1,
          events: [{ cursor: 2, text: replacement, bytes: 4_000 }],
        });
        yield* service.stop(started.id);
        expect(latest.tasks[0]).toMatchObject({ state: "stopped", droppedLogBytes: 4_000 });
        expect(latest.tasks[0]?.logs.map((event) => event.text)).toEqual([replacement]);
        expect(retained.tasks[0]).toMatchObject({ state: "running", droppedLogBytes: 0 });
        expect(row.logs.map((event) => event.text)).toEqual([text]);
        expect(first).toMatchObject({ droppedBytes: 0, nextCursor: 1 });
      });
    },
  );

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

  it.effect("bounds an output wait by elapsed time when the wall clock steps backward", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      yield* TestClock.adjust("1 hour");
      const started = yield* service.start(taskInput());
      const waiting = yield* service.wait(outputWait(started.id, { waitSeconds: 5 })).pipe(forkNow);
      yield* TestClock.setTime(0);
      yield* emitAndRead(service, harness.controls[0], started.id, 0, "booting\n");
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(waiting)).toMatchObject({ outcome: "timeout" });
    });
  });

  it.effect(
    "admits normalized start metadata at the bounds and rejects overflow before spawn",
    () => {
      const harness = serviceHarness();
      const cwdAtLimit = `/${"d".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxCwdChars - 1)}`;
      // Commands keep their whitespace, which counts toward the UTF-8 bound; names are trimmed.
      const commandAtLimit = ` ${"c".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxCommandBytes - 2)} `;
      const wideOverLimit = "é".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxCommandBytes / 2 + 1);
      return harness.run(function* (service) {
        const started = yield* service.start({
          command: commandAtLimit,
          cwd: cwdAtLimit,
          name: ` ${"n".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars)} `,
        });
        expect(started).toMatchObject({
          id: "task-1",
          cwd: cwdAtLimit,
          name: "n".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars),
        });
        // The process runs the whole command; the snapshot keeps a bounded display copy.
        expect(harness.controls.map((control) => control.command)).toEqual([commandAtLimit]);
        expect(started.command.length).toBeLessThanOrEqual(
          BACKGROUND_TASK_FIELD_BOUNDS.maxCommandDisplayChars,
        );
        expect(commandAtLimit.startsWith(started.command.slice(0, -1))).toBe(true);

        for (const command of [`${commandAtLimit} `, wideOverLimit, " \n\t "])
          expect(yield* service.start({ command, cwd: "." }).pipe(Effect.flip)).toBeInstanceOf(
            InvalidBackgroundCommandError,
          );
        expect(
          yield* service
            .start({
              command: "valid",
              cwd: ".",
              name: ` ${"n".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars + 1)} `,
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(InvalidBackgroundCommandError);
        expect(
          yield* service.start({ command: "valid", cwd: `${cwdAtLimit}d` }).pipe(Effect.flip),
        ).toBeInstanceOf(InvalidBackgroundCwdError);
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

  it.effect("matches colored output split across writes as readers see it", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const control = harness.controls[0];
      if (!control) throw new Error("started process was not captured");
      const waiting = yield* service
        .wait(outputWait(started.id, { contains: "ready in 312 ms" }))
        .pipe(forkNow);
      control.offer("stdout", "  \u001b[32mVITE\u001b[39m v5.0.0  \u001b[32mready in\u001b");
      yield* Effect.yieldNow;
      control.offer("stdout", "[39m \u001b[1m312\u001b[22m ms\n");
      expect(yield* Fiber.join(waiting)).toMatchObject({ outcome: "matched", matchCursor: 2 });
      expect(
        yield* service.wait(outputWait(started.id, { contains: "VITE v5.0.0", afterCursor: 0 })),
      ).toMatchObject({ outcome: "matched", matchCursor: 1 });
      const logs = yield* service.logs({ id: started.id, afterCursor: 0 });
      expect(combinedLogOutput(logs.events)).toBe("  VITE v5.0.0  ready in 312 ms\n");
      yield* service.stop(started.id);
    });
  });

  it.effect("keeps a sequence left open on one stream from erasing the other stream", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const control = harness.controls[0];
      if (!control) throw new Error("started process was not captured");
      control.offer("stdout", "\u001b]0;title");
      control.offer("stderr", "IMPORTANT ERROR\n");
      control.offer("stdout", "\u0007ready\n");
      control.offer("stderr", "\u001b]8;;https://x.example/");
      control.offer("stdout", "later\n");
      yield* service.wait(outputWait(started.id, { contains: "later", afterCursor: 0 }));
      const logs = yield* service.logs({ id: started.id, afterCursor: 0 });
      expect(combinedLogOutput(logs.events)).toBe("[stderr] IMPORTANT ERROR\nready\nlater\n");
      yield* service.stop(started.id);
    });
  });

  it.effect("rejects a cursor ahead of the task's output, naming the latest cursor", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      yield* emitAndRead(service, harness.controls[0], started.id, 0, "one\n");
      for (const failure of [
        yield* service.logs({ id: started.id, afterCursor: 5 }).pipe(Effect.flip),
        yield* service.wait(outputWait(started.id, { afterCursor: 5 })).pipe(Effect.flip),
      ]) {
        expect(failure).toBeInstanceOf(InvalidBackgroundCommandError);
        // A short headline; the task and the latest usable cursor follow as detail.
        const [headline = "", ...detail] = failure.message.split("\n");
        expect(issueMessageStyleProblems(headline, { forbidden: [started.id, "5"] })).toEqual([]);
        expect(detail.join("\n")).toContain(started.id);
        expect(detail.join("\n")).toMatch(/\b1\b/u);
      }
      expect(yield* service.logs({ id: started.id, afterCursor: 1 })).toMatchObject({
        events: [],
        nextCursor: 1,
      });
      yield* service.stop(started.id);
    });
  });

  it.effect("lets one task keep its whole per-task budget when it equals the total", () => {
    const harness = serviceHarness({ logBufferBytesPerTask: 8_192, totalLogBufferBytes: 8_192 });
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const first = yield* emitAndRead(
        service,
        harness.controls[0],
        started.id,
        0,
        "a".repeat(4_000),
      );
      const second = yield* emitAndRead(
        service,
        harness.controls[0],
        started.id,
        first.nextCursor,
        "b".repeat(4_000),
      );
      expect(second.droppedBytes).toBe(0);
      expect((yield* service.logs({ id: started.id, afterCursor: 0 })).events).toHaveLength(2);
      yield* service.stop(started.id);
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
      const exited = yield* Fiber.join(waiting);
      expect(exited).toMatchObject({ outcome: "completed" });
      const failed: BackgroundTaskStatus = exited.snapshot;
      expect(failed).toMatchObject({ state: "failed", exitCode: 1 });
      const line = failed.failureCause ?? "";
      expect(line).toMatch(/^FAIL tests\/auth\.test\.ts/u);
      expect(line).not.toContain("hunter2secret");
      expect(line.length).toBeLessThanOrEqual(OUTPUT_FAILURE_LINE_LIMIT);

      const clean = yield* service.start(taskInput({ command: "check" }));
      yield* emitAndRead(service, harness.controls[1], clean.id, 0, "error handling tests ok\n");
      const exiting = yield* service.wait(exitWait(clean.id)).pipe(forkNow);
      harness.controls[1]?.complete({ exitCode: 0 });
      expect((yield* Fiber.join(exiting)).snapshot).not.toHaveProperty("failureCause");
    });
  });

  it.effect("times waits out as normal results, capped at maxWaitSeconds, without stopping", () => {
    const harness = serviceHarness({ maxWaitSeconds: 10 });
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const capped = yield* service.wait(exitWait(started.id, 90)).pipe(forkNow);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(capped)).toMatchObject({
        outcome: "timeout",
        appliedWaitSeconds: 10,
        snapshot: { state: "running" },
      });

      const shorter = yield* service.wait(outputWait(started.id, { waitSeconds: 4 })).pipe(forkNow);
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(shorter)).toMatchObject({
        outcome: "timeout",
        appliedWaitSeconds: 4,
      });
      expect((yield* service.status(started.id)).state).toBe("running");
      yield* service.stop(started.id);
    });
  });

  it.effect("reports a stop of a task that already finished as stopping nothing", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const finished = yield* service.start(taskInput());
      harness.controls[0]?.complete({ exitCode: 0 });
      yield* service.wait(exitWait(finished.id));
      const running = yield* service.start(taskInput({ command: "second" }));

      expect(yield* service.stop(finished.id)).toMatchObject({
        alreadyFinished: true,
        snapshot: { state: "exited", exitCode: 0 },
      });
      expect(harness.controls[0]?.modes).toEqual([]);
      expect(yield* service.stop(running.id)).toMatchObject({
        alreadyFinished: false,
        snapshot: { state: "stopped" },
      });
      expect(yield* service.stopAll()).toEqual([]);
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
      expect(settled.map((result) => result.snapshot.state)).toEqual(["stopped", "stopped"]);
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
      expect((yield* Fiber.join(stopping)).snapshot.state).toBe("stopped");
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
      expect((yield* service.stop(started.id)).snapshot.state).toBe("stopped");
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
      expect(failure).toBeInstanceOf(BackgroundTerminationError);
      expect(failure).toMatchObject({ id: started.id });
      expect(yield* service.status(started.id)).toMatchObject({ state: "stopping" });
      expect((yield* service.list("active")).map((task) => task.id)).toEqual([started.id]);
      expect(
        yield* service.start(taskInput({ command: "second" })).pipe(Effect.flip),
      ).toBeInstanceOf(BackgroundTaskCapacityError);

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
      expect(failure).toBeInstanceOf(BackgroundTerminationError);
      expect(failure).toMatchObject({ id: started.id, message: "Fixture termination failed." });
      expect(yield* service.status(started.id)).toMatchObject({ state: "stopping" });
      harness.controls[0]?.complete({ exitCode: null, signal: "SIGTERM" });
      yield* Effect.yieldNow;
      expect(yield* service.status(started.id)).toMatchObject({ state: "stopped" });
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

  it.effect("terminates a late handle while retaining stopping ownership until exit", () => {
    const spawnGate = Deferred.makeUnsafe<void>();
    const harness = serviceHarness({}, () => {}, { spawnGate });
    return harness.run(function* (service) {
      const starting = yield* service.start(taskInput()).pipe(forkNow);
      yield* Effect.yieldNow;
      const stopping = yield* service.stop("task-1").pipe(forkNow);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const failure = yield* Fiber.join(stopping).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(BackgroundTerminationError);
      expect(failure).toMatchObject({ id: "task-1" });
      expect((yield* service.status("task-1")).state).toBe("stopping");
      yield* Deferred.succeed(spawnGate, undefined);
      yield* Deferred.await(harness.spawned);
      yield* Effect.yieldNow;
      expect((yield* service.status("task-1")).state).toBe("stopped");
      expect(harness.controls[0]?.modes).toContain("force");
      yield* Fiber.await(starting);
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

      harness.controls[0]?.complete();
      harness.controls[1]?.complete();
      expect(yield* service.wait(exitWait(second.id))).toMatchObject({
        outcome: "completed",
        snapshot: { state: "exited" },
      });
      const missing = yield* service.status(first.id).pipe(Effect.flip);
      expect(missing).toBeInstanceOf(BackgroundTaskNotFoundError);
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

  it.live("fails a start the process boundary refuses synchronously and frees its slot", () => {
    const layer = realServiceLayer({ maxRunning: 1 });
    const refusedStart = (service: BackgroundTaskServiceContract) =>
      service
        .start(taskInput({ command: "echo \u0000" }))
        .pipe(Effect.timeout("2 seconds"), Effect.flip);
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      expect(yield* refusedStart(service)).toBeInstanceOf(BackgroundSpawnError);
      const [failed] = yield* service.list();
      expect(failed?.state).toBe("failed");
      expect(failed?.error).toBeTypeOf("string");
      expect(failed?.endedAt).toBeDefined();
      expect(yield* refusedStart(service)).toBeInstanceOf(BackgroundSpawnError);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.live("runs a command exactly as submitted, including whitespace that is shell syntax", () => {
    // The escaped trailing space makes the argument `trailing `.
    const command = "printf '<%s>\\n' 'trailing'\\ ";
    return Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      const started = yield* service.start({ command, cwd: "." });
      expect(started.command).toBe(command);
      expect((yield* service.wait(exitWait(started.id, 10))).snapshot).toMatchObject({
        state: "exited",
        exitCode: 0,
      });
      const logs = yield* service.logs({ id: started.id, afterCursor: 0 });
      expect(combinedLogOutput(logs.events)).toBe("<trailing >\n");
    }).pipe(Effect.scoped, provideBuiltLayer(realServiceLayer()));
  });

  it.effect("keeps a command's own exit when a stop or timeout lands after it", () => {
    const harness = serviceHarness({ stopGraceMs: 2_000 }, () => {}, {
      completeOnGraceful: false,
      completeOnForce: false,
    });
    return harness.run(function* (service) {
      const stopped = yield* service.start(taskInput());
      const timed = yield* service.start(taskInput({ timeoutSeconds: 10 }));
      const [stopControl, timeoutControl] = harness.controls;
      if (!stopControl || !timeoutControl) throw new Error("started processes were not captured");

      stopControl.exitLeader();
      const stopping = yield* service.stop(stopped.id).pipe(forkNow);
      yield* stopControl.awaitMode("graceful");
      stopControl.complete({ exitCode: 0 });
      expect(yield* Fiber.join(stopping)).toMatchObject({
        snapshot: { state: "exited", exitCode: 0 },
        alreadyFinished: false,
      });

      timeoutControl.exitLeader();
      yield* TestClock.adjust("10 seconds");
      yield* timeoutControl.awaitMode("graceful");
      timeoutControl.complete({ exitCode: 0 });
      expect(yield* service.wait(exitWait(timed.id))).toMatchObject({
        snapshot: { state: "exited", exitCode: 0 },
      });
    });
  });

  it.effect("escalates a repeated stop of a stopping task to force", () => {
    const harness = serviceHarness({ stopGraceMs: 2_000 }, () => {}, { completeOnGraceful: false });
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const control = harness.controls[0];
      if (!control) throw new Error("started process was not captured");

      const first = yield* service.stop(started.id).pipe(forkNow);
      yield* control.awaitMode("graceful");
      const repeated = yield* service.stop(started.id).pipe(forkNow);
      yield* control.awaitMode("force");
      const settled = yield* Effect.all([Fiber.join(first), Fiber.join(repeated)]);
      expect(settled.map((result) => result.snapshot.state)).toEqual(["stopped", "stopped"]);
    });
  });

  it.effect("lets a runtime timeout join a stop's grace window instead of forcing it", () => {
    const harness = serviceHarness({ stopGraceMs: 2_000 }, () => {}, { completeOnGraceful: false });
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput({ timeoutSeconds: 1 }));
      const control = harness.controls[0];
      if (!control) throw new Error("started process was not captured");
      const stopping = yield* service.stop(started.id).pipe(forkNow);
      yield* control.awaitMode("graceful");
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      expect(control.modes).toEqual(["graceful"]);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(stopping)).toMatchObject({ snapshot: { state: "stopped" } });
      expect(control.modes).toEqual(["graceful", "force"]);
    });
  });

  it.effect("lets session shutdown join a stop's grace window instead of forcing it", () => {
    const harness = serviceHarness({ stopGraceMs: 2_000 }, () => {}, { completeOnGraceful: false });
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(harness.layer, scope);
      const service = Context.get(context, BackgroundTaskService);
      const started = yield* service.start(taskInput());
      const control = harness.controls[0];
      if (!control) throw new Error("started process was not captured");
      const stopping = yield* service.stop(started.id).pipe(forkNow);
      yield* control.awaitMode("graceful");
      const closing = yield* Scope.close(scope, Exit.void).pipe(forkNow);
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      expect(control.modes).toEqual(["graceful"]);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(closing);
      expect(control.modes).toEqual(["graceful", "force"]);
      expect(yield* Fiber.join(stopping)).toMatchObject({ snapshot: { state: "stopped" } });
    }).pipe(Effect.scoped);
  });

  it.effect("counts output still queued when held pipes outlive the command as dropped", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const control = harness.controls[0];
      if (!control) throw new Error("started process was not captured");
      yield* emitAndRead(service, control, started.id, 0, "ready\n");
      control.queueUndelivered(64);
      control.complete({ exitCode: 0 }, true);
      const waiting = yield* service.wait(exitWait(started.id)).pipe(forkNow);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(waiting)).toMatchObject({
        outcome: "completed",
        droppedBytes: 64,
        snapshot: { state: "exited", droppedLogBytes: 64 },
      });
    });
  });

  it.effect("counts output an interrupted reader received but never stored as dropped", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const stalling = stallingClock(yield* Clock.Clock);
      const started = yield* service
        .start(taskInput())
        .pipe(Effect.provideService(Clock.Clock, stalling.clock));
      const control = harness.controls[0];
      if (!control) throw new Error("started process was not captured");
      // The reader takes the event, then stalls inside its append until it is interrupted.
      stalling.stallNextRead();
      control.offer("stdout", "lost\n");
      yield* stalling.stalled;
      control.complete({ exitCode: 0 }, true);
      const waiting = yield* service.wait(exitWait(started.id)).pipe(forkNow);

      // The monitor abandons the held output, then interrupts the stalled reader and settles.
      for (let second = 0; second < 10 && waiting.pollUnsafe() === undefined; second += 1)
        yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(waiting)).toMatchObject({
        outcome: "completed",
        droppedBytes: 5,
        snapshot: { state: "exited", droppedLogBytes: 5 },
      });
    });
  });

  it.effect("keeps admission and settlement working when the projection publisher throws", () => {
    const harness = serviceHarness({ maxRunning: 1 }, () => {
      throw new Error("host publisher failed");
    });
    return harness.run(function* (service) {
      const first = yield* service.start(taskInput());
      expect(first.state).toBe("running");
      harness.controls[0]?.complete({ exitCode: 0 });
      expect(yield* service.wait(exitWait(first.id))).toMatchObject({
        snapshot: { state: "exited" },
      });
      const second = yield* service.start(taskInput({ command: "second" }));
      expect((yield* service.stop(second.id)).snapshot.state).toBe("stopped");
      expect(yield* service.list("active")).toEqual([]);
    });
  });

  it.effect("rejects starts while disabled without reporting a closed runtime", () => {
    const harness = serviceHarness({ enabled: false });
    return harness.run(function* (service) {
      const failure = yield* service.start(taskInput()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(BackgroundTasksDisabledError);
      expect(failure).not.toBeInstanceOf(BackgroundRuntimeClosedError);
      expect(harness.controls).toHaveLength(0);
      expect(yield* service.list()).toEqual([]);
    });
  });

  it.effect("logs a warning when shutdown cannot confirm a task exited", () => {
    const captured = makeCapturedLogger();
    const harness = serviceHarness({}, () => {}, { failTermination: true });
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(harness.layer, scope);
      const service = Context.get(context, BackgroundTaskService);
      const started = yield* service.start(taskInput());
      expect(captured.entries).toEqual([]);
      yield* Scope.close(scope, Exit.void);
      expect(harness.controls[0]?.modes).toContain("graceful");
      // The warning carries the termination failure it could not resolve.
      expect(captured.entries.map(String).join("\n")).toContain("Fixture termination failed");
      expect(started.state).toBe("running");
    }).pipe(Effect.provide(captured.layer));
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
