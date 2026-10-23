import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Str from "effect/String";
import { nodeFilePlatformLayer, runBoundedProcessNode } from "pi-cosmic-core";
import { NodeChildProcess } from "pi-cosmic-core/testing";
import sharp from "sharp";
import { createSharpAdmission, makeSharpAdapter } from "../src/boundary/sharp.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  "base64",
);
const fixture = fileURLToPath(new URL("./fixtures/sharp-decoder-fixture.mjs", import.meta.url));

for (const format of ["png"] as const) {
  it.live(`fully decodes real ${format} bytes in the packaged subprocess`, () =>
    Effect.gen(function* () {
      const bytes = yield* Effect.tryPromise(() =>
        sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } })
          .toFormat(format)
          .toBuffer(),
      );
      expect(yield* makeSharpAdapter().decode(bytes)).toEqual({ format });
      const damaged = bytes.subarray(0, Math.floor(bytes.length / 2));
      yield* makeSharpAdapter().decode(damaged).pipe(Effect.flip);
    }),
  );
}

it.live("rejects corrupt bytes without exposing native errors", () =>
  Effect.gen(function* () {
    const failure = yield* makeSharpAdapter()
      .decode(Buffer.from("secret not an image"))
      .pipe(Effect.flip);
    expect(inspect(failure)).not.toContain("secret");
  }),
);

const fixtureRunner = (
  marker: string,
  timeoutMillis: number,
  onCleanup: (confirmed: boolean) => void = () => undefined,
) =>
  runBoundedProcessNode({
    executable: process.execPath,
    args: [fixture],
    stdin: Buffer.from(marker),
    stdoutLimitBytes: 128,
    stderrLimitBytes: 128,
    timeoutMillis,
    cleanupTimeoutMillis: 200,
    onCleanup,
  });

const makeMarker = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "sharp-process-" });
  return path.join(directory, "pid");
});

const waitForPid = (marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (;;) {
      const text = yield* fs.readFileString(marker).pipe(Effect.orElseSucceed(() => ""));
      if (text) {
        const pid = Number(Str.split(text, "\n")[0]);
        if (Number.isSafeInteger(pid) && pid > 0) return pid;
      }
      yield* Effect.sleep(10);
    }
  }).pipe(Effect.timeout(5_000));

const nativeKill = process.kill.bind(process);
const ownPid = (marker: string) =>
  Effect.acquireRelease(waitForPid(marker), (pid) =>
    Effect.sync(() => {
      try {
        nativeKill(pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }),
  );

function expectExited(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

it.live("deadline force-kills a SIGTERM-ignoring child before reuse", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const marker = yield* makeMarker;
    const pending = yield* fixtureRunner(marker, 1_000).pipe(Effect.forkScoped);
    const pid = yield* ownPid(marker);
    const result = yield* Fiber.join(pending);
    expect(result.timedOut).toBe(true);
    expect(result.cleanupUnconfirmed).toBe(false);
    expect(yield* fs.readFileString(marker)).toContain("SIGTERM");
    expectExited(pid);
    expect(yield* makeSharpAdapter().decode(png)).toEqual({ format: "png" });
  }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);

it.live("cancellation confirms forced child exit before releasing shared admission", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const marker = yield* makeMarker;
    const admission = createSharpAdmission();
    const adapter = makeSharpAdapter(
      (_bytes, onCleanup) => fixtureRunner(marker, 10_000, onCleanup),
      admission,
    );
    const pending = yield* adapter.decode(png).pipe(Effect.forkScoped);
    const pid = yield* ownPid(marker);
    let admittedWhileChildAlive: boolean | undefined;
    const waiting = yield* makeSharpAdapter(
      (_bytes, onCleanup) =>
        Effect.sync(() => {
          try {
            admittedWhileChildAlive = nativeKill(pid, 0);
          } catch {
            admittedWhileChildAlive = false;
          }
          onCleanup(true);
          return {
            code: 0,
            signal: null,
            stdout: '{"format":"png"}',
            stderr: "",
            overflowed: false,
            timedOut: false,
            cleanupUnconfirmed: false,
          };
        }),
      admission,
    )
      .decode(png)
      .pipe(Effect.forkScoped);
    yield* Effect.sleep(50);
    expect(admittedWhileChildAlive).toBeUndefined();
    yield* Fiber.interrupt(pending);
    expect(yield* fs.readFileString(marker)).toContain("SIGTERM");
    expectExited(pid);
    expect(yield* Fiber.join(waiting)).toEqual({ format: "png" });
    expect(admittedWhileChildAlive).toBe(false);
    expect(yield* makeSharpAdapter(undefined, admission).decode(png)).toEqual({ format: "png" });
  }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);

it.live("failed native cancellation cannot admit another decoder while its child survives", () =>
  Effect.gen(function* () {
    const marker = yield* makeMarker;
    const admission = createSharpAdmission();
    const adapter = makeSharpAdapter(
      (_bytes, onCleanup) => fixtureRunner(marker, 10_000, onCleanup),
      admission,
    );
    const pending = yield* adapter.decode(png).pipe(Effect.forkScoped);
    const pid = yield* ownPid(marker);
    const otherChildKills: Array<number | undefined> = [];
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const group = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
          if (target === -pid) throw Object.assign(new Error("denied"), { code: "EPERM" });
          return nativeKill(target, signal);
        });
        const child = vi
          .spyOn(NodeChildProcess.prototype, "kill")
          .mockImplementation(function (this: NodeChildProcess) {
            if (this.pid !== pid) otherChildKills.push(this.pid);
            return false;
          });
        return () => {
          group.mockRestore();
          child.mockRestore();
        };
      }),
      (restore) => Effect.sync(restore),
    );
    yield* Fiber.interrupt(pending);
    expect(nativeKill(pid, 0)).toBe(true);
    let spawned = false;
    const next = makeSharpAdapter(() => {
      spawned = true;
      return Effect.die("must not dispatch");
    }, admission);
    expect(yield* next.decode(png).pipe(Effect.flip)).toMatchObject({ operation: "unavailable" });
    expect(spawned).toBe(false);
    expect(otherChildKills).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);
