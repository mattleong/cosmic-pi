// Fault injection stays at owned Node/process-tree boundaries; no provider executable runs.
import { EventEmitter } from "node:events";
import { nodeFsPromises, nodePath, type NodeChildProcess } from "./support/node-builtins.ts";
import { PassThrough, Writable } from "node:stream";
import { tmpdir } from "node:os";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { processCauseError } from "../src/run/errors.ts";
import { describe, expect, it } from "@effect/vitest";
import { beforeEach, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import { ChildProcess, type ChildLaunchRequest } from "../src/boundary/child-process.ts";
import { acquireLocalCliTransport } from "../src/boundary/local-cli-transport.ts";
import {
  MAX_PROCESS_LINE_BYTES,
  type ProcessTransportRuntime,
} from "../src/boundary/process-transport.ts";

const { mkdtemp, rm } = nodeFsPromises;
const { join } = nodePath;
const boundary = {
  spawn: vi.fn<ProcessTransportRuntime["spawn"]>(),
  terminate: vi.fn<ProcessTransportRuntime["terminate"]>(),
  force: vi.fn<ProcessTransportRuntime["force"]>(),
};

const launch: ChildLaunchRequest = {
  runId: "transport-test",
  name: "transport-test",
  cwd: "/fixture",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  model: "fixture/model",
  effort: "high",
  activeTools: [],
  projectTrusted: false,
  parentSessionId: "parent",
  systemPrompt: "Test",
};
const nativeRequest = {
  executable: "fixture",
  args: [],
  env: {},
  cwd: "/fixture",
  platform: "linux" as const,
};
const acquireNative = () => acquireLocalCliTransport(nativeRequest, boundary);
const notification = { method: "initialized" as const };

const fixture = () => {
  // SAFETY: This fixture supplies the Node streams and emitter methods used by the transport.
  const child = new EventEmitter() as NodeChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: string[] = [];
  let stalled = false;
  let completeWrite: ((error?: Error | null) => void) | undefined;
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      if (stalled) completeWrite = callback;
      else callback();
    },
  });
  Object.assign(child, { pid: 4242, stdin, stdout, stderr });
  const finish = () => {
    child.emit("close", 0, null);
  };
  boundary.spawn.mockReturnValue(child);
  boundary.terminate.mockImplementation(() => Effect.sync(finish));
  return {
    child,
    stdout,
    stderr,
    stdin,
    writes,
    finish,
    stall: () => {
      stalled = true;
    },
    completeWrite: (error?: Error) => completeWrite?.(error),
  };
};

// Layer startup performs real filesystem I/O. Scheduler yields cannot bound when
// that I/O completes; wait for the fixture's listener registration instead.
const spawnListenerReady = (child: NodeChildProcess) =>
  Effect.callback<void>((resume) => {
    const ready = () => {
      child.off("newListener", registered);
      resume(Effect.void);
    };
    const registered = (event: string | symbol) => {
      // Node emits newListener before installing it. Effect may resume synchronously,
      // so defer until registration completes before the fixture emits spawn.
      if (event === "spawn") queueMicrotask(ready);
    };
    child.on("newListener", registered);
    if (child.listenerCount("spawn") > 0) ready();
    return Effect.sync(() => {
      child.off("newListener", registered);
    });
  });

const start = <A, E>(child: NodeChildProcess, acquisition: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(acquisition);
    yield* spawnListenerReady(child);
    child.emit("spawn");
    return yield* Fiber.join(fiber);
  });
const finishTimed = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust("5 seconds");
    return yield* Fiber.join(fiber);
  });
const closeScope = (scope: Scope.Closeable) => finishTimed(Scope.close(scope, Exit.void));

beforeEach(() => {
  boundary.spawn.mockReset();
  boundary.terminate.mockReset();
  boundary.force.mockReset().mockResolvedValue(undefined);
});

