import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vitest";
import { provideNodeProcess, type BoundedProcessRequest } from "../index.ts";
import { runBoundedProcessScoped } from "../src/platform/process.ts";

const runNode = (script: string, overrides: Partial<BoundedProcessRequest> = {}) =>
  runBoundedProcessScoped({
    executable: process.execPath,
    args: ["-e", script],
    environment: process.env,
    stdoutLimitBytes: 64,
    stderrLimitBytes: 64,
    timeoutMillis: 2_000,
    ...overrides,
  }).pipe(provideNodeProcess);

it.live("runs a bounded one-shot process", () =>
  Effect.gen(function* () {
    expect(yield* runNode('process.stdout.write("ready")')).toMatchObject({
      code: 0,
      stdout: "ready",
      overflowed: false,
      timedOut: false,
      cleanupUnconfirmed: false,
    });
  }),
);

it.live("terminates a process when bounded output overflows", () =>
  Effect.gen(function* () {
    const result = yield* runNode('process.stdout.write("0123456789")', { stdoutLimitBytes: 4 });
    expect(result.overflowed).toBe(true);
    expect(result.stdout).toBe("0123");
    expect(result.cleanupUnconfirmed).toBe(false);
  }),
);

for (const signal of ["SIGTERM", "SIGKILL"] as const)
  it.live(`reports a process killed by ${signal} with that signal and no code`, () =>
    Effect.gen(function* () {
      const result = yield* runNode(`process.kill(process.pid, "${signal}")`);
      expect(result).toMatchObject({ code: null, signal, timedOut: false, overflowed: false });
    }),
  );

it.live("terminates a process at its deadline", () =>
  Effect.gen(function* () {
    const result = yield* runNode("setInterval(() => {}, 1000)", {
      timeoutMillis: 25,
      cleanupTimeoutMillis: 2_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.cleanupUnconfirmed).toBe(false);
  }),
);

it.live("guards a detached process group at host exit until its sweep confirms it gone", () =>
  Effect.gen(function* () {
    // The host-exit guard holds one process `exit` listener exactly while a group is guarded.
    const baseline = process.listenerCount("exit");
    const running = yield* runNode("setTimeout(() => {}, 300)", {
      detached: true,
      sweepProcessTreeOnExit: true,
    }).pipe(Effect.forkChild);
    let guarded = false;
    for (let attempt = 0; attempt < 100 && !guarded; attempt += 1) {
      guarded = process.listenerCount("exit") === baseline + 1;
      if (!guarded) yield* Effect.sleep("5 millis");
    }
    expect(guarded).toBe(true);
    expect((yield* Fiber.join(running)).cleanupUnconfirmed).toBe(false);
    expect(process.listenerCount("exit")).toBe(baseline);
  }),
);

const denied = PlatformError.systemError({
  _tag: "PermissionDenied",
  module: "ChildProcess",
  method: "kill",
});
const fakeHandle = (
  overrides: Partial<Parameters<typeof ChildProcessSpawner.makeHandle>[0]> = {},
) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.fail(denied),
    stdin: Sink.drain,
    stdout: Stream.never,
    stderr: Stream.never,
    all: Stream.never,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
    ...overrides,
  });
const fakeRequest = {
  executable: "unused",
  args: [],
  stdoutLimitBytes: 64,
  stderrLimitBytes: 64,
  timeoutMillis: 10,
  cleanupTimeoutMillis: 100,
};
const runFake = (
  spawn: Parameters<typeof ChildProcessSpawner.make>[0],
  overrides: Partial<BoundedProcessRequest> = {},
) => {
  const reports: boolean[] = [];
  const run = runBoundedProcessScoped({
    ...fakeRequest,
    ...overrides,
    onCleanup: (confirmed) => void reports.push(confirmed),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)),
  );
  return { reports, run };
};

for (const outcome of ["completed", "timeout"] as const) {
  it.effect(
    `retains uncertain cleanup when the ${outcome} leader leaves a live process group`,
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const sweepStarted = yield* Deferred.make<void>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
              expect(pid).toBe(-123);
              if (signal === 0) Deferred.doneUnsafe(sweepStarted, Effect.void);
              return true;
            }),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        let running = outcome === "timeout";
        const handle = fakeHandle({
          exitCode:
            outcome === "completed"
              ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
              : Effect.never,
          stdout: outcome === "completed" ? Stream.empty : Stream.never,
          stderr: outcome === "completed" ? Stream.empty : Stream.never,
          isRunning: Effect.sync(() => running),
          kill: () =>
            Effect.sync(() => {
              running = false;
            }),
        });
        const fake = runFake(() => Deferred.succeed(started, undefined).pipe(Effect.as(handle)), {
          sweepProcessTreeOnExit: true,
        });
        const pending = yield* fake.run.pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        if (outcome === "timeout") yield* TestClock.adjust(10);
        yield* Deferred.await(sweepStarted);
        expect(fake.reports).toEqual([]);
        yield* TestClock.adjust(200);
        const result = yield* Fiber.join(pending);
        expect(result.cleanupUnconfirmed).toBe(true);
        expect(fake.reports).toEqual([false]);
      }),
  );
}

for (const mode of ["denied", "ineffective", "confirmed"] as const) {
  it.effect(`reports ${mode} cancellation cleanup before releasing ownership`, () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let running = true;
      const handle = fakeHandle({
        isRunning: Effect.sync(() => running),
        kill: () =>
          Deferred.succeed(closing, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              mode === "denied"
                ? Effect.fail(denied)
                : Effect.sync(() => {
                    if (mode === "confirmed") running = false;
                  }),
            ),
          ),
      });
      const fake = runFake(() => Deferred.succeed(started, undefined).pipe(Effect.as(handle)));
      const pending = yield* fake.run.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const interrupted = yield* Fiber.interrupt(pending).pipe(Effect.forkScoped);
      yield* Deferred.await(closing);
      expect(fake.reports).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupted);
      expect(fake.reports).toEqual([mode === "confirmed"]);
      expect(running).toBe(mode !== "confirmed");
    }),
  );
}
