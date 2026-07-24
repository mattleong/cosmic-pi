// Explicit test entry-point Layer provision owns each scoped service runtime.
// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import {
  LocalProcess,
  type LocalProcessExit,
  type LocalProcessHandle,
} from "../src/boundary/local-process.ts";
import { normalizeConfig } from "../src/config/options.ts";
import { BackgroundTerminalConfigStore } from "../src/config/store.ts";
import type { BackgroundTerminalConfig } from "../src/config/schema.ts";
import type { BackgroundJobState, BackgroundTerminalProjection } from "../src/job/model.ts";
import { BackgroundTerminalService } from "../src/job/service.ts";

interface FakeProcessControl {
  readonly handle: LocalProcessHandle;
  readonly modes: Array<"graceful" | "force">;
  readonly offer: (stream: "stdout" | "stderr", text: string) => void;
  readonly complete: (exit?: LocalProcessExit) => void;
}

function fakeProcessLayer(
  options: {
    readonly completeOnGraceful?: boolean;
    readonly completeOnForce?: boolean;
    readonly spawnGate?: Deferred.Deferred<void>;
  } = {},
) {
  const controls: FakeProcessControl[] = [];
  const spawned = Deferred.makeUnsafe<void>();
  const layer = Layer.succeed(LocalProcess, {
    spawn: () =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          if (options.spawnGate) yield* Deferred.await(options.spawnGate);
          const output = yield* Queue.unbounded<
            {
              readonly stream: "stdout" | "stderr";
              readonly text: string;
              readonly droppedBytes: number;
            },
            Cause.Done
          >();
          const exited = yield* Deferred.make<LocalProcessExit>();
          const modes: Array<"graceful" | "force"> = [];
          let completed = false;
          const complete = (exit: LocalProcessExit = { exitCode: 0 }) => {
            if (completed) return;
            completed = true;
            Queue.endUnsafe(output);
            Deferred.doneUnsafe(exited, Effect.succeed(exit));
          };
          const handle: LocalProcessHandle = {
            pid: 10_000 + controls.length,
            output,
            awaitExit: Deferred.await(exited),
            droppedOutputBytes: () => 0,
            terminate: (mode) =>
              Effect.sync(() => {
                modes.push(mode);
                if (
                  (mode === "force" && options.completeOnForce !== false) ||
                  (mode === "graceful" && options.completeOnGraceful !== false)
                ) {
                  complete({
                    exitCode: null,
                    signal: mode === "force" ? "SIGKILL" : "SIGTERM",
                  });
                }
              }),
          };
          controls.push({
            handle,
            modes,
            offer: (stream, text) =>
              void Queue.offerUnsafe(output, { stream, text, droppedBytes: 0 }),
            complete,
          });
          yield* Deferred.succeed(spawned, undefined);
          return handle;
        }),
        () => Effect.void,
      ),
  });
  return { layer, controls, spawned };
}

function serviceHarness(
  overrides: Partial<BackgroundTerminalConfig> = {},
  onProjection: (projection: BackgroundTerminalProjection) => void = () => {},
  fakeOptions: {
    readonly completeOnGraceful?: boolean;
    readonly completeOnForce?: boolean;
    readonly spawnGate?: Deferred.Deferred<void>;
  } = {},
) {
  const fake = fakeProcessLayer(fakeOptions);
  const config = Layer.succeed(
    BackgroundTerminalConfigStore,
    normalizeConfig({ stopGraceMs: 0, ...overrides }),
  );
  const dependencies = Layer.mergeAll(fake.layer, config, Path.layer);
  const layer = BackgroundTerminalService.layer({ publish: onProjection }).pipe(
    Layer.provide(dependencies),
  );
  return { ...fake, layer };
}

const awaitState = (state: BackgroundJobState) => {
  const reached = Deferred.makeUnsafe<void>();
  return {
    reached,
    publish: (projection: BackgroundTerminalProjection) => {
      if (projection.jobs.some((job) => job.state === state)) {
        Deferred.doneUnsafe(reached, Effect.void);
      }
    },
  };
};

