// Explicit test entry-point Layer provision owns the local process scope.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { provideBuiltLayer } from "pi-cosmic-core";
import { LocalProcess, makeBackgroundProcessEnvironment } from "../src/boundary/local-process.ts";

const withLocalProcess = <A, E>(effect: Effect.Effect<A, E, LocalProcess | Scope.Scope>) =>
  effect.pipe(Effect.scoped, provideBuiltLayer(LocalProcess.layer));

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const awaitProcessDeath = (pid: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!processAlive(pid)) return true;
      yield* Effect.sleep("10 millis");
    }
    return !processAlive(pid);
  });

describe("local process boundary", () => {
  it("requests color from compatible CLIs unless the environment explicitly configures it", () => {
    expect(
      makeBackgroundProcessEnvironment({
        PATH: "/bin",
        PI_SESSION_ID: "private",
        NODE_OPTIONS: "--inspect",
      }),
    ).toEqual({ PATH: "/bin", FORCE_COLOR: "1" });
    expect(makeBackgroundProcessEnvironment({ FORCE_COLOR: "0" })).toEqual({ FORCE_COLOR: "0" });
    expect(makeBackgroundProcessEnvironment({ NO_COLOR: "1" })).toEqual({ NO_COLOR: "1" });
    expect(makeBackgroundProcessEnvironment({ force_color: "0" }, "win32")).toEqual({
      force_color: "0",
    });
    expect(makeBackgroundProcessEnvironment({ no_color: "1" }, "win32")).toEqual({
      no_color: "1",
    });
  });

  it.effect("captures stdout, stderr, and exit", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const processes = yield* LocalProcess;
        const handle = yield* processes.spawn({
          command: `node -e "process.stdout.write('out'); process.stderr.write('err')"`,
          cwd: ".",
          ingressBufferBytes: 64 * 1024,
        });
        const result = yield* Effect.all(
          {
            events: handle.output.pipe(Stream.runCollect),
            exit: handle.awaitExit,
          },
          { concurrency: "unbounded" },
        );
        expect(result.exit.exitCode).toBe(0);
        const output = [...result.events].map((event) => `${event.stream}:${event.text}`).join("|");
        expect(output).toContain("stdout:out");
        expect(output).toContain("stderr:err");
      }),
    ),
  );

  it.effect("rejects a missing working directory", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const processes = yield* LocalProcess;
        const result = yield* Effect.result(
          processes.spawn({
            command: 'node -e ""',
            cwd: "/definitely/missing/pi-bg-dir",
            ingressBufferBytes: 64 * 1024,
          }),
        );
        expect(result._tag).toBe("Failure");
      }),
    ),
  );

  it.effect("redacts the command when Effect reports a spawn failure", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const processes = yield* LocalProcess;
        const result = yield* Effect.result(
          processes.spawn({
            command: "echo api_key=FAKE_SECRET_123",
            cwd: ".",
            shellPath: "/definitely/missing/pi-background-shell",
            ingressBufferBytes: 64 * 1024,
          }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.message).toBe("Unable to spawn local process.");
          expect(String(result.failure)).not.toContain("FAKE_SECRET_123");
        }
      }),
    ),
  );

  it.effect("bounds ingress when a producer outruns log consumption", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const processes = yield* LocalProcess;
        const handle = yield* processes.spawn({
          command: `node -e "for(let i=0;i<20000;i++) process.stdout.write('noisy-output-'+i+'\\n')"`,
          cwd: ".",
          ingressBufferBytes: 1024,
        });
        yield* handle.awaitExit.pipe(Effect.timeout("5 seconds"));
        expect(handle.droppedOutputBytes()).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect("keeps a chunk whole when it fits in the remaining byte budget", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const processes = yield* LocalProcess;
        const content = "A".repeat(512);
        const handle = yield* processes.spawn({
          command: `node -e "process.stdout.write('A'.repeat(512))"`,
          cwd: ".",
          ingressBufferBytes: 1_024,
        });
        const result = yield* Effect.all(
          {
            events: handle.output.pipe(Stream.runCollect),
            exit: handle.awaitExit,
          },
          { concurrency: "unbounded" },
        );
        const stdout = [...result.events]
          .filter((event) => event.stream === "stdout")
          .map((event) => event.text)
          .join("");
        expect(stdout).toBe(content);
        expect(handle.droppedOutputBytes()).toBe(0);
      }),
    ),
  );

  it.effect("keeps queued output within the configured byte budget", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const processes = yield* LocalProcess;
        const producedBytes = 2_000;
        const ingressBufferBytes = 1_024;
        const handle = yield* processes.spawn({
          command: `node -e "process.stdout.write('A'.repeat(${producedBytes}))"`,
          cwd: ".",
          ingressBufferBytes,
        });
        const result = yield* Effect.all(
          {
            events: handle.output.pipe(Stream.runCollect),
            exit: handle.awaitExit,
          },
          { concurrency: "unbounded" },
        );
        expect(result.exit.exitCode).toBe(0);
        const deliveredBytes = [...result.events]
          .filter((event) => event.stream === "stdout")
          .reduce((total, event) => total + Buffer.byteLength(event.text, "utf8"), 0);
        expect(deliveredBytes).toBeLessThanOrEqual(ingressBufferBytes);
        expect(handle.droppedOutputBytes() + deliveredBytes).toBe(producedBytes);
      }),
    ),
  );

  it.effect("settles after killing descendants that retain inherited pipes", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const processes = yield* LocalProcess;
        const handle = yield* processes.spawn({
          command: `node -e "const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); child.unref();"`,
          cwd: ".",
          ingressBufferBytes: 64 * 1024,
        });
        const result = yield* Effect.all(
          {
            events: handle.output.pipe(Stream.runCollect),
            exit: handle.awaitExit,
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("5 seconds"));
        expect(result.exit.exitCode).toBe(0);
      }),
    ),
  );

  it.live("scope release terminates a running leader and descendant", () =>
    Effect.gen(function* () {
      const pids = yield* Effect.gen(function* () {
        const processes = yield* LocalProcess;
        const handle = yield* processes.spawn({
          command: `node -e "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(child.pid)); setInterval(()=>{},1000)"`,
          cwd: ".",
          ingressBufferBytes: 64 * 1024,
        });
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

  it.effect("force-terminates a running process", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const processes = yield* LocalProcess;
        const handle = yield* processes.spawn({
          command: `node -e "setInterval(() => {}, 1000)"`,
          cwd: ".",
          ingressBufferBytes: 64 * 1024,
        });
        yield* handle.terminate("force");
        const exit = yield* handle.awaitExit.pipe(Effect.timeout("5 seconds"));
        expect(exit).toMatchObject({ exitCode: null, signal: "SIGKILL" });
      }),
    ),
  );
});
