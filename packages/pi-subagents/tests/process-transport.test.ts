import type { NodeChildProcess } from "./support/node-builtins.ts";
import * as Fn from "effect/Function";
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
import { signalProcessGroup } from "pi-cosmic-core";
import { temporaryDirectory, yieldUntil } from "pi-cosmic-core/testing";
import { localPiBackendDriver } from "../src/backend/local-pi.ts";
import { ChildProcess } from "../src/boundary/child-process.ts";
import { SubagentProcessError } from "../src/run/errors.ts";
import { acquireLocalCliTransport } from "../src/boundary/local-cli-transport.ts";
import {
  MAX_PROCESS_LINE_BYTES,
  type ProcessTransportRuntime,
} from "../src/boundary/process-transport.ts";
import { backendLaunch } from "./fixtures/backend-supervisor.ts";
import { scriptedChildProcess } from "./fixtures/scripted-child-process.ts";
import { stringMatching } from "./support/matchers.ts";
import { processAlive } from "./support/process-liveness.ts";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

const boundary = {
  spawn: vi.fn<ProcessTransportRuntime["spawn"]>(),
  terminate: vi.fn<ProcessTransportRuntime["terminate"]>(),
  confirmGroupExit: vi.fn<ProcessTransportRuntime["confirmGroupExit"]>(),
  detachedGroups: vi.fn<ProcessTransportRuntime["detachedGroups"]>(),
  // The fixture's PID is not a real group, so no guard may reach the host's exit listener.
  guardGroup: () => Effect.succeed({ release: Effect.void }),
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

const foreignListener = () => {};
const fixture = () => {
  const scripted = scriptedChildProcess();
  boundary.spawn.mockReturnValue(scripted.child);
  boundary.terminate.mockImplementation(() => Effect.sync(scripted.finish));
  return scripted;
};

// Three unacknowledged 3 MiB lines exceed the 8 MiB process backlog budget.
const overflowBacklog = (f: ReturnType<typeof fixture>) => {
  const line = Buffer.from(`"${Fn.pipe("x", Str.repeat(3 * 1024 * 1024))}"\n`);
  for (let i = 0; i < 3; i++) f.stdout.emit("data", line);
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

  it.effect("keeps dequeued bytes owned until acknowledged and fails an excessive backlog", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { handle, release } = yield* openNative(f);
      const line = `"${Fn.pipe("x", Str.repeat(3 * 1024 * 1024))}"\n`;
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

  it.effect("bounds an unconsumed burst of small events by bytes rather than count", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { handle, release } = yield* openNative(f);
      f.stdout.emit("data", Buffer.from(Fn.pipe('{"type":"x"}\n', Str.repeat(5_000))));
      expect(boundary.terminate).not.toHaveBeenCalled();
      overflowBacklog(f);
      yield* yieldUntil(() => boundary.terminate.mock.calls.length > 0);
      expect((yield* handle.awaitExit).stderr).toContain("event backlog exceeded");
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
      overflowBacklog(f);
      yield* yieldUntil(() => boundary.terminate.mock.calls.length > 0);
      yield* TestClock.adjust("1 second");
      expect(Arr.map(boundary.terminate.mock.calls, (call) => call[1])).toEqual(["graceful"]);
      yield* TestClock.adjust("1 second");
      yield* yieldUntil(() => boundary.terminate.mock.calls.length === 2);
      expect(Arr.map(boundary.terminate.mock.calls, (call) => call[1])).toEqual([
        "graceful",
        "force",
      ]);
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

    for (const mode of ["graceful", "force"] as const) {
      it.effect(`joins a cancelled public ${mode} termination through snapshot and signal`, () =>
        Effect.gen(function* () {
          detachedUntilSignalled(true);
          const snapshotStarted = yield* Deferred.make<void>();
          const snapshot = yield* Deferred.make<ReadonlyArray<number>>();
          boundary.detachedGroups.mockReturnValue(
            Deferred.succeed(snapshotStarted, undefined).pipe(
              Effect.andThen(Deferred.await(snapshot)),
            ),
          );
          const { handle, scope } = yield* openNative(fixture(), true);
          const terminating = yield* Effect.forkChild(handle.terminate(mode));
          yield* Deferred.await(snapshotStarted);
          const interrupted = yield* Effect.forkChild(Fiber.interrupt(terminating));
          yield* Effect.yieldNow;
          expect(interrupted.pollUnsafe()).toBeUndefined();
          expect(boundary.terminate).not.toHaveBeenCalled();
          yield* Deferred.succeed(snapshot, [DETACHED_GROUP]);
          yield* Fiber.join(interrupted);
          yield* handle.awaitExit;
          expect(yield* releaseFailure(scope)).toMatchObject({ code: "cleanup_unconfirmed" });
        }),
      );

      it.effect(
        `cannot confirm cleanup after a public ${mode} snapshot defect and leader exit`,
        () =>
          Effect.gen(function* () {
            const f = fixture();
            const { handle, scope } = yield* openNative(f, true);
            boundary.detachedGroups.mockReturnValueOnce(Effect.die(new Error("snapshot failed")));
            const result = yield* Effect.exit(handle.terminate(mode));
            expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true);
            expect(boundary.terminate).toHaveBeenCalledWith(f.child, mode);
            f.finish();
            yield* handle.awaitExit;
            expect(yield* releaseFailure(scope)).toMatchObject({ code: "cleanup_unconfirmed" });
          }),
      );
    }
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
      overflowBacklog(f);
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
      expect(Arr.map(boundary.terminate.mock.calls, (call) => call[1])).toEqual([
        "graceful",
        "force",
      ]);
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
      expect(Arr.map(boundary.terminate.mock.calls, (call) => call[1])).toEqual([
        "graceful",
        "force",
      ]);
    }),
  );

  it.effect(
    "requires original and fully recorded detached group absence without resnapshotting or signalling",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        boundary.detachedGroups.mockReturnValue(Effect.succeed([8888]));
        boundary.confirmGroupExit.mockReturnValue(Effect.succeed(false));
        const { handle, scope } = yield* openNative(f, true);
        const cause = yield* finishTimed(
          Scope.close(scope, Exit.void).pipe(Effect.sandbox, Effect.flip),
        );
        const verifier = handle.cleanupVerifier;
        if (!verifier) return yield* Effect.die("Missing cleanup verifier");
        expect(verifier.canVerify()).toBe(true);
        expect(
          Option.getOrUndefined(
            Arr.findFirst(
              Arr.map(cause.reasons, verifier.diagnostic),
              (diagnostic) => diagnostic !== undefined,
            ),
          ),
        ).toMatchObject({ phase: "process-group" });
        expect(
          Arr.map(Cause.die(new Error("unrelated finalizer")).reasons, verifier.diagnostic),
        ).toEqual([undefined]);
        const signals = boundary.terminate.mock.calls.length;
        const snapshots = boundary.detachedGroups.mock.calls.length;
        boundary.confirmGroupExit.mockImplementation((group) => Effect.succeed(group !== 8888));
        expect(yield* verifier.verify.pipe(Effect.flip)).toMatchObject({
          phase: "descendant-groups",
        });
        boundary.confirmGroupExit.mockReturnValue(Effect.succeed(true));
        yield* verifier.verify;
        expect(boundary.terminate.mock.calls.length).toBe(signals);
        expect(boundary.detachedGroups.mock.calls.length).toBe(snapshots);
        return undefined;
      }),
  );

  it.effect(
    "fails closed on attempted incomplete snapshots but still terminates the owned child",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        boundary.detachedGroups.mockReturnValue(
          Effect.fail(
            SubagentProcessError.make({
              operation: "snapshot descendants",
              code: "snapshot_incomplete",
              message: "ps failed: Authorization: Bearer secret-value",
            }),
          ),
        );
        const { handle, scope } = yield* openNative(f, true);
        const cause = yield* finishTimed(
          Scope.close(scope, Exit.void).pipe(Effect.sandbox, Effect.flip),
        );
        const verifier = handle.cleanupVerifier;
        if (!verifier) return yield* Effect.die("Missing cleanup verifier");
        expect(f.child.exitCode).toBe(0);
        expect(boundary.terminate).toHaveBeenCalled();
        expect(verifier.canVerify()).toBe(false);
        const diagnostic = Option.getOrUndefined(
          Arr.findFirst(
            Arr.map(cause.reasons, verifier.diagnostic),
            (evidence) => evidence !== undefined,
          ),
        );
        expect(diagnostic).toMatchObject({
          phase: "descendant-snapshot",
          code: "snapshot_incomplete",
        });
        expect(diagnostic?.message).not.toContain("secret-value");
        expect(yield* verifier.verify.pipe(Effect.flip)).toMatchObject({
          phase: "descendant-snapshot",
        });
        return undefined;
      }),
  );
});

