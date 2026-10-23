import { assert, describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import {
  LocalProcess,
  LocalProcessError,
  type LocalProcessExit,
  type LocalProcessHandle,
} from "../src/boundary/local-process.ts";
import { normalizeConfig } from "../src/config/options.ts";
import { BackgroundTaskConfigStore } from "../src/config/store.ts";
import { BackgroundRuntimeClosedError } from "../src/task/errors.ts";
import { BackgroundTaskService } from "../src/task/service.ts";

const LIFETIMES = 6;
const BATCH_SIZE = 17;
type Behavior = "graceful" | "force" | "failure" | "delayed";

function processFixture(behavior: Behavior, gated = false) {
  const entered = Deferred.makeUnsafe<void>();
  const acquire = Deferred.makeUnsafe<void>();
  const graceful = Deferred.makeUnsafe<void>();
  const forced = Deferred.makeUnsafe<void>();
  const exited = Deferred.makeUnsafe<LocalProcessExit>();
  const released = Deferred.makeUnsafe<void>();
  const stopping = Deferred.makeUnsafe<void>();
  let acquisitions = 0;
  let releases = 0;
  let streams = 0;
  let releaseBeforeExit = false;
  let failTermination = behavior === "failure";
  const complete = () => Deferred.succeed(exited, { exitCode: null, signal: "SIGKILL" });
  const handle: LocalProcessHandle = {
    pid: 10_000,
    output: Stream.fromEffect(Deferred.await(exited)).pipe(
      Stream.drain,
      Stream.onStart(
        Effect.sync(() => {
          streams += 1;
        }),
      ),
      Stream.ensuring(
        Effect.sync(() => {
          streams -= 1;
        }),
      ),
    ),
    awaitExit: Deferred.await(exited),
    leaderExited: Deferred.isDone(exited),
    droppedOutputBytes: () => 0,
    abandonOutput: Effect.void,
    terminate: (mode) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(mode === "force" ? forced : graceful, undefined);
        if (failTermination) {
          return yield* LocalProcessError.make({
            operation: "terminate process tree",
            reason: "terminate",
            message: "Fixture termination failed.",
          });
        }
        if (behavior !== "delayed" && (behavior === "graceful" || mode === "force")) {
          yield* complete();
        }
        return undefined;
      }),
  };
  return {
    entered,
    acquire,
    graceful,
    forced,
    exited,
    released,
    stopping,
    complete,
    recover: () => {
      failTermination = false;
    },
    counts: () => ({ acquisitions, releases, streams, releaseBeforeExit }),
    spawn: Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      if (gated) yield* Deferred.await(acquire);
      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          acquisitions += 1;
          return handle;
        }),
        () =>
          Effect.gen(function* () {
            releaseBeforeExit ||= !Deferred.isDoneUnsafe(exited);
            releases += 1;
            yield* complete();
            yield* Deferred.succeed(released, undefined);
          }),
      );
    }),
  };
}

type ProcessFixture = ReturnType<typeof processFixture>;

const openService = (fixtures: ProcessFixture[]) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const fixture of fixtures) {
          fixture.recover();
          yield* Deferred.succeed(fixture.acquire, undefined);
          yield* fixture.complete();
        }
        yield* Scope.close(scope, Exit.void);
      }),
    );
    const fixturesByCommand = new Map(
      Arr.map(fixtures, (fixture, index) => [`fixture ${index}`, fixture]),
    );
    const dependencies = Layer.mergeAll(
      Layer.succeed(LocalProcess, {
        spawn: (request) => Effect.suspend(() => fixturesByCommand.get(request.command)!.spawn),
      }),
      Layer.succeed(
        BackgroundTaskConfigStore,
        normalizeConfig({
          maxRunning: BATCH_SIZE,
          maxRetained: BATCH_SIZE,
          stopGraceMs: 100,
        }),
      ),
      Path.layer,
    );
    const layer = BackgroundTaskService.layer({
      publish: (projection) => {
        for (const task of projection.tasks) {
          if (task.state === "stopping") {
            const fixture = fixturesByCommand.get(task.command);
            if (fixture) Deferred.doneUnsafe(fixture.stopping, Effect.void);
          }
        }
      },
    }).pipe(Layer.provide(dependencies));
    const context = yield* Layer.buildWithScope(layer, scope);
    return { scope, service: Context.get(context, BackgroundTaskService) };
  });

const expectReleased = (fixtures: ProcessFixture[]) => {
  for (const fixture of fixtures) {
    expect(fixture.counts()).toEqual({
      acquisitions: 1,
      releases: 1,
      streams: 0,
      releaseBeforeExit: false,
    });
  }
};

