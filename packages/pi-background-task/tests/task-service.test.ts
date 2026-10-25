import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
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
import {
  isActiveTaskState,
  type BackgroundTaskNotice,
  type BackgroundTaskStatus,
  type BackgroundTaskState,
  type BackgroundTaskProjection,
  type ReadBackgroundLogs,
  type StartBackgroundTask,
  type WaitForBackgroundTask,
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
import { skippedWithin } from "../src/task/log-buffer.ts";
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
  readonly failSpawn?: boolean;
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
          if (options.failSpawn)
            return yield* LocalProcessError.make({
              operation: "spawn",
              reason: "spawn",
              message: "Fixture spawn failed.",
            });
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
                    LocalProcessError.make({
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
  const notices: BackgroundTaskNotice[] = [];
  const layer = BackgroundTaskService.layer({
    publish: onProjection,
    notify: (notice) => void notices.push(notice),
  }).pipe(Layer.provide(dependencies));
  const run = <A, Eff extends Effect.Effect<unknown, unknown, unknown>>(
    test: (service: BackgroundTaskServiceContract) => Generator<Eff, A, unknown>,
  ) =>
    Effect.gen(function* () {
      const service = yield* BackgroundTaskService;
      return yield* test(service);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  return { ...fake, layer, run, notices };
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
  contains: ["ready"],
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
// A 1,000-byte line of one repeated digit.
const kilobyteLine = (index: number) => `${Fn.pipe(String(index), Str.repeat(999))}\n`;
const TASK_ID = /^task-[0-9a-z]{10}$/u;
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

/** Learns that tasks finished from projections, which never claim a task's notice. */
const finishWatcher = () => {
  const finished = new Map<string, Deferred.Deferred<void>>();
  const entry = (id: string) => {
    const existing = finished.get(id);
    if (existing) return existing;
    const created = Deferred.makeUnsafe<void>();
    finished.set(id, created);
    return created;
  };
  return {
    publish: (projection: BackgroundTaskProjection) => {
      for (const task of projection.tasks)
        if (!isActiveTaskState(task.state)) Deferred.doneUnsafe(entry(task.id), Effect.void);
    },
    finished: (id: string) => Deferred.await(entry(id)),
  };
};

const noticeStates = (notices: ReadonlyArray<BackgroundTaskNotice>) =>
  Arr.map(notices, ({ task }) => [task.id, task.state] as const);

const awaitState = (state: BackgroundTaskState) => {
  const reached = Deferred.makeUnsafe<void>();
  return {
    reached,
    publish: (projection: BackgroundTaskProjection) => {
      if (Arr.some(projection.tasks, (task) => task.state === state)) {
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
        const text = Fn.pipe("a", Str.repeat(4_000));
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

        const replacement = Fn.pipe("🙂", Str.repeat(1_000));
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
        const latestRow = latest.tasks[0];
        expect(latestRow && Arr.map(latestRow.logs, (event) => event.text)).toEqual([replacement]);
        expect(retained.tasks[0]).toMatchObject({ state: "running", droppedLogBytes: 0 });
        expect(Arr.map(row.logs, (event) => event.text)).toEqual([text]);
        expect(first).toMatchObject({ droppedBytes: 0, nextCursor: 1 });
      });
    },
  );

  it.effect("starts, long-polls logs, and publishes process exit", () => {
    const terminal = awaitState("exited");
    const harness = serviceHarness({}, terminal.publish);
    return harness.run(function* (service) {
      const started = yield* service.start({ command: "watch", cwd: ".", name: "watcher" });
      expect(started).toMatchObject({ state: "running", pid: 10_000 });
      expect(started.id).toMatch(TASK_ID);

      const waiting = yield* service.logs({ id: started.id, waitSeconds: 30 }).pipe(forkNow);
      harness.controls[0]?.offer("stdout", "ready\n");
      const logs = yield* Fiber.join(waiting);
      expect(
        Arr.join(
          Arr.map(logs.events, (event) => event.text),
          "",
        ),
      ).toContain("ready");

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
      const cwdAtLimit = `/${Fn.pipe("d", Str.repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxCwdChars - 1))}`;
      // Commands keep their whitespace, which counts toward the UTF-8 bound; names are trimmed.
      const commandAtLimit = ` ${Fn.pipe("c", Str.repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxCommandBytes - 2))} `;
      const wideOverLimit = Fn.pipe(
        "é",
        Str.repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxCommandBytes / 2 + 1),
      );
      return harness.run(function* (service) {
        const started = yield* service.start({
          command: commandAtLimit,
          cwd: cwdAtLimit,
          name: ` ${Fn.pipe("n", Str.repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars))} `,
        });
        expect(started).toMatchObject({
          cwd: cwdAtLimit,
          name: Fn.pipe("n", Str.repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars)),
        });
        // The process runs the whole command; the snapshot keeps a bounded display copy.
        expect(Arr.map(harness.controls, (control) => control.command)).toEqual([commandAtLimit]);
        expect(started.command.length).toBeLessThanOrEqual(
          BACKGROUND_TASK_FIELD_BOUNDS.maxCommandDisplayChars,
        );
        expect(
          Fn.pipe(commandAtLimit, Str.startsWith(Fn.pipe(started.command, Str.slice(0, -1)))),
        ).toBe(true);

        for (const command of [`${commandAtLimit} `, wideOverLimit, " \n\t "])
          expect(yield* service.start({ command, cwd: "." }).pipe(Effect.flip)).toBeInstanceOf(
            InvalidBackgroundCommandError,
          );
        expect(
          yield* service
            .start({
              command: "valid",
              cwd: ".",
              name: ` ${Fn.pipe("n", Str.repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars + 1))} `,
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(InvalidBackgroundCommandError);
        expect(
          yield* service.start({ command: "valid", cwd: `${cwdAtLimit}d` }).pipe(Effect.flip),
        ).toBeInstanceOf(InvalidBackgroundCwdError);
        expect(harness.controls).toHaveLength(1);
        expect(Arr.map(yield* service.list(), (task) => task.id)).toEqual([started.id]);

        // A random token, with no counter a model could increment to predict this ID.
        const next = yield* service.start(taskInput({ command: "next" }));
        for (const task of [started, next]) expect(task.id).toMatch(TASK_ID);
        expect(next.id).not.toBe(started.id);
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
        .wait(outputWait(started.id, { contains: ["ready now"], afterCursor: 0 }))
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
        .wait(outputWait(started.id, { contains: ["ready in 312 ms"] }))
        .pipe(forkNow);
      control.offer("stdout", "  \u001b[32mVITE\u001b[39m v5.0.0  \u001b[32mready in\u001b");
      yield* Effect.yieldNow;
      control.offer("stdout", "[39m \u001b[1m312\u001b[22m ms\n");
      expect(yield* Fiber.join(waiting)).toMatchObject({ outcome: "matched", matchCursor: 2 });
      expect(
        yield* service.wait(outputWait(started.id, { contains: ["VITE v5.0.0"], afterCursor: 0 })),
      ).toMatchObject({ outcome: "matched", matchCursor: 1 });
      const logs = yield* service.logs({ id: started.id, afterCursor: 0 });
      expect(combinedLogOutput(logs.events)).toBe("  VITE v5.0.0  ready in 312 ms\n");
      yield* service.stop(started.id);
    });
  });

  it.effect("stores colored output as plain text and charges budgets only for that text", () => {
    const harness = serviceHarness({ logBufferBytesPerTask: 4_096, totalLogBufferBytes: 4_096 });
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const control = harness.controls[0];
      if (!control) throw new Error("started process was not captured");
      // Five colored 1,000-byte lines, each opening sequence split across writes; three fit.
      for (let index = 1; index <= 5; index += 1) {
        control.offer("stdout", "\u001b[3");
        control.offer("stdout", `${index};1m${Fn.pipe(String(index), Str.repeat(999))}\u001b[0m\n`);
      }
      control.complete();
      yield* service.wait(exitWait(started.id));
      const logs = yield* service.logs({ id: started.id, afterCursor: 0 });
      expect(Arr.map(logs.events, ({ text, bytes }) => ({ text, bytes }))).toEqual(
        Arr.map([3, 4, 5], (index) => ({ text: kilobyteLine(index), bytes: 1_000 })),
      );
      expect(logs).toMatchObject({
        earliestAvailableCursor: 2,
        retainedBytes: 3_000,
        droppedBytes: 2_000,
      });
      expect(skippedWithin(logs)).toEqual({ bytes: 2_000 });
    });
  });

  it.effect("reads carriage-return progress as separate lines, per stream", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const control = harness.controls[0];
      if (!control) throw new Error("started process was not captured");
      const waiting = yield* service
        .wait(outputWait(started.id, { contains: ["Downloading 100%"] }))
        .pipe(forkNow);
      // Each stream's CR ends its own line; the LF that follows in a later write adds no line.
      control.offer("stdout", "Downloading  10%\r");
      control.offer("stderr", "  3/9 files\r");
      control.offer("stdout", "\nDownloading  55%\rDownloading 100%\n");
      control.offer("stderr", "  9/9 files\r");
      control.offer("stderr", "\n");
      control.offer("stdout", "end\n");
      expect(yield* Fiber.join(waiting)).toMatchObject({
        outcome: "matched",
        matchedLine: "Downloading 100%",
      });
      yield* service.wait(outputWait(started.id, { contains: ["end"], afterCursor: 0 }));

      const all = yield* service.logs({ id: started.id, afterCursor: 0 });
      expect(combinedLogOutput(all.events)).toBe(
        "Downloading  10%\n[stderr]   3/9 files\nDownloading  55%\nDownloading 100%\n[stderr]   9/9 files\nend\n",
      );
      const tail = yield* service.logs({ id: started.id, tailLines: 3 });
      expect(combinedLogOutput(tail.events)).toBe("Downloading 100%\n[stderr]   9/9 files\nend\n");
      const update = yield* service.wait(
        outputWait(started.id, { contains: ["55%"], afterCursor: 0 }),
      );
      expect(update.outcome).toBe("matched");
      expect(update.matchedLine).toMatch(/^Downloading\s+55%$/u);
      // Updates are separate lines, so text never runs from one update into the next.
      const across = outputWait(started.id, { contains: ["10%Downloading"], afterCursor: 0 });
      expect(yield* service.wait({ ...across, waitSeconds: 0 })).toMatchObject({
        outcome: "timeout",
      });
      yield* service.stop(started.id);
    });
  });

  it.effect("reports discarded output only to the reads and waits that asked for it", () => {
    const harness = serviceHarness({ logBufferBytesPerTask: 4_096, totalLogBufferBytes: 4_096 });
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const control = harness.controls[0];
      // Three 1,000-byte lines fit the budget; each later one evicts the oldest.
      let cursor = 0;
      for (let index = 1; index <= 5; index += 1) {
        const read = yield* emitAndRead(service, control, started.id, cursor, kilobyteLine(index));
        // A reader that keeps up misses nothing, however much older output was evicted.
        expect(skippedWithin(read)).toBeUndefined();
        cursor = read.nextCursor;
      }
      const logs = (request: Omit<ReadBackgroundLogs, "id">) =>
        service.logs({ id: started.id, ...request });
      const behind = yield* logs({ afterCursor: 1 });
      expect(behind).toMatchObject({ earliestAvailableCursor: 2, droppedBytes: 2_000 });
      expect(skippedWithin(behind)).toEqual({ bytes: 1_000 });
      expect(skippedWithin(yield* logs({ afterCursor: 0 }))).toEqual({ bytes: 2_000 });
      expect(skippedWithin(yield* logs({ tailLines: 3 }))).toBeUndefined();
      expect(skippedWithin(yield* logs({ tailLines: 4 }))).toEqual({ bytes: 2_000 });
      expect(yield* service.status(started.id)).toMatchObject({ droppedLogBytes: 2_000 });

      const exit = yield* service.wait(exitWait(started.id, 0));
      const absent = (overrides: Partial<WaitForBackgroundTask> = {}) =>
        service.wait({
          ...outputWait(started.id, { contains: ["absent"] }),
          waitSeconds: 0,
          ...overrides,
        });
      const retained = yield* absent();
      for (const wait of [exit, retained]) {
        expect(wait).toMatchObject({ outcome: "timeout", droppedBytes: 2_000 });
        expect(wait.skipped).toBeUndefined();
      }
      expect(yield* absent({ afterCursor: 1 })).toMatchObject({
        outcome: "timeout",
        skipped: { bytes: 1_000 },
      });

      // Output lost on its way to the buffer is skipped by a read from before it, and by the
      // newest line, which may have started in the lost output.
      control?.offer("stdout", "after the gap\n", 64);
      yield* service.wait(outputWait(started.id, { contains: ["after the gap"] }));
      expect(skippedWithin(yield* logs({ afterCursor: cursor }))).toEqual({ bytes: 64 });
      expect(skippedWithin(yield* logs({ tailLines: 1 }))).toEqual({ bytes: 64 });

      // Once eviction reaches the gap, it lies before the retained output: a wait without a
      // cursor scans only that output, while a read from the earliest cursor asked for the gap.
      for (let index = 6; index <= 8; index += 1)
        cursor = (yield* emitAndRead(service, control, started.id, cursor, kilobyteLine(index)))
          .nextCursor;
      const earliest = (yield* logs({ afterCursor: cursor })).earliestAvailableCursor;
      expect((yield* logs({ afterCursor: earliest })).events[0]?.droppedBefore).toBe(64);
      expect((yield* absent()).skipped).toBeUndefined();
      expect((yield* absent({ afterCursor: earliest })).skipped).toEqual({ bytes: 64 });
      expect(skippedWithin(yield* logs({ afterCursor: earliest }))).toEqual({ bytes: 64 });
      yield* service.stop(started.id);
    });
  });

  it.effect("reports a gap once along a chain of waits and reads, past a match", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const control = harness.controls[0];
      control?.offer("stdout", "ready\n");
      control?.offer("stdout", "later\n", 64);
      yield* service.wait(outputWait(started.id, { contains: ["later"] }));
      // The match is in the first event, but the result moves past the gap after it.
      const matched = yield* service.wait(outputWait(started.id, { afterCursor: 0 }));
      expect(matched).toMatchObject({
        outcome: "matched",
        matchCursor: 1,
        nextCursor: 2,
        skipped: { bytes: 64 },
      });
      const next = outputWait(started.id, {
        contains: ["absent"],
        afterCursor: matched.nextCursor,
      });
      expect((yield* service.wait({ ...next, waitSeconds: 0 })).skipped).toBeUndefined();
      const read = yield* service.logs({ id: started.id, afterCursor: matched.nextCursor });
      expect(skippedWithin(read)).toBeUndefined();
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
      yield* service.wait(outputWait(started.id, { contains: ["later"], afterCursor: 0 }));
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
        const [headline, ...detail] = Str.split(failure.message, "\n");
        expect(issueMessageStyleProblems(headline, { forbidden: [started.id, "5"] })).toEqual([]);
        expect(Arr.join(detail, "\n")).toContain(started.id);
        expect(Arr.join(detail, "\n")).toMatch(/\b1\b/u);
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
        Fn.pipe("a", Str.repeat(4_000)),
      );
      const second = yield* emitAndRead(
        service,
        harness.controls[0],
        started.id,
        first.nextCursor,
        Fn.pipe("b", Str.repeat(4_000)),
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
        `FAIL tests/auth.test.ts token=hunter2secret ${Fn.pipe("x", Str.repeat(200))}\nnpm ERR! code 1\n`,
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
      expect(Arr.map(settled, (result) => result.snapshot.state)).toEqual(["stopped", "stopped"]);
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
      expect(Arr.map(yield* service.list("active"), (task) => task.id)).toEqual([started.id]);
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
      expect(Arr.map(yield* service.stopAll(), (task) => task.state)).toEqual(["stopped"]);
      expect(harness.controls[0]?.modes).toContain("graceful");
    });
  });

  it.effect("terminates a late handle while retaining stopping ownership until exit", () => {
    const spawnGate = Deferred.makeUnsafe<void>();
    const harness = serviceHarness({}, () => {}, { spawnGate });
    return harness.run(function* (service) {
      const starting = yield* service.start(taskInput()).pipe(forkNow);
      yield* Effect.yieldNow;
      const [admitted] = yield* service.list();
      const id = admitted!.id;
      const stopping = yield* service.stop(id).pipe(forkNow);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const failure = yield* Fiber.join(stopping).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(BackgroundTerminationError);
      expect(failure).toMatchObject({ id });
      expect((yield* service.status(id)).state).toBe("stopping");
      yield* Deferred.succeed(spawnGate, undefined);
      yield* Deferred.await(harness.spawned);
      yield* Effect.yieldNow;
      expect((yield* service.status(id)).state).toBe("stopped");
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
      const [headline] = Str.split(missing.message, "\n");
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
      expect(Arr.map(settled, (result) => result.snapshot.state)).toEqual(["stopped", "stopped"]);
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
        snapshot: { state: "exited", droppedLogBytes: 64, logCursor: 2 },
      });
      // The output lost at the end has a cursor of its own: the read that reaches it reports the
      // loss, and a read from its cursor does not report it again.
      const last = yield* service.logs({ id: started.id, afterCursor: 1 });
      expect(last).toMatchObject({ nextCursor: 2, events: [{ cursor: 2, text: "" }] });
      expect(skippedWithin(last)).toEqual({ bytes: 64 });
      const after = yield* service.logs({ id: started.id, afterCursor: last.nextCursor });
      expect(skippedWithin(after)).toBeUndefined();
      const tail = yield* service.logs({ id: started.id, tailLines: 1 });
      expect(combinedLogOutput(tail.events)).toBe("ready\n");
      expect(skippedWithin(tail)).toEqual({ bytes: 64 });
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
      expect(Arr.join(Arr.map(captured.entries, String), "\n")).toContain(
        "Fixture termination failed",
      );
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

describe("BackgroundTaskService exit notices", () => {
  it.effect("notifies on every finish for exit and only on failures for failure", () => {
    const watcher = finishWatcher();
    const harness = serviceHarness({}, watcher.publish);
    return harness.run(function* (service) {
      const cases = [
        { notify: "exit", exit: { exitCode: 0 }, notified: true },
        { notify: "exit", exit: { exitCode: 1 }, notified: true },
        { notify: "failure", exit: { exitCode: 0 }, notified: false },
        { notify: "failure", exit: { exitCode: 2 }, notified: true },
        { notify: "failure", exit: { exitCode: null, signal: "SIGKILL" }, notified: true },
        { notify: undefined, exit: { exitCode: 1 }, notified: false },
      ] as const;
      const expected: Array<readonly [string, BackgroundTaskState]> = [];
      for (const [index, { notify, exit, notified }] of cases.entries()) {
        const started = yield* service.start(taskInput(notify ? { notify } : {}));
        harness.controls[index]?.offer("stdout", `output of ${index}\n`);
        yield* Effect.yieldNow;
        harness.controls[index]?.complete(exit);
        yield* watcher.finished(started.id);
        if (notified) expected.push([started.id, exit.exitCode === 0 ? "exited" : "failed"]);
      }
      expect(noticeStates(harness.notices)).toEqual(expected);
      const [first] = harness.notices;
      expect(Arr.map(first?.recent.events ?? [], (event) => event.text)).toEqual(["output of 0\n"]);
    });
  });

  it.effect("notifies a failure filter when a runtime timeout stops the task", () => {
    const watcher = finishWatcher();
    const harness = serviceHarness({}, watcher.publish);
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput({ notify: "failure", timeoutSeconds: 10 }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      yield* watcher.finished(started.id);
      expect(noticeStates(harness.notices)).toEqual([[started.id, "timed_out"]]);
    });
  });

  it.effect("sends no notice when a read in progress reports the finish", () => {
    const watcher = finishWatcher();
    const harness = serviceHarness({}, watcher.publish);
    return harness.run(function* (service) {
      const waited = yield* service.start(taskInput({ notify: "exit" }));
      const waiting = yield* service.wait(exitWait(waited.id)).pipe(forkNow);
      harness.controls[0]?.complete();
      expect(yield* Fiber.join(waiting)).toMatchObject({ outcome: "completed" });

      const read = yield* service.start(taskInput({ notify: "exit" }));
      const reading = yield* service.logs({ id: read.id, waitSeconds: 30 }).pipe(forkNow);
      harness.controls[1]?.complete({ exitCode: 1 });
      expect(yield* Fiber.join(reading)).toMatchObject({ state: "failed" });

      // A wait that returned while the task still ran told the agent nothing about its finish.
      const matched = yield* service.start(taskInput({ notify: "exit" }));
      harness.controls[2]?.offer("stdout", "ready\n");
      expect(yield* service.wait(outputWait(matched.id))).toMatchObject({ outcome: "matched" });
      harness.controls[2]?.complete();
      yield* watcher.finished(matched.id);

      expect(noticeStates(harness.notices)).toEqual([[matched.id, "exited"]]);
    });
  });

  it.effect("sends no notice for the agent's own stops, unlike a stop from the user", () => {
    const watcher = finishWatcher();
    const harness = serviceHarness({}, watcher.publish);
    return harness.run(function* (service) {
      const agentStopped = yield* service.start(taskInput({ notify: "exit" }));
      yield* service.stop(agentStopped.id, false, "agent");
      const userStopped = yield* service.start(taskInput({ notify: "exit" }));
      yield* service.stop(userStopped.id);
      yield* service.start(taskInput({ notify: "exit" }));
      yield* service.start(taskInput({ notify: "exit" }));
      expect(yield* service.stopAll(false, "agent")).toHaveLength(2);
      expect(noticeStates(harness.notices)).toEqual([[userStopped.id, "stopped"]]);
    });
  });

  it.effect("sends no notice for tasks the runtime stops while it shuts down", () => {
    const harness = serviceHarness();
    return Effect.gen(function* () {
      yield* harness.run(function* (service) {
        yield* service.start(taskInput({ notify: "exit" }));
        yield* service.start(taskInput({ notify: "failure", timeoutSeconds: 60 }));
      });
      expect(Arr.map(harness.controls, (control) => control.modes)).toEqual([
        ["graceful"],
        ["graceful"],
      ]);
      expect(harness.notices).toEqual([]);
    });
  });

  it.effect(
    "sends a deferred notice once a read in progress ends without reporting the finish",
    () => {
      // The read is cancelled in the same registry transition that finishes the task, so it never
      // inspects the finished task, as a cancelled tool call or an earlier return would not.
      let reading: Fiber.Fiber<unknown, unknown> | undefined;
      const harness = serviceHarness({}, (projection) => {
        if (Arr.some(projection.tasks, (task) => !isActiveTaskState(task.state)))
          reading?.interruptUnsafe();
      });
      return harness.run(function* (service) {
        const started = yield* service.start(taskInput({ notify: "exit" }));
        const read = yield* service.logs({ id: started.id, waitSeconds: 30 }).pipe(forkNow);
        reading = read;
        yield* Effect.yieldNow;
        harness.controls[0]?.complete({ exitCode: 1 });
        const exit = yield* Fiber.await(read);
        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(noticeStates(harness.notices)).toEqual([[started.id, "failed"]]);
        expect(harness.notices[0]?.retained).toBe(true);
      });
    },
  );

  it.effect("sends no failure notice for a stop from the user", () => {
    const watcher = finishWatcher();
    const harness = serviceHarness({}, watcher.publish);
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput({ notify: "failure" }));
      expect((yield* service.stop(started.id)).snapshot.state).toBe("stopped");
      yield* watcher.finished(started.id);
      expect(harness.notices).toEqual([]);
    });
  });

  it.effect("sends no notice for a start that reported its spawn failure", () => {
    const harness = serviceHarness({}, () => {}, { failSpawn: true });
    return harness.run(function* (service) {
      for (const notify of ["exit", "failure"] as const)
        expect(yield* service.start(taskInput({ notify })).pipe(Effect.flip)).toBeInstanceOf(
          BackgroundSpawnError,
        );
      expect(Arr.map(yield* service.list(), (task) => task.state)).toEqual(["failed", "failed"]);
      expect(harness.notices).toEqual([]);
    });
  });

  it.effect("says whether the finished task is still listed when its notice is sent", () => {
    const watcher = finishWatcher();
    const harness = serviceHarness({ maxRetained: 1 }, watcher.publish);
    return harness.run(function* (service) {
      const kept = yield* service.start(taskInput({ notify: "exit" }));
      harness.controls[0]?.complete();
      yield* watcher.finished(kept.id);
      // Both finish at the same test-clock time, so retention trims the earlier-started task as
      // it finishes, before its notice is sent.
      const trimmed = yield* service.start(taskInput({ notify: "exit" }));
      const later = yield* service.start(taskInput());
      harness.controls[2]?.complete();
      yield* watcher.finished(later.id);
      harness.controls[1]?.complete();
      // A trimmed task never appears finished in a projection; its notice shows it finished.
      while (harness.notices.length < 2) yield* Effect.yieldNow;
      expect(
        Arr.map(harness.notices, (notice) => [notice.task.id, notice.retained] as const),
      ).toEqual([
        [kept.id, true],
        [trimmed.id, false],
      ]);
      expect(Arr.map(yield* service.list(), (task) => task.id)).toEqual([later.id]);
    });
  });
});