describe("writer process exit", () => {
  // The command's own process group survives the leader, whose exit reparents it.
  const detachThenExit = `const { spawn } = require("node:child_process");
const command = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
command.unref();
process.stderr.write(String(command.pid));`;

  it.live(
    "keeps cleanup unconfirmed after a writer exits on its own, leaving a detached command",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const handle = yield* acquireLocalCliTransport({
          executable: process.execPath,
          args: ["-e", detachThenExit],
          env: { PATH: "/usr/bin:/bin" },
          cwd: process.cwd(),
          writer: true,
        }).pipe(Scope.provide(scope));
        const commandPid = Number((yield* handle.awaitExit).stderr);
        expect(Number.isSafeInteger(commandPid) && commandPid > 0).toBe(true);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => signalProcessGroup(commandPid, "SIGKILL")),
        );
        expect(processAlive(commandPid)).toBe(true);

        const cause = yield* Scope.close(scope, Exit.void).pipe(Effect.sandbox, Effect.flip);
        expect(Cause.squash(cause)).toMatchObject({ code: "cleanup_unconfirmed" });
        const verifier = handle.cleanupVerifier;
        if (!verifier) return yield* Effect.die("Missing cleanup verifier");
        expect(
          Option.getOrUndefined(
            Arr.findFirst(
              Arr.map(cause.reasons, verifier.diagnostic),
              (diagnostic) => diagnostic !== undefined,
            ),
          ),
        ).toMatchObject({ phase: "descendant-snapshot" });
        expect(verifier.canVerify()).toBe(false);
        expect(processAlive(commandPid)).toBe(true);
        return undefined;
      }).pipe(Effect.scoped),
  );
});