describe("shared process transport", () => {
  it.effect("fails typed before ownership on a throwing spawn", () =>
    Effect.gen(function* () {
      boundary.spawn.mockImplementation(() => {
        throw new Error("unavailable");
      });
      const error = yield* acquireNative().pipe(Effect.flip);
      expect(error.code).toBe("local_cli_spawn_failed");
      expect(boundary.terminate).not.toHaveBeenCalled();
    }),
  );

  it.effect("detaches exactly its listeners after asynchronous spawn failure", () =>
    Effect.gen(function* () {
      const f = fixture();
      const foreign = () => {};
      f.child.on("error", foreign);
      f.stdout.on("error", foreign);
      const pending = yield* Effect.forkChild(acquireNative().pipe(Effect.flip));
      yield* spawnListenerReady(f.child);
      f.child.emit("error", new Error("spawn failed"));
      expect((yield* Fiber.join(pending)).code).toBe("local_cli_spawn_failed");
      expect(f.child.listeners("error")).toEqual([foreign]);
      expect(f.stdout.listeners("error")).toEqual([foreign]);
      expect(f.child.listenerCount("spawn")).toBe(0);
      expect(f.child.listenerCount("close")).toBe(0);
      expect(f.stdin.destroyed && f.stdout.destroyed && f.stderr.destroyed).toBe(true);
      expect(boundary.terminate).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "reports stream failures, retains a bounded stderr tail, and closes input definitively",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const handle = yield* start(f.child, acquireNative());
        f.stderr.emit("data", Buffer.alloc(256 * 1024, "x"));
        f.stdout.emit("error", new Error("stdout failure"));
        f.stderr.emit("error", new Error("stderr failure"));
        expect(yield* Queue.take(handle.events)).toMatchObject({ type: "protocol_error" });
        expect(yield* Queue.take(handle.events)).toMatchObject({ type: "protocol_error" });
        f.stdin.emit("error", new Error("stdin failure"));
        expect((yield* handle.send(notification).pipe(Effect.flip)).code).toBe(
          "transport_not_sent",
        );
        expect(f.writes).toEqual([]);
        f.finish();
        const exit = yield* handle.awaitExit;
        expect(Buffer.byteLength(exit.stderr)).toBeLessThanOrEqual(128 * 1024);
        expect(exit.stderr).toContain("stdout failure");
        expect(exit.stderr).toContain("stderr failure");
        yield* finishTimed(handle.release);
      }),
  );

  it.effect(
    "classifies encoding rejection separately from uncertain callback and stalled-write outcomes",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const handle = yield* start(f.child, acquireNative());
        const invalid = {
          method: "initialized" as const,
          toJSON: () => {
            throw new Error("encode");
          },
        };
        expect((yield* handle.send(invalid).pipe(Effect.flip)).code).toBe("transport_not_sent");
        expect(f.writes).toEqual([]);
        vi.spyOn(f.stdin, "write").mockImplementationOnce(() => {
          throw new Error("write");
        });
        const thrown = yield* Effect.exit(handle.send(notification));
        expect(Exit.isFailure(thrown) && Cause.hasDies(thrown.cause)).toBe(true);
        f.stall();
        const failedWrite = yield* Effect.forkChild(handle.send(notification).pipe(Effect.flip));
        yield* yieldUntil(() => f.writes.length === 1);
        f.completeWrite(new Error("write failed after acceptance"));
        expect((yield* Fiber.join(failedWrite)).code).toBe("transport_outcome_uncertain");
        yield* finishTimed(handle.release);

        const stalled = fixture();
        const other = yield* start(stalled.child, acquireNative());
        stalled.stall();
        const pending = yield* Effect.forkChild(other.send(notification).pipe(Effect.flip));
        yield* yieldUntil(() => stalled.writes.length === 1);
        yield* TestClock.adjust("10 seconds");
        expect((yield* Fiber.join(pending)).code).toBe("transport_outcome_uncertain");
        stalled.completeWrite();
        yield* finishTimed(other.release);
      }),
  );

  it.effect("keeps native outbound frame limits and terminates parser overflow", () =>
    Effect.gen(function* () {
      const f = fixture();
      const handle = yield* start(f.child, acquireNative());
      const oversized = {
        method: "initialized" as const,
        extra: "x".repeat(MAX_PROCESS_LINE_BYTES),
      };
      expect((yield* handle.send(oversized).pipe(Effect.flip)).code).toBe("transport_not_sent");
      expect(f.writes).toEqual([]);
      f.stdout.emit("data", Buffer.alloc(MAX_PROCESS_LINE_BYTES + 1, "x"));
      expect(yield* Queue.take(handle.events)).toMatchObject({ type: "protocol_error" });
      expect(boundary.force).toHaveBeenCalledWith(f.child, "force", { platform: "linux" });
      yield* finishTimed(handle.release);
      // Native release has no cooperative protocol abort.
      expect(f.writes).toEqual([]);
    }),
  );

  it.effect("keeps dequeued bytes owned until acknowledged and fails an excessive backlog", () =>
    Effect.gen(function* () {
      const f = fixture();
      const handle = yield* start(f.child, acquireNative());
      const line = `"${"x".repeat(3 * 1024 * 1024)}"\n`;
      f.stdout.emit("data", Buffer.from(line));
      const first = yield* Queue.take(handle.events);
      f.stdout.emit("data", Buffer.from(line));
      yield* Queue.take(handle.events);
      expect(boundary.force).not.toHaveBeenCalled();
      handle.acknowledge(first);
      handle.acknowledge(first);
      f.stdout.emit("data", Buffer.from(line));
      yield* Queue.take(handle.events);
      expect(boundary.force).not.toHaveBeenCalled();
      f.stdout.emit("data", Buffer.from(line));
      expect(yield* Queue.take(handle.events)).toMatchObject({ type: "protocol_error" });
      expect(boundary.force).toHaveBeenCalled();
      yield* finishTimed(handle.release);
    }),
  );

  it.effect("terminates a count-overflowed event queue independently of byte weight", () =>
    Effect.gen(function* () {
      const f = fixture();
      const handle = yield* start(f.child, acquireNative());
      for (let i = 0; i < 513; i++) f.stdout.emit("data", Buffer.from("{}\n"));
      expect(boundary.force).toHaveBeenCalled();
      yield* finishTimed(handle.release);
    }),
  );

  it.effect("hands an interrupted acquisition to its finalizer before releasing", () =>
    Effect.gen(function* () {
      const f = fixture();
      const scope = yield* Scope.make();
      const acquisition = Effect.acquireRelease(acquireNative(), (h) =>
        h.release.pipe(Effect.orDie),
      ).pipe(Effect.provideService(Scope.Scope, scope));
      const pending = yield* Effect.forkChild(acquisition);
      yield* spawnListenerReady(f.child);
      const interrupted = yield* Effect.forkChild(Fiber.interrupt(pending));
      yield* Effect.yieldNow;
      expect(f.stdin.destroyed).toBe(false);
      f.child.emit("spawn");
      yield* Fiber.join(interrupted);
      expect(f.stdin.destroyed).toBe(false);
      yield* closeScope(scope);
      expect(f.stdin.destroyed && f.stdout.destroyed && f.stderr.destroyed).toBe(true);
    }),
  );

  it.effect(
    "joins interrupted release through exit confirmation and caches the complete cleanup",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        boundary.terminate.mockImplementation(() => Effect.void);
        const handle = yield* start(f.child, acquireNative());
        const closing = yield* Effect.forkChild(handle.release);
        yield* TestClock.adjust("100 millis");
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(closing));
        yield* Effect.yieldNow;
        expect(interrupted.pollUnsafe()).toBeUndefined();
        expect(f.stdin.destroyed).toBe(false);
        f.finish();
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(interrupted);
        expect(f.stdin.destroyed).toBe(true);
        yield* handle.release;
        expect(boundary.terminate.mock.calls.map((call) => call[1])).toEqual(["graceful", "force"]);
      }),
  );

  it.effect("retains uncertain cleanup failure across repeated release", () =>
    Effect.gen(function* () {
      const f = fixture();
      boundary.terminate.mockImplementation(() => Effect.void);
      const handle = yield* start(f.child, acquireNative());
      const error = yield* finishTimed(handle.release.pipe(Effect.flip));
      expect(error.code).toBe("cleanup_unconfirmed");
      expect(f.stdin.destroyed).toBe(true);
      expect(yield* handle.release.pipe(Effect.flip)).toBe(error);
      expect(boundary.terminate.mock.calls.map((call) => call[1])).toEqual(["graceful", "force"]);
    }),
  );
});

