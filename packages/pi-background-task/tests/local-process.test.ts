// Explicit test entry-point Layer provision owns the local process scope.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { provideBuiltLayer, signalProcess, type ProcessTreeTerminatorSpawn } from "pi-cosmic-core";
import { fakeProcessTreeTerminator } from "pi-cosmic-core/testing";
import {
  LocalProcess,
  makeBackgroundProcessEnvironment,
  makeWindowsTreeTermination,
  type LocalProcessHandle,
  type LocalProcessRequest,
} from "../src/boundary/local-process.ts";

const withLocalProcess = <A, E>(effect: Effect.Effect<A, E, LocalProcess | Scope.Scope>) =>
  effect.pipe(Effect.scoped, provideBuiltLayer(LocalProcess.layer));
const spawnProcess = (command: string, overrides: Partial<LocalProcessRequest> = {}) =>
  LocalProcess.use((processes) =>
    processes.spawn({ command, cwd: ".", ingressBufferBytes: 64 * 1024, ...overrides }),
  );
const collectUntilExit = (handle: LocalProcessHandle) =>
  Effect.all(
    { events: handle.output.pipe(Stream.runCollect), exit: handle.awaitExit },
    { concurrency: "unbounded" },
  );

const firstOutput = (handle: LocalProcessHandle) =>
  handle.output.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.timeout("5 seconds"),
    Effect.map((events) => [...events].map((event) => event.text).join("")),
  );

const processAlive = (pid: number) => signalProcess(pid, 0) === "present";

const awaitProcessDeath = (pid: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!processAlive(pid)) return true;
      yield* Effect.sleep("10 millis");
    }
    return !processAlive(pid);
  });

/** One bounded force `taskkill` through the boundary's graceful/force owner. */
const forceTaskkill = (spawn: ProcessTreeTerminatorSpawn) =>
  makeWindowsTreeTermination(42, spawn).pipe(Effect.flatMap((tree) => tree.terminate("force")));

