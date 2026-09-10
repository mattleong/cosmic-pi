import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { expect, it } from "@effect/vitest";
import { describe, vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  DuplexProcessError,
  openDuplexProcess,
  type DuplexProcessHandle,
  type DuplexProcessOptions,
} from "../index.ts";
import * as NodeBuiltins from "../src/platform/node-builtins.ts";
import {
  closeDuplexProcess,
  type DuplexProcessChild,
} from "../src/platform/duplex-process-close.ts";
import { yieldUntil } from "../testing.ts";

const fixture = fileURLToPath(new URL("./fixtures/duplex-child.mjs", import.meta.url));
const options = (
  mode: string,
  overrides: Partial<DuplexProcessOptions> = {},
): DuplexProcessOptions => ({
  command: process.execPath,
  args: [fixture, mode],
  environment: {},
  gracefulTimeoutMs: 50,
  forceTimeoutMs: 500,
  cleanupTimeoutMs: 1_000,
  pollIntervalMs: 5,
  ...overrides,
});
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const ready = (handle: DuplexProcessHandle) =>
  Stream.runHead(handle.stdout).pipe(
    Effect.map((chunk) => {
      expect(Option.isSome(chunk)).toBe(true);
      const text = decode(Option.getOrThrow(chunk));
      expect(text.startsWith("ready")).toBe(true);
      return text;
    }),
  );
const collect = (stream: Stream.Stream<Uint8Array, DuplexProcessError>) =>
  Stream.runFold(
    stream,
    () => "",
    (text, bytes) => text + decode(bytes),
  );

const collectUntil = (stream: Stream.Stream<Uint8Array, DuplexProcessError>, length: number) =>
  stream.pipe(
    Stream.scan("", (text, bytes) => text + decode(bytes)),
    Stream.takeUntil((text) => text.length >= length),
    Stream.runLast,
    Effect.map(Option.getOrThrow),
  );

// The raw Node door is owned by core. Keep real OS handles while controlling
// acquisition handoff or observing native buffer retention at that boundary.
const observeChildren = (observe: (child: DuplexProcessChild) => void) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const spawn = NodeBuiltins.nodeSpawn;
      return vi.spyOn(NodeBuiltins, "nodeSpawn").mockImplementation((command, args, options) => {
        const child = spawn(command, args ?? [], { ...options, stdio: ["pipe", "pipe", "pipe"] });
        observe(child);
        return child;
      });
    }),
    (spy) => Effect.sync(() => spy.mockRestore()),
  );

const pausedScheduler = () => {
  const tasks: Array<{ task: () => void; priority: number }> = [];
  const dispatcher = new Scheduler.MixedScheduler().makeDispatcher();
  let resumed = false;
  const scheduler: Scheduler.Scheduler = {
    executionMode: "async",
    shouldYield: (fiber) => fiber.currentOpCount >= fiber.maxOpsBeforeYield,
    makeDispatcher: () => ({
      scheduleTask: (task, priority) => {
        if (resumed) dispatcher.scheduleTask(task, priority);
        else tasks.push({ task, priority });
      },
      flush: () => {
        while (tasks.length) tasks.shift()!.task();
      },
    }),
  };
  return {
    scheduler,
    step: () => tasks.shift()?.task(),
    resume: () => {
      resumed = true;
      for (const { task, priority } of tasks.splice(0)) dispatcher.scheduleTask(task, priority);
    },
  };
};

const expectFailure = <A>(
  result:
    | { readonly _tag: "Success"; readonly success: A }
    | { readonly _tag: "Failure"; readonly failure: DuplexProcessError },
  reason: DuplexProcessError["reason"],
) => {
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure).toBeInstanceOf(DuplexProcessError);
    expect(result.failure.reason).toBe(reason);
  }
};

