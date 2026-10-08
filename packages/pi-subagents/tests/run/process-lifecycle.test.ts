import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import { interruptingScheduler, yieldUntil } from "pi-cosmic-core/testing";
import type { BackendEvent, BackendHandle } from "../../src/backend/model.ts";
import { WriterLeaseService } from "../../src/boundary/writer-lease.ts";
import type { RunContext, RunRecord } from "../../src/run/internal.ts";
import { makeRunProcessInitializer } from "../../src/run/process-lifecycle.ts";
import { makeRunRecordCleanup } from "../../src/run/record-cleanup.ts";
import { makeWriterPreparation } from "../../src/run/writer-preparation.ts";
import { addWriterPoolMemberLocked } from "../../src/run/writer-pool.ts";
import { view } from "../fixtures/run-view.ts";
import { testBackendDriver } from "../tools/fixtures/tool-harness.ts";
import { makeRunContext } from "./fixtures/run-context.ts";
import { fakeWriterLeaseLayer, leaseCounts } from "./fixtures/service-harness.ts";

const processFixture = () =>
  Effect.gen(function* () {
    const writerLeases = yield* WriterLeaseService;
    const cwd = yield* writerLeases.canonicalize("/project");
    const owner = yield* Scope.fork(yield* Effect.scope);
    const context = yield* makeRunContext({ ownerScope: owner, writerLeases });
    const counts = { spawned: 0, released: 0 };
    const driver = {
      ...testBackendDriver,
      spawn: () =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            counts.spawned++;
            const events = yield* Queue.unbounded<BackendEvent, Cause.Done>();
            const handle: BackendHandle = {
              events,
              awaitExit: Effect.never,
              acknowledge: () => {},
              cancelPending: () => {},
              terminate: () => Effect.void,
              controls: {
                initialize: Effect.succeed({ effort: "high", sessionId: "fixture" }),
                start: () => Effect.void,
                steer: () => Effect.void,
                interrupt: Effect.void,
                renameDisplay: () => Effect.void,
                reply: () => Effect.void,
                notifyPeers: () => Effect.void,
              },
            };
            return handle;
          }),
          () => Effect.sync(() => void counts.released++),
        ),
    };
    // Each flow removes the cwd's pool before admitting its next writer, which gets a fresh one.
    const newRecord = (id: string) =>
      Effect.gen(function* () {
        const pool = yield* addWriterPoolMemberLocked(context.writerPools, cwd, id);
        const record: RunRecord = {
          scriptOrigin: false,
          view: view({ id, name: id, state: "starting", writeIntent: "writer", capabilities: [] }),
          scope: yield* Scope.fork(owner),
          driver,
          launch: {
            runId: id,
            name: id,
            cwd: cwd.path,
            context: "fresh",
            writeIntent: "writer",
            openaiFastMode: false,
            model: "test/model",
            effort: "high",
            activeTools: [],
            projectTrusted: true,
            parentSessionId: "parent",
            systemPrompt: "",
          },
          activeTools: new Map(),
          nativeAgents: new Set(),
          cleanupSettlement: yield* Deferred.make<"confirmed" | "quarantined">(),
          cleanupDisposition: "pending",
          pauseRequested: false,
          stoppedByParent: false,
          cleanupPending: false,
          runStateReclaimState: "pending",
          canonicalWriterCwd: cwd,
          writerPool: pool,
          writeViolationContainmentStarted: false,
          initializationPending: false,
          notificationGeneration: 0,
          completionGeneration: 0,
          warningSlots: {},
          completionGenerations: new Map(),
          completionClaims: new Map(),
          assignment: {
            epoch: 1,
            phase: "preparing",
            attemptToken: "test",
            startedObserved: false,
            outcomeUncertain: false,
            pendingRunSettled: false,
          },
          nextAssignmentEpoch: 2,
        };
        return record;
      });
    return { context, owner, counts, newRecord };
  });

const initializer = (context: RunContext, prepareBackendSpawn = makeWriterPreparation(context)) => {
  const cleanup = makeRunRecordCleanup(context);
  return makeRunProcessInitializer({
    ...context,
    ...cleanup,
    prepareBackendSpawn,
    initialize: (record) => Effect.suspend(() => record.process!.controls.initialize),
    handleBackendEvent: () => Effect.void,
    failRun: (record) => Effect.succeed(record.view),
  });
};