describe("BackgroundTerminalService", () => {
  it.effect("starts, long-polls logs, and publishes process exit", () => {
    const terminal = awaitState("exited");
    const harness = serviceHarness({}, terminal.publish);
    return Effect.gen(function* () {
      const service = yield* BackgroundTerminalService;
      const started = yield* service.start({ command: "watch", cwd: ".", name: "watcher" });
      expect(started).toMatchObject({ id: "term-1", state: "running", pid: 10_000 });

      const waiting = yield* service
        .logs({ id: started.id, waitSeconds: 30 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      harness.controls[0]?.offer("stdout", "ready\n");
      const logs = yield* Fiber.join(waiting);
      expect(logs.events.map((event) => event.text).join("")).toContain("ready");

      harness.controls[0]?.complete();
      yield* Deferred.await(terminal.reached);
      expect(yield* service.status(started.id)).toMatchObject({ state: "exited", exitCode: 0 });
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("stops a process tree idempotently", () => {
    const terminal = awaitState("stopped");
    const harness = serviceHarness({}, terminal.publish);
    return Effect.gen(function* () {
      const service = yield* BackgroundTerminalService;
      const started = yield* service.start({ command: "server", cwd: "." });
      const stopped = yield* service.stop(started.id);
      expect(stopped.state).toBe("stopped");
      expect(harness.controls[0]?.modes).toEqual(["graceful"]);
      expect((yield* service.stop(started.id)).state).toBe("stopped");
      expect(harness.controls[0]?.modes).toEqual(["graceful"]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("escalates graceful stop after the configured grace period", () => {
    const harness = serviceHarness({ stopGraceMs: 2_000 }, () => {}, { completeOnGraceful: false });
    return Effect.gen(function* () {
      const service = yield* BackgroundTerminalService;
      const started = yield* service.start({ command: "server", cwd: "." });
      const stopping = yield* service
        .stop(started.id)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.yieldNow;
      expect(harness.controls[0]?.modes).toEqual(["graceful"]);
      yield* TestClock.adjust("2 seconds");
      expect((yield* Fiber.join(stopping)).state).toBe("stopped");
      expect(harness.controls[0]?.modes).toEqual(["graceful", "force"]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("bounds forced settlement when a process never reports exit", () => {
    const harness = serviceHarness({ stopGraceMs: 0 }, () => {}, {
      completeOnGraceful: false,
      completeOnForce: false,
    });
    return Effect.gen(function* () {
      const service = yield* BackgroundTerminalService;
      const started = yield* service.start({ command: "server", cwd: "." });
      const stopping = yield* service
        .stop(started.id)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      const stopped = yield* Fiber.join(stopping);
      expect(stopped.state).toBe("stopped");
      expect(stopped.error).toMatch(/did not settle/);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("marks runtime timeouts without a default timeout", () => {
    const terminal = awaitState("timed_out");
    const harness = serviceHarness({}, terminal.publish);
    return Effect.gen(function* () {
      const service = yield* BackgroundTerminalService;
      const started = yield* service.start({ command: "server", cwd: ".", timeoutSeconds: 10 });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(terminal.reached);
      expect((yield* service.status(started.id)).state).toBe("timed_out");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("keeps an interrupted start owned by session shutdown", () => {
    const spawnGate = Deferred.makeUnsafe<void>();
    const harness = serviceHarness({}, () => {}, { spawnGate });
    return Effect.gen(function* () {
      const service = yield* BackgroundTerminalService;
      const starting = yield* service
        .start({ command: "server", cwd: "." })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(starting);
      yield* Deferred.succeed(spawnGate, undefined);
      expect((yield* service.stopAll()).map((job) => job.state)).toEqual(["stopped"]);
      expect(harness.controls[0]?.modes).toContain("graceful");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("updates snapshot metadata when the shared log budget evicts output", () => {
    const harness = serviceHarness({
      maxRunning: 2,
      logBufferBytesPerJob: 4_096,
      totalLogBufferBytes: 8_192,
    });
    return Effect.gen(function* () {
      const service = yield* BackgroundTerminalService;
      const first = yield* service.start({ command: "first", cwd: "." });
      const second = yield* service.start({ command: "second", cwd: "." });
      const firstLogs = yield* service
        .logs({ id: first.id, afterCursor: 0, waitSeconds: 30 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      harness.controls[0]?.offer("stdout", "a".repeat(3_000));
      yield* Fiber.join(firstLogs);
      const secondLogs = yield* service
        .logs({ id: second.id, afterCursor: 0, waitSeconds: 30 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      harness.controls[1]?.offer("stdout", "b".repeat(3_000));
      yield* Fiber.join(secondLogs);
      expect((yield* service.status(first.id)).droppedLogBytes).toBe(3_000);
      yield* service.stopAll();
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("terminates a late handle without resurrecting a bounded stop", () => {
    const spawnGate = Deferred.makeUnsafe<void>();
    const harness = serviceHarness({}, () => {}, { spawnGate });
    return Effect.gen(function* () {
      const service = yield* BackgroundTerminalService;
      const starting = yield* service
        .start({ command: "server", cwd: "." })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.yieldNow;
      const stopping = yield* service
        .stop("term-1")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(stopping)).state).toBe("stopped");
      yield* Deferred.succeed(spawnGate, undefined);
      yield* Deferred.await(harness.spawned);
      yield* Effect.yieldNow;
      expect((yield* service.status("term-1")).state).toBe("stopped");
      expect(harness.controls[0]?.modes).toContain("force");
      yield* Fiber.interrupt(starting);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("enforces active capacity", () => {
    const harness = serviceHarness({ maxRunning: 1 });
    return Effect.gen(function* () {
      const service = yield* BackgroundTerminalService;
      yield* service.start({ command: "first", cwd: "." });
      const second = yield* Effect.result(service.start({ command: "second", cwd: "." }));
      expect(second._tag).toBe("Failure");
      yield* service.stopAll();
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("terminates active jobs when the service scope closes", () => {
    const harness = serviceHarness();
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(harness.layer, scope);
      const service = Context.get(context, BackgroundTerminalService);
      yield* service.start({ command: "server", cwd: "." });
      yield* Scope.close(scope, Exit.void);
      expect(harness.controls[0]?.modes).toContain("graceful");
    });
  });
});