describe.skipIf(process.platform !== "darwin")("macOS duplex processes", () => {
  it.live("owns duplex stdin/stdout and confirms normal cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* openDuplexProcess(options("echo"));
        const write = handle.write(encode("hello"));
        yield* write;
        yield* write;
        const output = yield* collectUntil(handle.stdout, 10);
        expect(output).toBe("hellohello");
        yield* handle.close;
        expect(yield* handle.cleanupState).toBe("confirmed");
        expectFailure(yield* handle.write(encode("late")).pipe(Effect.result), "closed");
      }),
    ),
  );

  it.live("settles concurrent writes without interleaving or losing data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* openDuplexProcess(options("echo"));
        const messages = Array.from({ length: 32 }, (_, index) =>
          String(index).padStart(2, "0").repeat(16_384),
        );
        const expected = messages.join("");
        const reader = yield* collectUntil(handle.stdout, expected.length).pipe(Effect.forkScoped);
        yield* Effect.forEach(messages, (message) => handle.write(encode(message)), {
          concurrency: "unbounded",
        });
        expect(yield* Fiber.join(reader)).toBe(expected);
      }),
    ),
  );

  it.live("makes concurrent and repeated close calls idempotent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cleanup: boolean[] = [];
        const handle = yield* openDuplexProcess(
          options("ignore-term", { onCleanup: (value) => cleanup.push(value) }),
        );
        yield* ready(handle);
        yield* Effect.all([handle.close, handle.close], { concurrency: "unbounded" });
        yield* handle.close;
        expect(yield* handle.cleanupState).toBe("confirmed");
        expect(cleanup).toEqual([true]);
      }),
    ),
  );

  it.live(
    "first-close interruption during graceful wait cannot poison repeated close or release",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* Scope.fork(yield* Effect.scope);
          const cleanup: boolean[] = [];
          const handle = yield* openDuplexProcess(
            options("ignore-term", { onCleanup: (value) => cleanup.push(value) }),
          ).pipe(Effect.provideService(Scope.Scope, owner));
          yield* ready(handle);
          const terminated = yield* Deferred.make<void>();
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const kill = process.kill.bind(process);
              return vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
                const result = kill(pid, signal);
                if (pid === -handle.pid && signal === "SIGTERM")
                  Deferred.doneUnsafe(terminated, Effect.void);
                return result;
              });
            }),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          const closing = yield* handle.close.pipe(Effect.forkScoped);
          yield* Deferred.await(terminated);
          yield* Fiber.interrupt(closing);
          const interrupted = yield* Fiber.await(closing);
          expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(
            true,
          );
          expect(yield* handle.cleanupState).toBe("confirmed");
          expect((yield* handle.exit).signal).toBe("SIGKILL");
          expect(yield* handle.close.pipe(Effect.exit)).toEqual(Exit.void);
          expect(yield* Scope.close(owner, Exit.void).pipe(Effect.exit)).toEqual(Exit.void);
          expect(cleanup).toEqual([true]);
        }),
      ),
  );

  it.live.each(Array.from({ length: 24 }, (_, checkpoint) => checkpoint))(
    "first-close interruption at scheduler yield %s cannot strand cache admission",
    (checkpoint) =>
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* Scope.fork(yield* Effect.scope);
          const cleanup: boolean[] = [];
          const handle = yield* openDuplexProcess(
            options("ignore-term", { onCleanup: (value) => cleanup.push(value) }),
          ).pipe(Effect.provideService(Scope.Scope, owner));
          yield* ready(handle);
          const paused = pausedScheduler();
          const closing = yield* handle.close.pipe(
            Effect.provideService(Scheduler.MaxOpsBeforeYield, 8),
            Effect.provideService(Scheduler.Scheduler, paused.scheduler),
            Effect.forkScoped({ startImmediately: true }),
          );
          for (let step = 0; step < checkpoint; step++) paused.step();
          closing.interruptUnsafe();
          paused.resume();
          yield* Fiber.await(closing);
          expect(yield* handle.close.pipe(Effect.exit)).toEqual(Exit.void);
          expect(yield* Scope.close(owner, Exit.void).pipe(Effect.exit)).toEqual(Exit.void);
          expect(yield* handle.cleanupState).toBe("confirmed");
          expect((yield* handle.exit).signal).toBe("SIGKILL");
          expect(cleanup).toEqual([true]);
        }),
      ),
  );

  it.live("scope release joins process cleanup and revokes the returned handle", () =>
    Effect.gen(function* () {
      const cleanup: boolean[] = [];
      const handle = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* openDuplexProcess(
            options("ignore-term", {
              onCleanup: (value) => cleanup.push(value),
            }),
          );
          yield* ready(handle);
          return handle;
        }),
      );
      expect(cleanup).toEqual([true]);
      expect(yield* handle.cleanupState).toBe("confirmed");
      expect((yield* handle.exit).signal).toBe("SIGKILL");
      yield* handle.close;
      expect(cleanup).toEqual([true]);
      expectFailure(yield* handle.write(encode("late")).pipe(Effect.result), "closed");
    }),
  );

  it.live("reports a failed spawn without exposing native errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cleanup: boolean[] = [];
        const secret = "/missing-private-command-token";
        const result = yield* openDuplexProcess(
          options("echo", {
            command: secret,
            args: ["private-argument"],
            environment: { SECRET: "private-value" },
            onCleanup: (value) => cleanup.push(value),
          }),
        ).pipe(Effect.result);
        expectFailure(result, "failed");
        if (result._tag === "Failure") {
          expect(String(result.failure)).not.toContain(secret);
          expect(String(result.failure)).not.toContain("private-argument");
          expect(String(result.failure)).not.toContain("private-value");
        }
        expect(cleanup).toEqual([true]);
      }),
    ),
  );

  it.live("closes interrupted acquisition before its still-open parent scope releases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureReady = yield* Deferred.make<void>();
        const cleanup: boolean[] = [];
        let child: DuplexProcessChild | undefined;
        yield* observeChildren((value) => {
          child = value;
          const emit = value.emit.bind(value);
          vi.spyOn(value, "emit").mockImplementation((event, ...args) =>
            event === "spawn" ? true : emit(event, ...args),
          );
          value.stdout.once("data", () => Deferred.doneUnsafe(fixtureReady, Effect.void));
        });
        const pending = yield* openDuplexProcess(
          options("ignore-term", {
            startTimeoutMs: 60_000,
            onCleanup: (value) => cleanup.push(value),
          }),
        ).pipe(Effect.forkScoped);
        // The child has installed its TERM handler, but the owned boundary has not
        // delivered spawn readiness. An acquireRelease mask would hang here.
        yield* Deferred.await(fixtureReady);
        expect(pending.pollUnsafe()).toBeUndefined();
        yield* Fiber.interrupt(pending);
        expect(cleanup).toEqual([true]);
        expect(child?.signalCode).toBe("SIGKILL");
      }),
    ),
  );

  it.live("releases failed startup immediately and reports its deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cleanup: boolean[] = [];
        yield* observeChildren((child) => {
          const emit = child.emit.bind(child);
          vi.spyOn(child, "emit").mockImplementation((event, ...args) =>
            event === "spawn" ? true : emit(event, ...args),
          );
        });
        const result = yield* openDuplexProcess(
          options("ignore-term", {
            startTimeoutMs: 50,
            onCleanup: (value) => cleanup.push(value),
          }),
        ).pipe(Effect.result);
        expectFailure(result, "timeout");
        expect(cleanup).toEqual([true]);
      }),
    ),
  );

  it.live.each(["failure", "timeout", "interruption"] as const)(
    "failed native readiness retains cleanup uncertainty after %s",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixtureReady = yield* Deferred.make<void>();
          const cleanup: boolean[] = [];
          let child: DuplexProcessChild | undefined;
          yield* observeChildren((value) => {
            child = value;
            const emit = value.emit.bind(value);
            vi.spyOn(value, "emit").mockImplementation((event, ...args) =>
              event === "spawn" || event === "close" ? true : emit(event, ...args),
            );
            value.stdout.once("data", () => Deferred.doneUnsafe(fixtureReady, Effect.void));
          });
          const pending = yield* openDuplexProcess(
            options("ignore-term", {
              startTimeoutMs: mode === "timeout" ? 100 : 60_000,
              cleanupTimeoutMs: 150,
              onCleanup: (value) => cleanup.push(value),
            }),
          ).pipe(Effect.forkScoped);
          if (mode !== "timeout") yield* Deferred.await(fixtureReady);
          if (mode === "failure") child!.emit("error", new Error("private-native-readiness"));
          if (mode === "interruption") {
            yield* Fiber.interrupt(pending);
            const result = yield* Fiber.await(pending);
            expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true);
          } else {
            const result = yield* Fiber.join(pending).pipe(Effect.result);
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { operation: "cleanup", reason: "timeout" },
            });
            expect(String(result)).not.toContain("private-");
          }
          expect(cleanup).toEqual([false]);
          if (mode === "timeout") expect(child?.signalCode).toBeTruthy();
          else expect(child?.signalCode).toBe("SIGKILL");
        }),
      ),
  );

  it.live("bounds a stalled stdin write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* openDuplexProcess(
          options("stall-stdin", {
            maxWriteBytes: 4 * 1024 * 1024,
            maxWriteQueueBytes: 4 * 1024 * 1024,
            writeTimeoutMs: 25,
          }),
        );
        yield* ready(handle);
        expectFailure(
          yield* handle.write(new Uint8Array(4 * 1024 * 1024)).pipe(Effect.result),
          "timeout",
        );
        yield* handle.close;
      }),
    ),
  );

  it.live(
    "retains cancelled native buffers in admission until release and safely closes pending input",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let child: DuplexProcessChild | undefined;
          yield* observeChildren((value) => {
            child = value;
          });
          const handle = yield* openDuplexProcess(
            options("stall-stdin", {
              maxWriteBytes: 4 * 1024 * 1024,
              maxWriteQueueBytes: 4 * 1024 * 1024 + 1,
            }),
          );
          yield* ready(handle);
          const first = yield* handle
            .write(new Uint8Array(4 * 1024 * 1024))
            .pipe(Effect.forkScoped);
          yield* yieldUntil(() => (child?.stdin.writableLength ?? 0) > 0);
          yield* Fiber.interrupt(first);
          expect(child!.stdin.writableLength).toBeGreaterThan(0);
          expectFailure(yield* handle.write(new Uint8Array(2)).pipe(Effect.result), "overflow");
          const queued = yield* handle
            .write(new Uint8Array(1))
            .pipe(Effect.result, Effect.forkScoped);
          yield* Effect.yieldNow;
          expect(queued.pollUnsafe()).toBeUndefined();
          yield* handle.close;
          expectFailure(yield* Fiber.join(queued), "closed");
          expect(child!.stdin.closed).toBe(true);
          expect(yield* handle.cleanupState).toBe("confirmed");
        }),
      ),
  );

  it.live("escalates from TERM only after the leader installs its handler", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* openDuplexProcess(options("ignore-term"));
        yield* ready(handle);
        yield* handle.close;
        expect((yield* handle.exit).signal).toBe("SIGKILL");
        expect(yield* handle.cleanupState).toBe("confirmed");
      }),
    ),
  );

  it.live("confirms descendant cleanup after ready and after the leader exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const mode of ["parent-exits", "hold-pipes"]) {
          const handle = yield* openDuplexProcess(options(mode));
          const greeting = yield* ready(handle);
          const descendantPid = Number(greeting.trim().split(":")[1]);
          expect(descendantPid).toBeGreaterThan(0);
          if (mode === "parent-exits") expect((yield* handle.exit).code).toBe(0);
          yield* handle.close;
          expect(yield* handle.cleanupState).toBe("confirmed");
          expect(() => process.kill(descendantPid, 0)).toThrow();
        }
      }),
    ),
  );

  it.live("delivers unread stdout and descendant output through stream EOF after root exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* openDuplexProcess(options("late-output"));
        expect((yield* handle.exit).code).toBe(0);
        const output = yield* collect(handle.stdout);
        expect(output.startsWith("ready:")).toBe(true);
        expect(output.endsWith("after-exit\n")).toBe(true);
        yield* handle.close;
        expect(yield* handle.cleanupState).toBe("confirmed");
      }),
    ),
  );

  it.live("fails stdout overflow with a bounded typed error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* openDuplexProcess(options("burst", { maxReadQueueBytes: 16 }));
        yield* ready(handle);
        yield* handle.write(encode("go"));
        expectFailure(yield* collect(handle.stdout).pipe(Effect.result), "overflow");
        yield* handle.close;
      }),
    ),
  );

  it.live("caps stderr retention and queue bytes independently, including disabled stderr", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const limits of [
          { maxStderrBytes: 128, maxStderrQueueBytes: 7, expected: 7 },
          { maxStderrBytes: 19, maxStderrQueueBytes: 128, expected: 19 },
          { maxStderrBytes: 0, maxStderrQueueBytes: 0, expected: 0 },
        ]) {
          const handle = yield* openDuplexProcess(options("stderr", limits));
          yield* ready(handle);
          yield* handle.write(encode("go"));
          yield* handle.exit;
          expect((yield* collect(handle.stderr)).length).toBe(limits.expected);
        }
      }),
    ),
  );
});

it.effect("uses one total cleanup deadline instead of sequential wait budgets", () =>
  Effect.gen(function* () {
    // The owned cleanup-boundary fake uses real streams without OS handles.
    const child = {
      pid: 2_147_483_647,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    };
    const signals: Array<string | number | undefined> = [];
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const kill = process.kill.bind(process);
        return vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid !== -child.pid!) return kill(pid, signal);
          signals.push(signal);
          return true;
        });
      }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const closing = yield* closeDuplexProcess(child, {
      gracefulTimeoutMs: 80,
      forceTimeoutMs: 80,
      cleanupTimeoutMs: 100,
      pollIntervalMs: 5,
      nativeClosed: Effect.void,
    }).pipe(Effect.result, Effect.forkScoped);
    yield* TestClock.adjust(80);
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
    expect(closing.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust(20);
    expectFailure(yield* Fiber.join(closing), "timeout");
  }),
);