/** `context` with its lock pausing once, on leaving the first locked step after which `reached`. */
const pauseOnceAfterLock = (context: RunContext, reached: () => boolean) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let pending = true;
    const paused: RunContext = {
      ...context,
      withLock: (effect) =>
        context.withLock(effect).pipe(
          Effect.tap(() => {
            if (!pending || !reached()) return Effect.void;
            pending = false;
            return Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            );
          }),
        ),
    };
    return { context: paused, entered, release };
  });

it.effect(
  "settles preparation cancelled right after its ownership claim and permits cwd reuse",
  () =>
    Effect.gen(function* () {
      const fixture = yield* processFixture();
      const record = yield* fixture.newRecord("writer");
      const pool = record.writerPool!;
      // Pause after pending → preparing, before the caller installs its handler.
      const claim = yield* pauseOnceAfterLock(fixture.context, () => pool.state === "preparing");
      const context = claim.context;
      const cleanup = makeRunRecordCleanup(context);
      const preparing = yield* makeWriterPreparation(context)(record).pipe(Effect.forkScoped);
      yield* Deferred.await(claim.entered);
      preparing.interruptUnsafe();
      yield* Deferred.succeed(claim.release, undefined);
      expect(Exit.isFailure(yield* Fiber.await(preparing))).toBe(true);
      // Assert before cleanup so the old leak fails directly, not by a timeout.
      expect(yield* Deferred.isDone(pool.preparationSettled)).toBe(true);
      yield* cleanup.closeRecordScope(record);
      expect(record.cleanupDisposition).toBe("confirmed");
      expect(record.writerPool).toBeUndefined();
      expect(fixture.context.writerPools.size).toBe(0);

      const replacement = yield* fixture.newRecord("replacement");
      yield* makeWriterPreparation(context)(replacement);
      expect(replacement.writerPool?.state).toBe("held");
      yield* cleanup.closeRecordScope(replacement);
      expect(fixture.context.writerPools.size).toBe(0);
    }).pipe(Effect.provide(fakeWriterLeaseLayer())),
);

