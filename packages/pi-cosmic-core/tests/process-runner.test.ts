import { EventEmitter } from "node:events";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  awaitProcessClose,
  provideNodeProcess,
  type BoundedProcessRequest,
  type ProcessCloseSource,
} from "../index.ts";
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

it.live("preserves a child termination signal", () =>
  Effect.gen(function* () {
    const result = yield* runNode('process.kill(process.pid, "SIGTERM")');
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGTERM");
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

for (const mode of ["denied", "ineffective", "confirmed"] as const) {
  it.effect(`reports ${mode} cancellation cleanup before releasing ownership`, () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let running = true;
      let report: boolean | undefined;
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
      const spawner = ChildProcessSpawner.make(() =>
        Deferred.succeed(started, undefined).pipe(Effect.as(handle)),
      );
      const pending = yield* runBoundedProcessScoped({
        ...fakeRequest,
        onCleanup: (confirmed) => {
          report = confirmed;
        },
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      const interrupted = yield* Fiber.interrupt(pending).pipe(Effect.forkScoped);
      yield* Deferred.await(closing);
      expect(report).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupted);
      expect(report).toBe(mode === "confirmed");
      expect(running).toBe(mode !== "confirmed");
    }),
  );
}

for (const mode of ["timeout", "stream", "partial-spawn", "spawn"] as const) {
  it.effect(`reports uncertain cleanup after ${mode} failure`, () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let report: boolean | undefined;
      let owned = false;
      const handle = fakeHandle(mode === "stream" ? { stdout: Stream.fail(denied) } : {});
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          if (mode === "partial-spawn") {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                owned = true;
              }),
              () => Effect.ignore(Effect.fail(denied)),
            );
            return yield* denied;
          }
          if (mode === "spawn") return yield* denied;
          return handle;
        }),
      );
      const pending = yield* runBoundedProcessScoped({
        ...fakeRequest,
        onCleanup: (confirmed) => {
          report = confirmed;
        },
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.result,
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      if (mode === "timeout") yield* TestClock.adjust(10);
      const result = yield* Fiber.join(pending);
      expect(report).toBe(false);
      if (mode === "timeout")
        expect(result).toMatchObject({
          _tag: "Success",
          success: { timedOut: true, cleanupUnconfirmed: true },
        });
      else expect(result._tag).toBe("Failure");
      expect(owned).toBe(mode === "partial-spawn");
    }),
  );
}

class TestCloseSource extends EventEmitter implements ProcessCloseSource {
  exitCode: number | null = null;
  signalCode: string | null = null;
  override once(event: "close", listener: () => void): this {
    return super.once(event, listener);
  }
  override off(event: "close", listener: () => void): this {
    return super.off(event, listener);
  }
}

it.effect("detaches a Node close listener after confirmation", () =>
  Effect.gen(function* () {
    const child = new TestCloseSource();
    const waiting = yield* awaitProcessClose(child, 1_000).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    child.exitCode = 0;
    child.emit("close");
    expect(yield* Fiber.join(waiting)).toBe(true);
    expect(child.listenerCount("close")).toBe(0);
  }),
);
