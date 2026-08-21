// Explicit test entry-point Layer provision owns the local process scope.
// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { LocalProcess, makeBackgroundProcessEnvironment } from "../src/boundary/local-process.ts";

const withLocalProcess = <A, E>(effect: Effect.Effect<A, E, LocalProcess | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(LocalProcess.layer));

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
            events: Stream.fromQueue(handle.output).pipe(Stream.runCollect),
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

  it.effect("passes an oversized chunk through whole while ingress still has capacity", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const processes = yield* LocalProcess;
        // One write far larger than maxEventBytes (= ingressBufferBytes / INGRESS_CHUNKS = 32):
        // truncation must wait for real backpressure, not trigger on the first chunk.
        const handle = yield* processes.spawn({
          command: `node -e "process.stdout.write('A'.repeat(2000))"`,
          cwd: ".",
          ingressBufferBytes: 1024,
        });
        const result = yield* Effect.all(
          {
            events: Stream.fromQueue(handle.output).pipe(Stream.runCollect),
            exit: handle.awaitExit,
          },
          { concurrency: "unbounded" },
        );
        expect(result.exit.exitCode).toBe(0);
        const stdout = [...result.events]
          .filter((event) => event.stream === "stdout")
          .map((event) => event.text)
          .join("");
        expect(stdout).toBe("A".repeat(2000));
        expect(handle.droppedOutputBytes()).toBe(0);
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
            events: Stream.fromQueue(handle.output).pipe(Stream.runCollect),
            exit: handle.awaitExit,
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("5 seconds"));
        expect(result.exit.exitCode).toBe(0);
      }),
    ),
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
        expect(exit.exitCode).toBeNull();
      }),
    ),
  );
});
