import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { BackendDriver } from "../../src/backend/model.ts";
import { backendRegistryFor, SubagentBackendRegistry } from "../../src/backend/service.ts";
import { SubagentProcessError, SubagentWriterConflictError } from "../../src/run/errors.ts";
import type { StartSubagentRequest, SubagentProjection } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  completeLocalRun,
  fakeChildLayer,
  fakeWriterLeaseLayer,
  leaseCounts,
  localServiceFixture,
  profileLayerFor,
  request,
  withService,
} from "./fixtures/service-harness.ts";

const leaseFixture = (
  leases: Parameters<typeof fakeWriterLeaseLayer>[0],
  fake = fakeChildLayer(),
) => localServiceFixture({}, fake, profileLayerFor({}), fakeWriterLeaseLayer(leases));

const writer = (name: string, overrides: Partial<StartSubagentRequest> = {}) =>
  request({ name, writeIntent: "writer", ...overrides });

describe("SubagentService", () => {
  it.effect(
    "quarantines a spawn-started writer when a failed local native acquisition owns uncertain cleanup",
    () => {
      const counts = leaseCounts();
      const projections: SubagentProjection[] = [];
      const driver: BackendDriver = {
        runtime: "pi",
        capabilities: ["steer"],
        supportsContext: (context) => context === "fresh",
        preflight: () => Effect.void,
        spawn: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.fail(
                new SubagentProcessError({
                  operation: "finalize local native launch",
                  code: "process_cleanup_unconfirmed",
                  message: "Fixture applied start and failed rollback cleanup.",
                }),
              ).pipe(Effect.orDie),
            );
            return yield* new SubagentProcessError({
              operation: "launch local native agent",
              code: "transport_outcome_uncertain",
              message: "Fixture local native start may have applied.",
            });
          }),
      };
      const registry = Layer.succeed(SubagentBackendRegistry, backendRegistryFor([driver]));
      const leases = fakeWriterLeaseLayer({ counts });
      const layer = SubagentService["layer"]({
        writerWorkspaceMode: "shared-checkout",
        publish: (projection) => projections.push(projection),
      }).pipe(
        Layer.provide(Layer.merge(registry, leases)),
        Layer.provideMerge(profileLayerFor({})),
      );
      return withService(layer, function* (service) {
        const failure = yield* service
          .start(
            request({
              runtime: "pi",
              writeIntent: "writer",
              name: "uncertain-local-writer",
            }),
          )
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ code: "transport_outcome_uncertain" });
        expect(counts.release).toBe(0);
        expect(projections.at(-1)?.runs[0]).toMatchObject({
          state: "failed",
          cleanup: {
            disposition: "quarantined",
            recovery: "manual",
            diagnostic: { phase: "backend-scope" },
          },
          writerCleanupQuarantined: true,
        });
        const conflict = yield* service
          .start(
            request({
              runtime: "pi",
              name: "replacement",
              writeIntent: "writer",
            }),
          )
          .pipe(Effect.flip);
        expect(conflict).toBeInstanceOf(SubagentWriterConflictError);
      });
    },
  );

  it.effect("shuts down without waiting for pre-ownership writer acquisition", () =>
    Effect.gen(function* () {
      const acquireGate = yield* Deferred.make<void>();
      const acquireStarted = yield* Deferred.make<void>();
      const counts = leaseCounts();
      const { fake, layer } = leaseFixture({
        acquireGate,
        counts,
        onAcquireStarted: () => Deferred.doneUnsafe(acquireStarted, Effect.void),
      });

      yield* withService(layer, function* (service) {
        yield* service
          .startSessionOwned(writer("shutdown-start-boundary"))
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(acquireStarted);
      });

      expect(fake.controls).toHaveLength(0);
      expect(counts.release).toBe(0);
    }),
  );

  it.effect("registers cleanup before interruption can cross the writer acquisition handoff", () =>
    Effect.gen(function* () {
      const acquireGate = yield* Deferred.make<void>();
      const acquireStarted = yield* Deferred.make<void>();
      const counts = leaseCounts();
      const { fake, projections, layer } = leaseFixture({
        acquireGate,
        acquireUninterruptible: true,
        counts,
        onAcquireStarted: () => Deferred.doneUnsafe(acquireStarted, Effect.void),
      });

      yield* withService(layer, function* (service) {
        const starting = yield* service
          .start(writer("commit-interrupted-writer"))
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(acquireStarted);
        const interrupting = yield* Fiber.interrupt(starting).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(acquireGate, undefined);
        yield* Fiber.join(interrupting);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopped");
        expect(fake.controls).toHaveLength(0);
        expect(counts.release).toBe(1);
      });
    }),
  );

  it.effect("resumes a completed writer while another writer shares the cwd", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const first = yield* service.start(writer("writer-one", { task: "Implement auth" }));
      fake.controls[0]?.settle();
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      const second = yield* service.start(writer("writer-two", { task: "Implement tests" }));

      const resumed = yield* service.resume(first.id, "Make another edit");
      expect(resumed.state).toBe("running");
      expect((yield* service.status(second.id)).state).toBe("running");
    });
  });

  it.effect("acquires before spawn and releases only after backend cleanup confirms", () => {
    const order: string[] = [];
    const { layer } = leaseFixture(
      {
        onAcquire: () => void order.push("lease-acquire"),
        onMark: () => void order.push("lease-spawn-started"),
        onRelease: () => void order.push("lease-release"),
      },
      fakeChildLayer(
        Effect.sync(() => void order.push("spawn")),
        { onRelease: () => void order.push("backend") },
      ),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(writer("ordered-writer"));
      expect(order).toEqual(["lease-acquire", "lease-spawn-started", "spawn"]);
      yield* service.stop(run.id);
      expect(order).toEqual([
        "lease-acquire",
        "lease-spawn-started",
        "spawn",
        "backend",
        "lease-release",
      ]);
    });
  });

  it.effect("does not spawn when the durable spawn-started mark fails", () => {
    const order: string[] = [];
    const { fake, layer } = leaseFixture(
      {
        failMark: true,
        onAcquire: () => void order.push("lease-acquire"),
        onMark: () => void order.push("lease-mark-attempt"),
        onRelease: () => void order.push("lease-release"),
      },
      fakeChildLayer(Effect.sync(() => void order.push("spawn"))),
    );
    return withService(layer, function* (service) {
      const failure = yield* service.start(writer("mark-failure-writer")).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(SubagentProcessError);
      expect(failure).toMatchObject({ code: "writer_lease_mark_failed" });
      expect(order).toEqual(["lease-acquire", "lease-mark-attempt", "lease-release"]);
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([
        expect.objectContaining({ name: "mark-failure-writer", state: "failed" }),
      ]);
    });
  });

  it.effect("quarantines the session and retains ownership when lease release fails", () => {
    const counts = leaseCounts();
    const { fake, layer } = leaseFixture({ failRelease: true, counts });
    return withService(layer, function* (service) {
      const run = yield* service.start(writer("release-failure-writer"));
      const stopped = yield* service.stop(run.id);
      expect(fake.controls[0]?.released()).toBe(1);
      expect(counts.release).toBe(1);
      expect(stopped).toMatchObject({
        state: "stopped",
        cleanup: {
          disposition: "quarantined",
          recovery: "manual",
          diagnostic: { phase: "writer-lease" },
        },
        writerCleanupQuarantined: true,
      });
      const conflict = yield* service
        .start(writer("blocked-after-release-failure"))
        .pipe(Effect.flip);
      expect(conflict).toBeInstanceOf(SubagentWriterConflictError);
      expect(conflict).toMatchObject({ activeId: run.id });
      expect(fake.controls).toHaveLength(1);
    });
  });

  it.effect("closes every owned writer lease after backend cleanup on session shutdown", () => {
    const order: string[] = [];
    const { layer } = leaseFixture(
      { onRelease: (lease) => void order.push(`lease-${lease.runId}`) },
      fakeChildLayer(Effect.void, {
        onRelease: (index) => void order.push(`backend-${index}`),
      }),
    );
    return Effect.gen(function* () {
      const ids = yield* withService(layer, function* (service) {
        const first = yield* service.start(writer("shutdown-one", { cwd: "/project-one" }));
        const second = yield* service.start(writer("shutdown-two", { cwd: "/project-two" }));
        return [first.id, second.id] as const;
      });
      for (const [index, id] of ids.entries()) {
        const backendIndex = order.indexOf(`backend-${index}`);
        const leaseIndex = order.indexOf(`lease-${id}`);
        expect(backendIndex).toBeGreaterThanOrEqual(0);
        expect(leaseIndex).toBeGreaterThan(backendIndex);
      }
    });
  });

  it.effect(
    "shares one cwd lease across shared-checkout writers, resumes included, until the last",
    () => {
      const counts = leaseCounts();
      const { fake, layer } = leaseFixture({ counts });
      return withService(layer, function* (service) {
        const first = yield* service.start(writer("shared-first"));
        const second = yield* service.start(writer("shared-peer"));
        expect(second.state).toBe("running");
        yield* completeLocalRun(service, fake.controls[0]!, first.id);
        expect(counts.release).toBe(0);

        const resumed = yield* service.resume(first.id, "Continue on the first file.");
        expect(resumed.state).toBe("running");
        expect(fake.controls).toHaveLength(3);
        expect(counts.acquire).toBe(1);
        expect(counts.mark).toBe(1);
        yield* service.stop(first.id);
        expect(counts.release).toBe(0);
        yield* service.stop(second.id);
        expect(counts.release).toBe(1);
      });
    },
  );

  it.effect("admits several shared-checkout writers in one cwd without file claims", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const runs = [
        yield* service.start(writer("shared-auth", { task: "Implement auth" })),
        yield* service.start(writer("shared-tests", { task: "Implement auth tests" })),
        yield* service.start(writer("shared-docs", { task: "Document auth" })),
      ];
      expect(runs.map((run) => run.state)).toEqual(["running", "running", "running"]);
      expect(new Set(runs.map((run) => run.cwd)).size).toBe(1);
    });
  });

  it.effect("refuses a writer when another process holds the cwd's writer lease", () => {
    const counts = leaseCounts();
    const { fake, layer } = leaseFixture({ counts, failAcquire: true });
    return withService(layer, function* (service) {
      const conflict = yield* service.start(writer("cross-process-blocked")).pipe(Effect.flip);
      expect(conflict).toBeInstanceOf(SubagentWriterConflictError);
      expect(fake.controls).toHaveLength(0);
      expect(counts.acquire).toBe(0);
      // Once the other process lets go, writers in this process are admitted again.
      const admitted = yield* service.start(writer("cross-process-admitted"));
      expect(admitted.state).toBe("running");
      expect(counts.acquire).toBe(1);
    });
  });
});
