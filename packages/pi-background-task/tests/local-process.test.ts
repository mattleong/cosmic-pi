import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { provideBuiltLayer, signalProcess } from "pi-cosmic-core";
import {
  LocalProcess,
  makeBackgroundProcessEnvironment,
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

describe("local process boundary", () => {
  it.effect("interrupts a cwd inspection that never settles", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
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
  it("filters blocked environment keys with case-sensitive names", () => {
    const blocked = {
      BASH_ENV: "bash",
      ENV: "shell",
      NODE_OPTIONS: "--inspect",
      NODE_PATH: "/modules",
      PI_SESSION_FILE: "/private/session.jsonl",
      PI_SESSION_ID: "private",
    };
    expect(makeBackgroundProcessEnvironment({ PATH: "/bin", ...blocked })).toEqual({
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
    expect(makeBackgroundProcessEnvironment(lowerCase)).toEqual({
      ...lowerCase,
      FORCE_COLOR: "1",
    });
  });

  it("requests color from compatible CLIs unless the environment explicitly configures it", () => {
    expect(makeBackgroundProcessEnvironment({ FORCE_COLOR: "0" })).toEqual({ FORCE_COLOR: "0" });
    expect(makeBackgroundProcessEnvironment({ NO_COLOR: "1" })).toEqual({ NO_COLOR: "1" });
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

  it.live(
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

  it.live("force ends a graceful stop's group grace window and kills lingering descendants", () =>
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
