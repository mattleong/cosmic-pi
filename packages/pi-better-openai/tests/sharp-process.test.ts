import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodeFilePlatformLayer, runBoundedProcessNode } from "pi-cosmic-core";
import sharp from "sharp";
import { makeSharpAdapter } from "../src/boundary/sharp.ts";

// Native failure injection cannot be expressed by the Effect process service.
const nativeProcess = process.getBuiltinModule("node:child_process");
if (!nativeProcess) throw new Error("Node child_process builtin unavailable.");
const NativeChildProcess = nativeProcess.ChildProcess;

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  "base64",
);
const decoder = fileURLToPath(new URL("../src/boundary/sharp-decoder.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/sharp-decoder-fixture.mjs", import.meta.url));

for (const format of ["png", "jpeg", "webp", "gif"] as const) {
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

it.live("validates multi-page animated input", () =>
  Effect.gen(function* () {
    const bytes = yield* Effect.tryPromise(() =>
      sharp(Buffer.from([255, 0, 0, 0, 255, 0]), {
        raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
      })
        .gif()
        .toBuffer(),
    );
    expect(yield* makeSharpAdapter().decode(bytes)).toEqual({ format: "gif" });
  }),
);

it.live("rejects corrupt bytes without exposing native errors", () =>
  Effect.gen(function* () {
    const failure = yield* makeSharpAdapter()
      .decode(Buffer.from("secret not an image"))
      .pipe(Effect.flip);
    expect(inspect(failure)).not.toContain("secret");
  }),
);

it.live("enforces the child stdin limit even without the parent guard", () =>
  Effect.gen(function* () {
    const result = yield* runBoundedProcessNode({
      executable: process.execPath,
      args: [decoder],
      stdin: new Uint8Array(60 * 1024 * 1024 + 1),
      stdoutLimitBytes: 128,
      stderrLimitBytes: 128,
      timeoutMillis: 5_000,
      cleanupTimeoutMillis: 200,
    }).pipe(Effect.result);
    // Closing an oversized stdin can surface as either a stream failure or exit 1.
    if (result._tag === "Success") {
      expect(result.success.code).not.toBe(0);
      expect(result.success.stdout).toBe("");
      expect(result.success.stderr).toBe("");
      expect(result.success.cleanupUnconfirmed).toBe(false);
    }
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
        const pid = Number(text.split("\n")[0]);
        if (Number.isSafeInteger(pid) && pid > 0) return pid;
      }
      yield* Effect.sleep(10);
    }
  }).pipe(Effect.timeout(5_000));

// Test ownership survives failed assertions and bypasses injected kill failures.
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
    const adapter = makeSharpAdapter((_bytes, onCleanup) =>
      fixtureRunner(marker, 10_000, onCleanup),
    );
    const pending = yield* adapter.decode(png).pipe(Effect.forkScoped);
    const pid = yield* ownPid(marker);
    const next = makeSharpAdapter();
    expect(yield* next.decode(png).pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
    yield* Fiber.interrupt(pending);
    expect(yield* fs.readFileString(marker)).toContain("SIGTERM");
    expectExited(pid);
    expect(yield* next.decode(png)).toEqual({ format: "png" });
  }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);

// Last: uncertainty disables this module's admission permanently.
it.live("failed native cancellation cannot admit another decoder while its child survives", () =>
  Effect.gen(function* () {
    const marker = yield* makeMarker;
    const adapter = makeSharpAdapter((_bytes, onCleanup) =>
      fixtureRunner(marker, 10_000, onCleanup),
    );
    const pending = yield* adapter.decode(png).pipe(Effect.forkScoped);
    const pid = yield* ownPid(marker);
    const originalChildKill = NativeChildProcess.prototype.kill;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const group = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
          if (target === -pid) throw Object.assign(new Error("denied"), { code: "EPERM" });
          return nativeKill(target, signal);
        });
        const child = vi
          .spyOn(NativeChildProcess.prototype, "kill")
          .mockImplementation(function (this: InstanceType<typeof NativeChildProcess>, signal) {
            return this.pid === pid ? false : originalChildKill.call(this, signal);
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
    });
    expect(yield* next.decode(png).pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
    expect(spawned).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);
