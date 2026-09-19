import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { WriterLeaseService } from "../../src/boundary/writer-lease.ts";
import type { SubagentError } from "../../src/run/errors.ts";
import type { RunRecord } from "../../src/run/internal.ts";
import { makeRunRecordCleanup } from "../../src/run/record-cleanup.ts";
import type { WriterPoolEntry } from "../../src/run/writer-pool.ts";
import { emptyRunWarningSlots } from "../../src/run/warnings.ts";
import { fakeWriterLeaseLayer } from "./fixtures/service-harness.ts";

it.effect(
  "settles preparation cancelled immediately after its ownership claim and permits cwd reuse",
  () =>
    Effect.gen(function* () {
      const writerLeases = yield* WriterLeaseService;
      const cwd = yield* writerLeases.canonicalize("/project");
      const lock = yield* Semaphore.make(1);
      const claimed = yield* Deferred.make<void>();
      const continueClaim = yield* Deferred.make<void>();
      const pools = new Map<string, WriterPoolEntry>();
      const pool: WriterPoolEntry = {
        cwd,
        leaseScope: yield* Scope.make(),
        releaseState: { authorized: false },
        preparationSettled: yield* Deferred.make<void, SubagentError>(),
        members: new Map([["writer", undefined]]),
        violationRunIds: new Set(),
        state: "pending",
        admissionPaused: false,
      };
      pools.set(cwd.digest, pool);
      const record: RunRecord = {
        view: {
          id: "writer",
          name: "writer",
          task: "write",
          cwd: cwd.path,
          selection: { source: "profile-candidate", reason: "test", skippedCandidates: [] },
          state: "starting",
          context: "fresh",
          writeIntent: "writer",
          openaiFastMode: false,
          host: "local",
          runtime: "pi",
          closeOnReport: true,
          reportGeneration: 0,
          capabilities: [],
          model: "test/model",
          effort: "high",
          startedAt: 0,
          lastActivityAt: 0,
          sessionEvents: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        },
        scope: yield* Scope.make(),
        driver: {
          host: "local",
          runtime: "pi",
          capabilities: [],
          supportsContext: () => true,
          preflight: () => Effect.void,
          spawn: () => Effect.die("Unexpected spawn"),
        },
        launch: {
          runId: "writer",
          name: "writer",
          closeOnReport: true,
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
        nativeAgents: new Map(),
        nativeAgentTotal: 0,
        cleanupSettlement: yield* Deferred.make<"confirmed" | "quarantined">(),
        cleanupDisposition: "pending",
        retryExhausted: false,
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
        warningSlots: emptyRunWarningSlots(),
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
      let pauseClaim = true;
      const cleanup = makeRunRecordCleanup({
        writerLeases,
        writerPools: pools,
        publish: Effect.void,
        withLock: (effect) =>
          lock.withPermit(effect).pipe(
            Effect.tap(() => {
              // Pause after pending → preparing, before the caller installs its handler.
              if (!pauseClaim || pool.state !== "preparing") return Effect.void;
              pauseClaim = false;
              return Deferred.succeed(claimed, undefined).pipe(
                Effect.andThen(Deferred.await(continueClaim)),
              );
            }),
          ),
      });
      const preparing = yield* cleanup.prepareWriterLeaseForSpawn(record).pipe(Effect.forkScoped);
      yield* Deferred.await(claimed);
      preparing.interruptUnsafe();
      yield* Deferred.succeed(continueClaim, undefined);
      expect(Exit.isFailure(yield* Fiber.await(preparing))).toBe(true);
      // Assert before cleanup so the old leak fails directly, not by a timeout.
      expect(yield* Deferred.isDone(pool.preparationSettled)).toBe(true);
      yield* cleanup.closeRecordScope(record);
      expect(record.cleanupDisposition).toBe("confirmed");
      expect(record.writerPool).toBeUndefined();
      expect(pools.has(cwd.digest)).toBe(false);

      const replacement: WriterPoolEntry = {
        ...pool,
        state: "pending",
        lease: undefined,
        leaseScope: yield* Scope.make(),
        releaseState: { authorized: false },
        preparationSettled: yield* Deferred.make<void, SubagentError>(),
        members: new Map([[record.view.id, undefined]]),
      };
      record.writerPool = replacement;
      record.scope = yield* Scope.make();
      pools.set(cwd.digest, replacement);
      yield* cleanup.prepareWriterLeaseForSpawn(record);
      expect(replacement.state).toBe("held");
      yield* cleanup.closeRecordScope(record);
      expect(pools.has(cwd.digest)).toBe(false);
    }).pipe(Effect.provide(fakeWriterLeaseLayer())),
);
