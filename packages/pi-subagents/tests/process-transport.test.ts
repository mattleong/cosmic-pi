import type { NodeChildProcess } from "./support/node-builtins.ts";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { describe, expect, it } from "@effect/vitest";
import { beforeEach, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { temporaryDirectory, yieldUntil } from "pi-cosmic-core/testing";
import { processGroupSignalError } from "pi-cosmic-core";
import { ChildProcess } from "../src/boundary/child-process.ts";
import { acquireLocalCliTransport } from "../src/boundary/local-cli-transport.ts";
import {
  MAX_PROCESS_LINE_BYTES,
  type ProcessTransportRuntime,
} from "../src/boundary/process-transport.ts";
import { backendLaunch } from "./fixtures/backend-supervisor.ts";
import { stringMatching } from "./support/matchers.ts";

const boundary = {
  spawn: vi.fn<ProcessTransportRuntime["spawn"]>(),
  terminate: vi.fn<ProcessTransportRuntime["terminate"]>(),
  confirmGroupExit: vi.fn<ProcessTransportRuntime["confirmGroupExit"]>(),
  detachedGroups: vi.fn<ProcessTransportRuntime["detachedGroups"]>(),
};
const nativeRequest = {
  executable: "fixture",
  args: [],
  env: {},
  cwd: "/fixture",
  writer: false,
};
const acquireNative = (writer = false) =>
  acquireLocalCliTransport({ ...nativeRequest, writer }, boundary);
const notification = { method: "initialized" as const };

const { ChildProcess: NodeChildProcessClass } = process.getBuiltinModule("node:child_process");
const { PassThrough, Writable } = process.getBuiltinModule("node:stream");

const foreignListener = () => {};
const fixture = () => {
  const child: NodeChildProcess = new NodeChildProcessClass();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: string[] = [];
  let stalled = false;
  let completeWrite: ((error?: Error | null) => void) | undefined;
  const stdin = new Writable({
    decodeStrings: false,
    write(chunk: string, _encoding, callback) {
      writes.push(chunk);
      if (stalled) completeWrite = callback;
      else callback();
    },
  });
  Object.defineProperties(child, {
    pid: { value: 4242 },
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: stderr },
  });
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

const spawnListenerReady = (child: NodeChildProcess) =>
  Effect.callback<void>((resume) => {
    const ready = () => {
      child.off("newListener", registered);
      resume(Effect.void);
    };
    const registered = (event: string | symbol) => {
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
const openNative = (f: ReturnType<typeof fixture>, writer = false) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const handle = yield* start(f.child, acquireNative(writer).pipe(Scope.provide(scope)));
    return { handle, scope, release: closeScope(scope) };
  });

beforeEach(() => {
  boundary.spawn.mockReset();
  boundary.terminate.mockReset();
  boundary.confirmGroupExit.mockReset().mockReturnValue(Effect.succeed(true));
  boundary.detachedGroups.mockReset().mockReturnValue(Effect.succeed([]));
});

describe("shared process transport", () => {
  it.effect("fails typed before ownership on a throwing spawn", () =>
    Effect.gen(function* () {
      boundary.spawn.mockImplementation(() => {
        throw new Error("unavailable");
      });
      const error = yield* acquireNative().pipe(Effect.flip, Effect.scoped);
      expect(error.code).toBe("local_cli_spawn_failed");
      expect(boundary.terminate).not.toHaveBeenCalled();
    }),
  );

  it.effect("detaches exactly its listeners after asynchronous spawn failure", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.child.on("error", foreignListener);
      f.stdout.on("error", foreignListener);
      const pending = yield* Effect.forkChild(acquireNative().pipe(Effect.flip, Effect.scoped));
      yield* spawnListenerReady(f.child);
      f.child.emit("error", new Error("spawn failed"));
      expect((yield* Fiber.join(pending)).code).toBe("local_cli_spawn_failed");
      expect(f.child.listeners("error")).toEqual([foreignListener]);
      expect(f.stdout.listeners("error")).toEqual([foreignListener]);
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
        const { handle, release } = yield* openNative(f);
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
        yield* release;
      }),
  );

  it.effect(
    "classifies encoding rejection separately from uncertain callback and stalled-write outcomes",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const { handle, release } = yield* openNative(f);
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
        yield* release;

        const stalled = fixture();
        const other = yield* openNative(stalled);
        stalled.stall();
        const pending = yield* Effect.forkChild(other.handle.send(notification).pipe(Effect.flip));
        yield* yieldUntil(() => stalled.writes.length === 1);
        yield* TestClock.adjust("10 seconds");
        expect((yield* Fiber.join(pending)).code).toBe("transport_outcome_uncertain");
        stalled.completeWrite();
        yield* other.release;
      }),
  );

  it.effect("keeps native outbound frame limits and summarizes oversized inbound lines", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { handle, release } = yield* openNative(f);
      const oversized = {
        method: "initialized" as const,
        extra: "x".repeat(MAX_PROCESS_LINE_BYTES),
      };
      expect((yield* handle.send(oversized).pipe(Effect.flip)).code).toBe("transport_not_sent");
      expect(f.writes).toEqual([]);
      f.stdout.emit("data", Buffer.alloc(MAX_PROCESS_LINE_BYTES + 1, "x"));
      f.stdout.emit("data", Buffer.from('\n{"type":"result"}\n'));
      const skipped = yield* Queue.take(handle.events);
      expect(skipped).toMatchObject({ type: "oversized_line", bytes: MAX_PROCESS_LINE_BYTES + 1 });
      handle.acknowledge(skipped);
      expect(yield* Queue.take(handle.events)).toMatchObject({
        type: "message",
        value: { type: "result" },
      });
      expect(boundary.terminate).not.toHaveBeenCalled();
      yield* release;
      expect(f.writes).toEqual([]);
    }),
  );

  it.effect("keeps dequeued bytes owned until acknowledged and fails an excessive backlog", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { handle, release } = yield* openNative(f);
      const line = `"${"x".repeat(3 * 1024 * 1024)}"\n`;
      f.stdout.emit("data", Buffer.from(line));
      const first = yield* Queue.take(handle.events);
      f.stdout.emit("data", Buffer.from(line));
      yield* Queue.take(handle.events);
      expect(boundary.terminate).not.toHaveBeenCalled();
      handle.acknowledge(first);
      handle.acknowledge(first);
      f.stdout.emit("data", Buffer.from(line));
      yield* Queue.take(handle.events);
      expect(boundary.terminate).not.toHaveBeenCalled();
      f.stdout.emit("data", Buffer.from(line));
      expect(yield* Queue.take(handle.events)).toMatchObject({ type: "protocol_error" });
      expect(boundary.terminate).toHaveBeenCalledWith(f.child, "force");
      yield* release;
    }),
  );

  it.effect("terminates a count-overflowed event queue independently of byte weight", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { release } = yield* openNative(f);
      for (let i = 0; i < 513; i++) f.stdout.emit("data", Buffer.from("{}\n"));
      expect(boundary.terminate).toHaveBeenCalledWith(f.child, "force");
      yield* release;
    }),
  );

  it.effect("gives an overflowed child a SIGTERM grace period before SIGKILL", () =>
    Effect.gen(function* () {
      const f = fixture();
      boundary.terminate.mockImplementation((_child, mode) =>
        mode === "force" ? Effect.sync(f.finish) : Effect.void,
      );
      const { release } = yield* openNative(f);
      for (let i = 0; i < 513; i++) f.stdout.emit("data", Buffer.from("{}\n"));
      yield* yieldUntil(() => boundary.terminate.mock.calls.length > 0);
      yield* TestClock.adjust("1 second");
      expect(boundary.terminate.mock.calls.map((call) => call[1])).toEqual(["graceful"]);
      yield* TestClock.adjust("1 second");
      yield* yieldUntil(() => boundary.terminate.mock.calls.length === 2);
      expect(boundary.terminate.mock.calls.map((call) => call[1])).toEqual(["graceful", "force"]);
      yield* release;
    }),
  );

  describe("detached descendants", () => {
    const DETACHED_GROUP = 5151;
    // Descendants reparent once the child is signalled, so only an earlier snapshot finds them.
    const detachedUntilSignalled = (survives: boolean) => {
      boundary.detachedGroups.mockImplementation(() =>
        Effect.sync(() => (boundary.terminate.mock.calls.length === 0 ? [DETACHED_GROUP] : [])),
      );
      boundary.confirmGroupExit.mockImplementation((pid) =>
        Effect.succeed(!survives || pid !== DETACHED_GROUP),
      );
    };
    const releaseFailure = (scope: Scope.Closeable) =>
      finishTimed(Scope.close(scope, Exit.void).pipe(Effect.sandbox, Effect.flip)).pipe(
        Effect.map(Cause.squash),
      );

    it.effect("keeps a writer's cleanup unconfirmed while a detached command survives", () =>
      Effect.gen(function* () {
        detachedUntilSignalled(true);
        const { scope } = yield* openNative(fixture(), true);
        expect(yield* releaseFailure(scope)).toMatchObject({ code: "cleanup_unconfirmed" });
      }),
    );

    it.effect("records detached commands before an overflow signals the writer", () =>
      Effect.gen(function* () {
        detachedUntilSignalled(true);
        const f = fixture();
        const { scope } = yield* openNative(f, true);
        for (let i = 0; i < 513; i++) f.stdout.emit("data", Buffer.from("{}\n"));
        yield* yieldUntil(() => boundary.terminate.mock.calls.length > 0);
        expect(yield* releaseFailure(scope)).toMatchObject({ code: "cleanup_unconfirmed" });
      }),
    );

    for (const [description, writer, survives] of [
      ["confirms a writer whose detached commands exited", true, false],
      ["does not hold a reader's cleanup on detached commands", false, true],
    ] as const)
      it.effect(description, () =>
        Effect.gen(function* () {
          detachedUntilSignalled(survives);
          const { release } = yield* openNative(fixture(), writer);
          yield* release;
        }),
      );
  });

  it.effect("lets an in-flight forced termination finish after the scope closes", () =>
    Effect.gen(function* () {
      const f = fixture();
      const forced = yield* Deferred.make<void>();
      let outcome: "completed" | "interrupted" | undefined;
      const settle = (value: typeof outcome) =>
        Effect.sync(() => {
          outcome = value;
        });
      boundary.terminate.mockImplementation((_child, mode) =>
        mode === "force"
          ? Deferred.await(forced).pipe(
              Effect.tap(() => settle("completed")),
              Effect.onInterrupt(() => settle("interrupted")),
            )
          : Effect.sync(f.finish),
      );
      const scope = yield* Scope.make();
      yield* start(f.child, acquireNative().pipe(Scope.provide(scope)));
      for (let i = 0; i < 513; i++) f.stdout.emit("data", Buffer.from("{}\n"));
      expect(boundary.terminate).toHaveBeenCalledWith(f.child, "force");
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* TestClock.adjust("5 seconds");
      expect(outcome).toBeUndefined();
      yield* Deferred.succeed(forced, undefined);
      yield* Fiber.join(closing);
      expect(outcome).toBe("completed");
      expect(f.stdin.destroyed).toBe(true);
    }),
  );

  it.effect("registers its release before an interrupted acquisition settles", () =>
    Effect.gen(function* () {
      const f = fixture();
      const scope = yield* Scope.make();
      const pending = yield* Effect.forkChild(acquireNative().pipe(Scope.provide(scope)));
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

  it.effect("joins an interrupted scope release through exit confirmation and releases once", () =>
    Effect.gen(function* () {
      const f = fixture();
      boundary.terminate.mockImplementation(() => Effect.void);
      const { scope } = yield* openNative(f);
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* TestClock.adjust("100 millis");
      const interrupted = yield* Effect.forkChild(Fiber.interrupt(closing));
      yield* Effect.yieldNow;
      expect(interrupted.pollUnsafe()).toBeUndefined();
      expect(f.stdin.destroyed).toBe(false);
      f.finish();
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(interrupted);
      expect(f.stdin.destroyed).toBe(true);
      yield* Scope.close(scope, Exit.void);
      expect(boundary.terminate.mock.calls.map((call) => call[1])).toEqual(["graceful", "force"]);
    }),
  );

  it.effect("fails release closed when exit is never confirmed after forced termination", () =>
    Effect.gen(function* () {
      const f = fixture();
      boundary.terminate.mockImplementation(() => Effect.void);
      const { scope } = yield* openNative(f);
      const cause = yield* finishTimed(
        Scope.close(scope, Exit.void).pipe(Effect.sandbox, Effect.flip),
      );
      expect(Cause.squash(cause)).toMatchObject({ code: "cleanup_unconfirmed" });
      expect(f.stdin.destroyed).toBe(true);
      yield* Scope.close(scope, Exit.void);
      expect(boundary.terminate.mock.calls.map((call) => call[1])).toEqual(["graceful", "force"]);
    }),
  );

  it.effect("retains cleanup failure when the leader exited but its process group remains", () =>
    Effect.gen(function* () {
      const f = fixture();
      boundary.confirmGroupExit.mockReturnValue(Effect.succeed(false));
      const { scope } = yield* openNative(f);
      const cause = yield* finishTimed(
        Scope.close(scope, Exit.void).pipe(Effect.sandbox, Effect.flip),
      );
      expect(Cause.squash(cause)).toMatchObject({ code: "cleanup_unconfirmed" });
      expect(f.stdin.destroyed).toBe(true);
    }),
  );

  it.effect("confirms group absence after a failed final signal to an exited leader", () =>
    Effect.gen(function* () {
      const f = fixture();
      boundary.terminate.mockImplementation((_child, mode) =>
        mode === "graceful"
          ? Effect.sync(f.finish)
          : Effect.fail(processGroupSignalError("permission")),
      );
      const { scope } = yield* openNative(f);
      yield* closeScope(scope);
      expect(f.stdin.destroyed).toBe(true);
      expect(boundary.confirmGroupExit).toHaveBeenCalled();
    }),
  );
});

describe("Pi transport policy", () => {
  it.effect("includes unacknowledged Node IPC payloads in the process byte budget", () =>
    Effect.gen(function* () {
      const f = fixture();
      const scope = yield* Scope.make();
      const agentDirectory = yield* temporaryDirectory("pi-transport-test-");
      const context = yield* Layer.build(
        ChildProcess.layer({ agentDirectory, transportRuntime: boundary }),
      );
      const service = Context.get(context, ChildProcess);
      const handle = yield* start(
        f.child,
        service.spawn(backendLaunch()).pipe(Scope.provide(scope)),
      );
      const contact = {
        channel: "pi-subagents",
        type: "proxy_request",
        requestId: "bounded",
        tool: "subagent_start",
        argumentsJson: "x".repeat(2 * 1024 * 1024),
      };
      f.child.emit("message", contact);
      const first = yield* Queue.take(handle.events);
      handle.acknowledge(first);
      for (let index = 0; index < 3; index++) {
        f.child.emit("message", contact);
        expect(yield* Queue.take(handle.events)).toMatchObject({ type: "parent_contact" });
      }
      expect(boundary.terminate).not.toHaveBeenCalled();
      f.child.emit("message", contact);
      expect(yield* Queue.take(handle.events)).toMatchObject({ type: "protocol_error" });
      expect(boundary.terminate).toHaveBeenCalled();
      yield* closeScope(scope);
    }),
  );
  it.effect(
    "captures early IPC, passes oversized events to the backend, and preserves Pi frame policy",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        f.child.on("message", foreignListener);
        const scope = yield* Scope.make();
        const agentDirectory = yield* temporaryDirectory("pi-transport-test-");
        const context = yield* Layer.build(
          ChildProcess.layer({ agentDirectory, transportRuntime: boundary }),
        );
        const service = Context.get(context, ChildProcess);
        const pending = yield* Effect.forkChild(
          service.spawn(backendLaunch()).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        yield* spawnListenerReady(f.child);
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
        const aggregate = `{"type":"agent_end","messages":[{"role":"toolResult","content":"${"x".repeat(6 * 1024 * 1024)}"}],"willRetry":false}\n`;
        for (let offset = 0; offset < aggregate.length; offset += 64 * 1024)
          f.stdout.emit("data", Buffer.from(aggregate.slice(offset, offset + 64 * 1024)));
        f.stdout.emit("data", Buffer.from('{"type":"agent_settled"}\n'));
        const skipped = yield* Queue.take(handle.events);
        expect(skipped).toMatchObject({
          type: "oversized_line",
          bytes: aggregate.length - 1,
          prefix: stringMatching(/^\{"type":"agent_end","messages":/),
          suffix: stringMatching(/"willRetry":false\}$/),
        });
        expect(yield* Queue.take(handle.events)).toMatchObject({
          type: "rpc_message",
          value: { type: "agent_settled" },
        });
        expect(boundary.terminate).not.toHaveBeenCalled();
        yield* closeScope(scope);
        expect(f.writes.at(-1)).toContain('"abort"');
        expect(f.child.listeners("message")).toEqual([foreignListener]);
        expect(f.child.listenerCount("disconnect")).toBe(0);
      }),
  );
});