describe("windows tree terminator", () => {
  it.effect("maps synchronous helper spawn failure without preventing later escalation", () =>
    Effect.gen(function* () {
      const fake = fakeProcessTreeTerminator();
      const { terminate } = yield* makeWindowsTreeTermination(42, (command, args, options) => {
        if (!args.includes("/F")) throw new Error("private spawn details");
        return fake.spawn(command, args, options);
      });
      yield* terminate("graceful");
      const stopping = yield* terminate("force").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      fake.emit("exit", 0);
      yield* Fiber.join(stopping);
      const failed = yield* forceTaskkill(() => {
        throw new Error("private spawn details");
      }).pipe(Effect.flip);
      expect(failed).toMatchObject({ _tag: "LocalProcessError", reason: "terminate" });
      expect(String(failed)).not.toContain("private spawn details");
    }).pipe(Effect.scoped),
  );

  it.effect("still escalates after the graceful helper times out", () =>
    Effect.gen(function* () {
      const graceful = fakeProcessTreeTerminator();
      const force = fakeProcessTreeTerminator();
      const { terminate } = yield* makeWindowsTreeTermination(42, (command, args, options) =>
        (args.includes("/F") ? force : graceful).spawn(command, args, options),
      );
      yield* terminate("graceful");
      yield* TestClock.adjust("2 seconds");
      expect(graceful.killed).toEqual(["SIGKILL"]);
      const stopping = yield* terminate("force").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      expect(force.spawns).toHaveLength(1);
      force.emit("exit", 0);
      yield* Fiber.join(stopping);
    }).pipe(Effect.scoped),
  );
  it.effect("joins a hanging graceful helper before force, once, and contains late errors", () =>
    Effect.gen(function* () {
      const graceful = fakeProcessTreeTerminator();
      const force = fakeProcessTreeTerminator();
      const { terminate } = yield* makeWindowsTreeTermination(42, (command, args, options) =>
        (args.includes("/F") ? force : graceful).spawn(command, args, options),
      );
      yield* terminate("graceful");
      yield* terminate("graceful");
      expect(graceful.spawns).toHaveLength(1);
      const stopping = yield* terminate("force").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      expect(graceful.killed).toEqual(["SIGKILL"]);
      graceful.emit("error", new Error("late graceful error"));
      expect(force.spawns).toHaveLength(1);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(stopping).pipe(Effect.ignore);
      force.emit("error", new Error("late force error"));
      const retry = yield* terminate("force").pipe(Effect.forkScoped({ startImmediately: true }));
      expect(force.spawns).toHaveLength(2);
      force.emit("exit", 0);
      yield* Fiber.join(retry);
      expect(force.killed).toEqual(["SIGKILL"]);
      expect(graceful.spawns).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("scope closure interrupts a hanging graceful helper without awaiting exit", () =>
    Effect.gen(function* () {
      const fake = fakeProcessTreeTerminator();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { terminate } = yield* makeWindowsTreeTermination(42, fake.spawn);
          yield* terminate("graceful");
        }),
      );
      expect(fake.killed).toEqual(["SIGKILL"]);
      expect(fake.listenerCounts()).toEqual({ exit: 0, error: 1 });
      fake.emit("error", new Error("late shutdown error"));
    }),
  );
  it.effect("maps nonzero exit and spawn error to redacted typed failures", () =>
    Effect.gen(function* () {
      const nonzero = fakeProcessTreeTerminator();
      const nonzeroFiber = yield* forceTaskkill(nonzero.spawn).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      nonzero.emit("exit", 1);
      const nonzeroFailure = yield* Fiber.join(nonzeroFiber).pipe(Effect.flip);
      expect(nonzeroFailure).toMatchObject({ _tag: "LocalProcessError" });

      const errored = fakeProcessTreeTerminator();
      const erroredFiber = yield* forceTaskkill(errored.spawn).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      errored.emit("error", new Error("taskkill exposed FAKE_SECRET_123"));
      const erroredFailure = yield* Fiber.join(erroredFiber).pipe(Effect.flip);
      expect(erroredFailure).toMatchObject({ _tag: "LocalProcessError" });
      expect(String(erroredFailure)).not.toContain("FAKE_SECRET_123");
      expect(errored.listenerCounts()).toEqual({ exit: 0, error: 0 });
    }).pipe(Effect.scoped),
  );

  // Windows may reuse an exited PID, so its exit sweep and later stops never target it.
  it.effect("never runs taskkill after the leader's exit is recorded", () =>
    Effect.gen(function* () {
      const fake = fakeProcessTreeTerminator();
      const tree = yield* makeWindowsTreeTermination(42, fake.spawn);
      yield* tree.settleExit;
      yield* tree.terminate("graceful");
      yield* tree.terminate("force");
      expect(fake.spawns).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("settles a force taskkill that races the leader's natural exit", () =>
    Effect.gen(function* () {
      const fake = fakeProcessTreeTerminator();
      const tree = yield* makeWindowsTreeTermination(42, fake.spawn);
      const stopping = yield* tree
        .terminate("force")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* tree.settleExit;
      // taskkill reports the vanished target as a nonzero exit.
      fake.emit("exit", 128);
      yield* Fiber.join(stopping);
      yield* tree.terminate("force");
      expect(fake.spawns).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});

describe("local process boundary", () => {
  it.effect("interrupts a cwd inspection that never settles", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      // A masked inspection would hang this interruption instead of abandoning it.
      const layer = LocalProcess.layerWith(
        FileSystem.layerNoop({
          stat: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      );
      const starting = yield* LocalProcess.use((service) =>
        service.spawn({ command: "exit 0", cwd: ".", ingressBufferBytes: 1024 }),
      ).pipe(Effect.scoped, provideBuiltLayer(layer), Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(starting);
      expect(Exit.hasInterrupts(yield* Fiber.await(starting))).toBe(true);
    }),
  );
  it("case-folds blocked environment keys only on Windows", () => {
    const blocked = {
      BASH_ENV: "bash",
      ENV: "shell",
      NODE_OPTIONS: "--inspect",
      NODE_PATH: "/modules",
      PI_SESSION_FILE: "/private/session.jsonl",
      PI_SESSION_ID: "private",
    };
    expect(makeBackgroundProcessEnvironment({ PATH: "/bin", ...blocked }, "linux")).toEqual({
      PATH: "/bin",
      FORCE_COLOR: "1",
    });

    const lowerCase = {
      bash_env: "bash",
      env: "shell",
      node_options: "--inspect",
      node_path: "/modules",
      pi_session_file: "/private/session.jsonl",
      pi_session_id: "private",
    };
    expect(makeBackgroundProcessEnvironment(lowerCase, "linux")).toEqual({
      ...lowerCase,
      FORCE_COLOR: "1",
    });
    expect(makeBackgroundProcessEnvironment({ PATH: "C:\\bin", ...lowerCase }, "win32")).toEqual({
      PATH: "C:\\bin",
      FORCE_COLOR: "1",
    });
  });

  it("requests color from compatible CLIs unless the environment explicitly configures it", () => {
    expect(makeBackgroundProcessEnvironment({ FORCE_COLOR: "0" })).toEqual({ FORCE_COLOR: "0" });
    expect(makeBackgroundProcessEnvironment({ NO_COLOR: "1" })).toEqual({ NO_COLOR: "1" });
    expect(makeBackgroundProcessEnvironment({ force_color: "0" }, "win32")).toEqual({
      force_color: "0",
    });
    expect(makeBackgroundProcessEnvironment({ no_color: "1" }, "win32")).toEqual({
      no_color: "1",
    });
  });

  it.live("captures stdout, stderr, and exit", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const handle = yield* spawnProcess(
          `node -e "process.stdout.write('out'); process.stderr.write('err')"`,
        );
        const result = yield* collectUntilExit(handle);
        expect(result.exit.exitCode).toBe(0);
        const output = [...result.events].map((event) => `${event.stream}:${event.text}`).join("|");
        expect(output).toContain("stdout:out");
        expect(output).toContain("stderr:err");
      }),
    ),
  );

  it.live("returns only exit code and signal data after a successful spawn", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const handle = yield* spawnProcess(`node -e "process.exitCode = 7"`);
        expect(yield* handle.awaitExit).toEqual({ exitCode: 7 });
      }),
    ),
  );

  it.live("rejects a missing working directory", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const result = yield* Effect.result(
          spawnProcess('node -e ""', { cwd: "/definitely/missing/pi-bg-dir" }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.reason).toBe("cwd");
      }),
    ),
  );

  it.live("redacts the command when Effect reports a spawn failure", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const result = yield* Effect.result(
          spawnProcess("echo api_key=FAKE_SECRET_123", {
            shellPath: "/definitely/missing/pi-background-shell",
          }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.reason).toBe("spawn");
          expect(result.failure.message).not.toContain("FAKE_SECRET_123");
          expect(String(result.failure)).not.toContain("FAKE_SECRET_123");
        }
      }),
    ),
  );

  it.live("reports a spawn that Node refuses synchronously as a redacted typed failure", () =>
    withLocalProcess(
      Effect.gen(function* () {
        // Node throws before any child exists when an argument holds a NUL character.
        for (const [command, overrides] of [
          ["echo api_key=FAKE_SECRET_123\u0000", {}],
          ["echo api_key=FAKE_SECRET_123", { shellPath: "/bin/sh\u0000" }],
        ] as const) {
          const failure = yield* spawnProcess(command, overrides).pipe(Effect.flip);
          expect(failure).toMatchObject({ _tag: "LocalProcessError", reason: "spawn" });
          expect(String(failure)).not.toContain("FAKE_SECRET_123");
        }
      }),
    ),
  );

  it.live("bounds ingress when a producer outruns log consumption", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const handle = yield* spawnProcess(
          `node -e "for(let i=0;i<20000;i++) process.stdout.write('noisy-output-'+i+'\\n')"`,
          { ingressBufferBytes: 1024 },
        );
        yield* handle.awaitExit.pipe(Effect.timeout("5 seconds"));
        expect(handle.droppedOutputBytes()).toBeGreaterThan(0);
      }),
    ),
  );

  it.live("keeps a chunk whole when it fits in the remaining byte budget", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const content = "A".repeat(512);
        const handle = yield* spawnProcess(`node -e "process.stdout.write('A'.repeat(512))"`, {
          ingressBufferBytes: 1_024,
        });
        const result = yield* collectUntilExit(handle);
        const stdout = [...result.events]
          .filter((event) => event.stream === "stdout")
          .map((event) => event.text)
          .join("");
        expect(stdout).toBe(content);
        expect(handle.droppedOutputBytes()).toBe(0);
      }),
    ),
  );

  it.live("keeps queued output within the configured byte budget", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const producedBytes = 2_000;
        const ingressBufferBytes = 1_024;
        const handle = yield* spawnProcess(
          `node -e "process.stdout.write('A'.repeat(${producedBytes}))"`,
          { ingressBufferBytes },
        );
        const result = yield* collectUntilExit(handle);
        expect(result.exit.exitCode).toBe(0);
        const deliveredBytes = [...result.events]
          .filter((event) => event.stream === "stdout")
          .reduce((total, event) => total + Buffer.byteLength(event.text, "utf8"), 0);
        expect(deliveredBytes).toBeLessThanOrEqual(ingressBufferBytes);
        expect(handle.droppedOutputBytes() + deliveredBytes).toBe(producedBytes);
      }),
    ),
  );

  it.live("settles after killing descendants that retain inherited pipes", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const handle = yield* spawnProcess(
          `node -e "const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); child.unref();"`,
        );
        const result = yield* collectUntilExit(handle).pipe(Effect.timeout("5 seconds"));
        expect(result.exit.exitCode).toBe(0);
      }),
    ),
  );

  it.live("scope release terminates a running leader and descendant", () =>
    Effect.gen(function* () {
      const pids = yield* Effect.gen(function* () {
        const handle = yield* spawnProcess(
          `node -e "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(child.pid)); setInterval(()=>{},1000)"`,
        );
        const events = yield* handle.output.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        );
        const descendant = Number([...events][0]?.text.trim());
        expect(Number.isSafeInteger(descendant)).toBe(true);
        return { leader: handle.pid, descendant };
      }).pipe(Effect.scoped, provideBuiltLayer(LocalProcess.layer));

      expect(yield* awaitProcessDeath(pids.leader)).toBe(true);
      expect(yield* awaitProcessDeath(pids.descendant)).toBe(true);
    }),
  );

  // `; true` keeps the shell as the group leader, so it exits on SIGTERM before its child.
  it.live.skipIf(process.platform === "win32")(
    "a graceful stop keeps the group's grace window after a compound command's leader exits",
    () =>
      withLocalProcess(
        Effect.gen(function* () {
          const handle = yield* spawnProcess(
            `node -e "process.on('SIGTERM', () => setTimeout(() => { process.stdout.write('cleaned'); process.exit(0) }, 200)); process.stdout.write('ready'); setInterval(() => {}, 1000)"; true`,
          );
          expect(yield* firstOutput(handle)).toBe("ready");
          yield* handle.terminate("graceful");
          const result = yield* collectUntilExit(handle).pipe(Effect.timeout("5 seconds"));
          expect(result.exit).toEqual({ exitCode: null, signal: "SIGTERM" });
          expect([...result.events].map((event) => event.text).join("")).toContain("cleaned");
        }),
      ),
  );

  it.live.skipIf(process.platform === "win32")(
    "force ends a graceful stop's group grace window and kills lingering descendants",
    () =>
      withLocalProcess(
        Effect.gen(function* () {
          const handle = yield* spawnProcess(
            `node -e "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)"; true`,
          );
          const descendant = Number(yield* firstOutput(handle));
          expect(Number.isSafeInteger(descendant)).toBe(true);
          yield* handle.terminate("graceful");
          const early = yield* handle.awaitExit.pipe(Effect.timeoutOption("300 millis"));
          expect(Option.isNone(early)).toBe(true);
          expect(processAlive(descendant)).toBe(true);
          yield* handle.terminate("force");
          const exit = yield* handle.awaitExit.pipe(Effect.timeout("5 seconds"));
          // The leader exited on the graceful signal; only its group waited for force.
          expect(exit).toEqual({ exitCode: null, signal: "SIGTERM" });
          expect(yield* awaitProcessDeath(descendant)).toBe(true);
        }),
      ),
  );

  it.live("force-terminates a running process", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const handle = yield* spawnProcess(`node -e "setInterval(() => {}, 1000)"`);
        yield* handle.terminate("force");
        const exit = yield* handle.awaitExit.pipe(Effect.timeout("5 seconds"));
        expect(exit).toMatchObject({ exitCode: null, signal: "SIGKILL" });
      }),
    ),
  );
});