describe("Pi transport policy", () => {
  it.effect(
    "captures early IPC, leaves parser overflow to the backend, and preserves Pi frame policy",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const foreign = () => {};
        f.child.on("message", foreign);
        const scope = yield* Scope.make();
        const agentDirectory = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => mkdtemp(join(tmpdir(), "pi-transport-test-")),
            catch: (error) => processCauseError("create fixture", error),
          }),
          (directory) =>
            Effect.tryPromise({
              try: () => rm(directory, { recursive: true, force: true }),
              catch: (error) => processCauseError("remove fixture", error),
            }).pipe(Effect.orDie),
        );
        const context = yield* Layer.build(
          ChildProcess.layer({ agentDirectory, transportRuntime: boundary }),
        );
        const service = Context.get(context, ChildProcess);
        const pending = yield* Effect.forkChild(
          service.spawn(launch).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        yield* spawnListenerReady(f.child);
        // Child extension registration can report before Node's spawn readiness continuation runs.
        f.child.emit("message", {
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: "early",
          kind: "progress",
          message: "ready",
        });
        f.child.emit("spawn");
        const handle = yield* Fiber.join(pending);
        expect(yield* Queue.take(handle.events)).toMatchObject({
          type: "parent_contact",
          value: { requestId: "early" },
        });
        vi.spyOn(f.stdin, "write").mockImplementationOnce(() => {
          throw new Error("write");
        });
        expect((yield* handle.send({ type: "get_state" }).pipe(Effect.flip)).code).toBe(
          "transport_not_sent",
        );
        yield* handle.send({ type: "prompt", message: "x".repeat(MAX_PROCESS_LINE_BYTES) });
        expect(f.writes[0]?.length).toBeGreaterThan(MAX_PROCESS_LINE_BYTES);
        f.stdout.emit("data", Buffer.alloc(MAX_PROCESS_LINE_BYTES + 1, "x"));
        expect(yield* Queue.take(handle.events)).toMatchObject({ type: "protocol_error" });
        expect(boundary.force).not.toHaveBeenCalled();
        yield* closeScope(scope);
        expect(f.writes.at(-1)).toContain('"abort"');
        expect(f.child.listeners("message")).toEqual([foreign]);
        expect(f.child.listenerCount("disconnect")).toBe(0);
      }),
  );
});
