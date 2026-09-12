import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { CrossProcessLock } from "../src/platform/cross-process-lock.ts";
import { acquireNativeLock } from "../src/platform/cross-process-lock-node.ts";
import {
  nodeFsPromises as fs,
  nodePath as path,
  nodeSpawn,
  nodeHomeDirectory,
  nodeLockFs,
} from "../src/platform/node-builtins.ts";

const root = Effect.acquireRelease(
  Effect.tryPromise(() => fs.mkdtemp(path.join(tmpdir(), "cosmic-lock-test-"))),
  (directory) =>
    Effect.tryPromise(() => fs.rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
);
const kill = (child: ReturnType<typeof nodeSpawn>) =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void);
      return;
    }
    const exited = () => resume(Effect.void);
    child.once("exit", exited);
    child.kill("SIGKILL");
    return Effect.sync(() => child.off("exit", exited));
  });
const spawn = (directory: string, mode: string, home?: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const options: NonNullable<Parameters<typeof nodeSpawn>[2]> = {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      };
      if (home) options.env = { HOME: home };
      const child = nodeSpawn(
        process.execPath,
        [
          "--import",
          "jiti/register",
          fileURLToPath(new URL("./fixtures/cross-process-lock-child.ts", import.meta.url)),
          directory,
          mode,
        ],
        options,
      );
      const messages: unknown[] = [];
      child.on("message", (message) => messages.push(message));
      const wait = (expected: string) =>
        Effect.callback<void>((resume) => {
          if (messages.includes(expected)) {
            resume(Effect.void);
            return;
          }
          const receive = (message: string | { home: string }) => {
            if (message === expected) resume(Effect.void);
          };
          child.on("message", receive);
          return Effect.sync(() => child.off("message", receive));
        }).pipe(Effect.timeout("10 seconds"));
      const exited = Effect.callback<void>((resume) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resume(Effect.void);
          return;
        }
        const finish = () => resume(Effect.void);
        child.once("exit", finish);
        return Effect.sync(() => child.off("exit", finish));
      }).pipe(Effect.timeout("10 seconds"));
      return { child, messages, wait, exited };
    }),
    ({ child }) => kill(child),
  );

it.live("excludes a real process, then admits its successor after release", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const first = yield* spawn(directory, "hold");
    yield* first.wait("acquired");
    const second = yield* spawn(directory, "once");
    yield* second.wait("attempting");
    yield* Effect.sleep(100);
    expect(second.messages).not.toContain("acquired");
    first.child.send?.("release");
    yield* second.wait("finished");
    const names = yield* Effect.tryPromise(() => fs.readdir(directory));
    expect(names.filter((name) => name.includes(".retired-")).length).toBe(2);
  }).pipe(Effect.scoped),
);

it.live("reclaims a positively dead quiescent owner without a timeout lease", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const first = yield* spawn(directory, "hold");
    yield* first.wait("acquired");
    yield* kill(first.child);
    const second = yield* spawn(directory, "once");
    yield* second.wait("finished");
  }).pipe(Effect.scoped),
);

it.live("does not equate owner death with native service settlement", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const first = yield* spawn(directory, "pending");
    yield* first.wait("acquired");
    yield* kill(first.child);
    const second = yield* spawn(directory, "once");
    yield* second.wait("recovery-required");
    expect(second.messages).not.toContain("acquired");
  }).pipe(Effect.scoped),
);

it.live("cancels a lock waiter promptly without releasing another owner", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const owner = acquireNativeLock("wait", { directory })!;
    const pending = yield* CrossProcessLock.use((lock) =>
      lock.withLock("wait", () => Effect.void),
    ).pipe(Effect.provide(CrossProcessLock.layer({ directory, pollMs: 10 })), Effect.forkScoped);
    yield* Effect.sleep(20);
    yield* Fiber.interrupt(pending);
    expect(acquireNativeLock("wait", { directory })).toBeUndefined();
    owner.release();
    const next = acquireNativeLock("wait", { directory })!;
    expect(next).toBeDefined();
    next.release();
  }).pipe(Effect.scoped),
);

it.live("retains an interrupted native owner until its real completion callback", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const owner = acquireNativeLock("native", { directory })!;
    owner.mutationStarted();
    owner.release();
    expect(acquireNativeLock("native", { directory })).toBeUndefined();
    owner.mutationSettled();
    const next = acquireNativeLock("native", { directory })!;
    expect(next).toBeDefined();
    owner.release();
    expect(acquireNativeLock("native", { directory })).toBeUndefined();
    next.release();
  }).pipe(Effect.scoped),
);

it.live("retires a published owner if acquisition durability confirmation fails", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const original = nodeLockFs.fsyncSync;
    let calls = 0;
    const spy = vi.spyOn(nodeLockFs, "fsyncSync").mockImplementation((fd) => {
      if (++calls === 3) throw Object.assign(new Error("Injected fsync failure"), { code: "EIO" });
      original(fd);
    });
    try {
      expect(() => acquireNativeLock("fault", { directory })).toThrow();
    } finally {
      spy.mockRestore();
    }
    const next = acquireNativeLock("fault", { directory })!;
    expect(next).toBeDefined();
    next.release();
  }).pipe(Effect.scoped),
);

for (const mode of ["death-before-publish", "write-fault"])
  it.live(`does not reserve an empty public slot after ${mode}`, () =>
    Effect.gen(function* () {
      const directory = yield* root;
      const first = yield* spawn(directory, mode);
      yield* first.exited;
      const second = yield* spawn(directory, "once");
      yield* second.wait("finished");
    }).pipe(Effect.scoped),
  );

it.live("derives one account home despite different HOME environments", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    for (const home of [path.join(directory, "first"), path.join(directory, "second")]) {
      const child = yield* spawn(directory, "home", home);
      yield* child.wait("finished");
      expect(child.messages).toContainEqual({ home: nodeHomeDirectory() });
    }
  }).pipe(Effect.scoped),
);

it.live("rejects unsafe private-directory permissions without repairing them", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    yield* Effect.tryPromise(() => fs.chmod(directory, 0o755));
    expect(() => acquireNativeLock("unsafe", { directory })).toThrow();
  }).pipe(Effect.scoped),
);