describe("background task lifecycle stress", () => {
  it.effect(
    "settles queued siblings across repeated mixed stopAll batches before reporting failures",
    () =>
      Effect.gen(function* () {
        for (let iteration = 0; iteration < LIFETIMES; iteration += 1) {
          const fixtures = Array.from({ length: BATCH_SIZE }, (_, index) =>
            processFixture(
              index === 0 || index === 16
                ? "failure"
                : index === 15
                  ? "delayed"
                  : (index + iteration) % 2 === 0
                    ? "graceful"
                    : "force",
            ),
          );
          const { scope, service } = yield* openService(fixtures);
          const tasks = yield* Effect.forEach(fixtures, (_, index) =>
            service.start({ command: `fixture ${index}`, cwd: "." }),
          );
          const batchSettled = yield* Deferred.make<void>();
          const stopping = yield* service
            .stopAll()
            .pipe(
              Effect.flip,
              Effect.ensuring(Deferred.succeed(batchSettled, undefined)),
              Effect.forkScoped,
            );
          yield* TestClock.adjust("1 second");
          yield* Deferred.await(fixtures[15]!.forced);
          expect(yield* service.status(tasks[15]!.id)).toMatchObject({ state: "stopping" });
          yield* TestClock.adjust("0 millis");
          expect(yield* Deferred.isDone(fixtures[15]!.exited)).toBe(false);
          expect(yield* Deferred.isDone(batchSettled)).toBe(false);
          yield* fixtures[15]!.complete();
          const failure = yield* Fiber.join(stopping);
          assert(Predicate.isTagged(failure, "BackgroundTerminationError"));
          expect(new Set(Str.split(failure.id, ", "))).toEqual(
            new Set([tasks[0]!.id, tasks[16]!.id]),
          );
          expect(
            Arr.sort(
              Arr.map(yield* service.list("active"), (task) => task.id),
              Order.String,
            ),
          ).toEqual(Arr.sort([tasks[0]!.id, tasks[16]!.id], Order.String));
          fixtures[0]!.recover();
          fixtures[16]!.recover();
          yield* service.stopAll(true);
          expect(yield* service.list("active")).toEqual([]);
          yield* Scope.close(scope, Exit.void);
          yield* Scope.close(scope, Exit.void);
          expectReleased(fixtures);
        }
      }),
  );

  it.effect(
    "shutdown cleans queued tasks after a batch caller is cancelled in repeated lifetimes",
    () =>
      Effect.gen(function* () {
        for (let iteration = 0; iteration < LIFETIMES; iteration += 1) {
          const fixtures = Array.from({ length: BATCH_SIZE }, () => processFixture("force"));
          const { scope, service } = yield* openService(fixtures);
          yield* Effect.forEach(fixtures, (_, index) =>
            service.start({ command: `fixture ${index}`, cwd: "." }),
          );
          const stopping = yield* service.stopAll().pipe(Effect.forkScoped);
          yield* Deferred.await(fixtures[0]!.graceful);
          yield* Fiber.interrupt(stopping);
          const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(closing);
          expect(yield* service.list("active")).toEqual([]);
          expectReleased(fixtures);
          expect(
            yield* service.start({ command: "closed", cwd: "." }).pipe(Effect.flip),
          ).toBeInstanceOf(BackgroundRuntimeClosedError);
        }
      }),
  );

  it.effect(
    "shutdown retains late acquisition after both start and stop callers are cancelled",
    () =>
      Effect.gen(function* () {
        for (let iteration = 0; iteration < LIFETIMES; iteration += 1) {
          const fixture = processFixture("force", true);
          const { scope, service } = yield* openService([fixture]);
          const starting = yield* service
            .start({ command: "fixture 0", cwd: "." })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(fixture.entered);
          yield* Fiber.interrupt(starting);
          const [task] = yield* service.list("active");
          expect(task?.state).toBe("starting");
          const stopping = yield* service.stop(task!.id).pipe(Effect.forkScoped);
          yield* Deferred.await(fixture.stopping);
          yield* Fiber.interrupt(stopping);
          expect(fixture.counts().acquisitions).toBe(0);
          const closing = yield* Scope.close(scope, Exit.void).pipe(
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Deferred.succeed(fixture.acquire, undefined);
          yield* Deferred.await(fixture.forced);
          yield* Fiber.join(closing);
          expect((yield* service.status(task!.id)).state).toBe("stopped");
          expectReleased([fixture]);
          yield* TestClock.adjust("10 seconds");
          expectReleased([fixture]);
        }
      }),
  );

  it.effect("fails a start whose spawn is still pending when its runtime closes", () =>
    Effect.gen(function* () {
      const fixture = processFixture("force", true);
      const { scope, service } = yield* openService([fixture]);
      const starting = yield* service
        .start({ command: "fixture 0", cwd: "." })
        .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(fixture.entered);
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* TestClock.adjust("11 seconds");
      yield* Fiber.join(closing);
      expect(yield* Fiber.join(starting)).toBeInstanceOf(BackgroundRuntimeClosedError);
      expect(fixture.counts().acquisitions).toBe(0);
    }),
  );
});