describe("BackgroundTaskService wait results", () => {
  it.effect("matches whichever alternative appears first and reports its line", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const waiting = yield* service
        .wait(outputWait(started.id, { contains: ["error", "ready in"] }))
        .pipe(forkNow);
      harness.controls[0]?.offer("stdout", "  VITE ready");
      yield* Effect.yieldNow;
      harness.controls[0]?.offer("stdout", " in 312 ms\nnext line\n");
      const result = yield* Fiber.join(waiting);
      expect(result).toMatchObject({
        outcome: "matched",
        matchCursor: 2,
        matchedText: "ready in",
        matchedLine: "VITE ready in 312 ms",
      });
      expect(combinedLogOutput(result.recent.events)).toBe("  VITE ready in 312 ms\nnext line\n");
      yield* service.stop(started.id);
    });
  });

  it.effect("keeps a long matched line bounded with the match in view", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const line = `${Fn.pipe("x", Str.repeat(2_000))} ready ${Fn.pipe("y", Str.repeat(2_000))}\n`;
      harness.controls[0]?.offer("stdout", line);
      const result = yield* service.wait(outputWait(started.id));
      expect(result.matchedLine).toContain(" ready ");
      expect(result.matchedLine?.length).toBeLessThanOrEqual(
        BACKGROUND_TASK_FIELD_BOUNDS.maxMatchedLineChars,
      );
      yield* service.stop(started.id);
    });
  });

  it.effect("marks a matched line whose start came before the output it scanned", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const control = harness.controls[0];
      const matchedAfter = (afterCursor: number, contains: string) =>
        service.wait(outputWait(started.id, { contains: [contains], afterCursor }));
      control?.offer("stdout", "Compiling... ");
      yield* matchedAfter(0, "Compiling");
      control?.offer("stdout", "done, ready\n");
      expect((yield* matchedAfter(1, "ready")).matchedLine).toBe("…done, ready");
      expect((yield* matchedAfter(0, "ready")).matchedLine).toBe("Compiling... done, ready");
      control?.offer("stdout", "ready again\n");
      expect((yield* matchedAfter(2, "again")).matchedLine).toBe("ready again");
      yield* service.stop(started.id);
    });
  });

  it.effect("returns at once with the recent output when the task exits without a match", () => {
    const harness = serviceHarness();
    return harness.run(function* (service) {
      const started = yield* service.start(taskInput());
      const waiting = yield* service
        .wait(outputWait(started.id, { contains: ["ready", "listening"] }))
        .pipe(forkNow);
      harness.controls[0]?.offer("stderr", "Error: port in use\n");
      yield* Effect.yieldNow;
      harness.controls[0]?.complete({ exitCode: 1 });
      const result = yield* Fiber.join(waiting);
      expect(result).toMatchObject({ outcome: "completed", snapshot: { state: "failed" } });
      expect(result.matchCursor).toBeUndefined();
      expect(combinedLogOutput(result.recent.events)).toBe("[stderr] Error: port in use\n");
    });
  });
});