it.effect("settles an interrupted spawn claim before stop, compensation and session cleanup", () =>
  Effect.gen(function* () {
    const leases = leaseCounts();
    yield* Effect.gen(function* () {
      const fixture = yield* processFixture();
      const record = yield* fixture.newRecord("writer");
      // Pause exactly after claim publication, before returning to the driver.
      const claim = yield* pauseOnceAfterLock(
        fixture.context,
        () => record.backendSpawnAttempt !== undefined,
      );
      const context = claim.context;
      const cleanup = makeRunRecordCleanup(context);
      const starting = yield* initializer(context)(record).pipe(Effect.forkScoped);
      yield* Deferred.await(claim.entered);
      const spawnSettlement = record.backendSpawnAttempt!.settled;
      record.stoppedByParent = true;
      record.view = { ...record.view, state: "stopping" };
      const stopping = yield* cleanup.closeRecordScope(record).pipe(Effect.forkScoped);
      yield* yieldUntil(() => record.closingScope === record.scope);
      expect(stopping.pollUnsafe()).toBeUndefined();
      starting.interruptUnsafe();
      yield* Deferred.succeed(claim.release, undefined);
      expect(Exit.isFailure(yield* Fiber.await(starting))).toBe(true);
      // Fail directly on the old handoff leak before entering a cleanup join.
      expect(yield* Deferred.isDone(spawnSettlement)).toBe(true);
      expect(record.backendSpawnAttempt).toBeUndefined();
      expect(fixture.counts.spawned).toBe(0);
      yield* Fiber.join(stopping);
      yield* cleanup.closeRecordScope(record); // Launch compensation joins the same owner.
      expect(record.cleanupDisposition).toBe("confirmed");
      expect(record.writerPool).toBeUndefined();
      expect(fixture.context.writerPools.size).toBe(0);
      expect(leases.release).toBe(1);
      expect(yield* initializer(context)(record).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
      expect(fixture.counts.spawned).toBe(0);

      const replacement = yield* fixture.newRecord("replacement");
      yield* initializer(context)(replacement);
      expect(fixture.counts.spawned).toBe(1);
      replacement.stoppedByParent = true;
      yield* cleanup.closeRecordScope(replacement);
      yield* Scope.close(fixture.owner, Exit.void);
      expect(fixture.counts).toEqual({ spawned: 1, released: 1 });
      expect(leases.release).toBe(2);
      expect(fixture.context.writerPools.size).toBe(0);
    }).pipe(Effect.provide(fakeWriterLeaseLayer({ counts: leases })));
  }),
);

it.effect("cancels spawn admission while the registry permit remains held", () =>
  Effect.gen(function* () {
    const fixture = yield* processFixture();
    const record = yield* fixture.newRecord("waiting-writer");
    yield* makeWriterPreparation(fixture.context)(record);
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const holding = yield* fixture.context
        .withLock(Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      let admissionWaiting = false;
      const context: RunContext = {
        ...fixture.context,
        withLock: (effect) =>
          Effect.sync(() => void (admissionWaiting = true)).pipe(
            Effect.andThen(fixture.context.withLock(effect)),
          ),
      };
      // Lease preparation already finished; only spawn admission may enter the lock.
      const starting = yield* initializer(
        context,
        () => Effect.void,
      )(record).pipe(Effect.forkScoped);
      yield* yieldUntil(() => admissionWaiting);
      expect(record.backendSpawnAttempt).toBeUndefined();
      starting.interruptUnsafe();
      yield* yieldUntil(() => starting.pollUnsafe() !== undefined);
      expect(Exit.isFailure(yield* Fiber.await(starting))).toBe(true);
      expect(holding.pollUnsafe()).toBeUndefined();
      expect(record.backendSpawnAttempt).toBeUndefined();
      expect(fixture.counts.spawned).toBe(0);
      expect(record.process).toBeUndefined();
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    record.stoppedByParent = true;
    yield* makeRunRecordCleanup(fixture.context).closeRecordScope(record);
    yield* Scope.close(fixture.owner, Exit.void);
    expect(record.cleanupDisposition).toBe("confirmed");
    expect(fixture.context.writerPools.size).toBe(0);
    expect(fixture.counts).toEqual({ spawned: 0, released: 0 });
  }).pipe(Effect.provide(fakeWriterLeaseLayer())),
);

it.effect("spawn ownership remains reusable across scheduler interruption checkpoints", () =>
  Effect.gen(function* () {
    for (let interruptAt = 1; interruptAt <= 160; interruptAt++) {
      const fixture = yield* processFixture();
      const record = yield* fixture.newRecord(`writer-${interruptAt}`);
      // Isolate the spawn handoff from already-tested lease preparation.
      yield* makeWriterPreparation(fixture.context)(record);
      let checkpoints = 0;
      const scheduler = interruptingScheduler(
        () => fixture.counts.spawned === 0 && ++checkpoints === interruptAt,
      );
      const starting = yield* initializer(fixture.context)(record).pipe(
        Effect.provideService(Scheduler.Scheduler, scheduler),
        Effect.forkScoped,
      );
      yield* Fiber.await(starting);
      expect(record.backendSpawnAttempt, `interruption checkpoint ${interruptAt}`).toBeUndefined();
      record.stoppedByParent = true;
      const cleanup = makeRunRecordCleanup(fixture.context);
      let compensated = false;
      const compensation = yield* cleanup.closeRecordScope(record).pipe(
        Effect.tap(() => Effect.sync(() => void (compensated = true))),
        Effect.forkScoped,
      );
      yield* yieldUntil(() => compensated);
      yield* Fiber.join(compensation);
      expect(record.cleanupDisposition).toBe("confirmed");
      expect(fixture.context.writerPools.size).toBe(0);
      const replacement = yield* fixture.newRecord(`replacement-${interruptAt}`);
      yield* initializer(fixture.context)(replacement);
      replacement.stoppedByParent = true;
      yield* cleanup.closeRecordScope(replacement);
      yield* Scope.close(fixture.owner, Exit.void);
      expect(fixture.counts.released).toBe(fixture.counts.spawned);
    }
  }).pipe(Effect.provide(fakeWriterLeaseLayer())),
);