describe("Pi transport policy", () => {
  it.effect("keeps a Pi child alive through a delta burst while its run consumer stalls", () =>
    Effect.gen(function* () {
      const f = fixture();
      const scope = yield* Scope.make();
      const agentDirectory = yield* temporaryDirectory("pi-transport-test-");
      const context = yield* Layer.build(
        ChildProcess.layer({ agentDirectory, transportRuntime: boundary }),
      );
      const pending = yield* Effect.forkChild(
        localPiBackendDriver(Context.get(context, ChildProcess))
          .spawn(backendLaunch())
          .pipe(Effect.provideService(Scope.Scope, scope)),
      );
      yield* spawnListenerReady(f.child);
      f.child.emit("spawn");
      const backend = yield* Fiber.join(pending);
      const delta = '{"type":"message_update","assistantMessageEvent":{"type":"text_delta"}}\n';
      for (let chunk = 0; chunk < 30; chunk++) {
        f.stdout.emit("data", Buffer.from(Fn.pipe(delta, Str.repeat(100))));
        yield* Effect.yieldNow;
      }
      f.stdout.emit(
        "data",
        Buffer.from(
          '{"type":"tool_execution_end","toolCallId":"call","toolName":"edit","result":null,"isError":false}\n',
        ),
      );
      yield* Effect.yieldNow;
      expect(boundary.terminate).not.toHaveBeenCalled();
      const activity = yield* Queue.take(backend.events);
      expect(activity.type).toBe("activity");
      backend.acknowledge(activity);
      expect(yield* Queue.take(backend.events)).toMatchObject({
        type: "tool_finished",
        toolCallId: "call",
      });
      expect(boundary.terminate).not.toHaveBeenCalled();
      yield* closeScope(scope);
    }),
  );
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
        tool: "agent_start",
        argumentsJson: Fn.pipe("x", Str.repeat(2 * 1024 * 1024)),
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
          type: "contact_request",
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
        yield* handle.send({
          type: "prompt",
          message: Fn.pipe("x", Str.repeat(MAX_PROCESS_LINE_BYTES)),
        });
        expect(f.writes[0]?.length).toBeGreaterThan(MAX_PROCESS_LINE_BYTES);
        const aggregate = `{"type":"agent_end","messages":[{"role":"toolResult","content":"${Fn.pipe("x", Str.repeat(6 * 1024 * 1024))}"}],"willRetry":false}\n`;
        for (let offset = 0; offset < aggregate.length; offset += 64 * 1024)
          f.stdout.emit(
            "data",
            Buffer.from(Fn.pipe(aggregate, Str.slice(offset, offset + 64 * 1024))),
          );
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
