// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { BackendDriver } from "../../src/backend/model.ts";
import { makeSubagentBackendRegistry, SubagentBackendRegistry } from "../../src/backend/service.ts";
import { SubagentProcessError } from "../../src/run/errors.ts";
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
  serviceLayer,
  withService,
} from "./fixtures/service-harness.ts";

/** A local service whose writer-lease fake takes `leases`. */
const leaseFixture = (
  leases: Parameters<typeof fakeWriterLeaseLayer>[0],
  fake = fakeChildLayer(),
) => localServiceFixture({}, fake, profileLayerFor({}), fakeWriterLeaseLayer(leases));

const writer = (name: string, overrides: Partial<StartSubagentRequest> = {}) =>
  request({ name, writeIntent: "writer", ...overrides });

const claimedWriter = (name: string, writes: ReadonlyArray<string>) =>
  writer(name, { writes: [...writes] });

describe("SubagentService", () => {
  it.effect(
    "quarantines a spawn-started writer when a failed local native acquisition owns uncertain cleanup",
    () => {
      const counts = leaseCounts();
      const projections: SubagentProjection[] = [];
      const driver: BackendDriver = {
        host: "local",
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
      const registry = Layer.succeed(
        SubagentBackendRegistry,
        makeSubagentBackendRegistry([driver]),
      );
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
              host: "local",
              runtime: "pi",
              writeIntent: "writer",
              closeOnReport: true,
              name: "uncertain-local-writer",
            }),
          )
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ code: "transport_outcome_uncertain" });
        expect(counts.release).toBe(0);
        expect(projections.at(-1)?.runs[0]).toMatchObject({
          state: "failed",
          warning: expect.stringContaining("ownership remain quarantined"),
        });
        const conflict = yield* service
          .start(
            request({
              host: "local",
              runtime: "pi",
              name: "replacement",
              writeIntent: "writer",
            }),
          )
          .pipe(Effect.flip);
        expect(conflict).toMatchObject({ _tag: "SubagentWriterConflictError" });
      });
    },
  );

  it.effect("quarantines a writer when awaitExit failure finalization defects", () => {
    const { fake, projections, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, { releaseDefect: true }),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(writer("await-failure-defect"));
      fake.controls[0]?.failExit("Fixture awaitExit failure.");
      yield* yieldUntil(
        () =>
          projections
            .at(-1)
            ?.runs.some(
              (candidate) =>
                candidate.id === run.id &&
                candidate.state === "failed" &&
                candidate.warning?.includes("ownership remain quarantined") === true,
            ) === true,
      );

      const conflict = yield* service.start(writer("blocked-writer")).pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: run.id,
        message: expect.stringContaining("cleanup could not be confirmed"),
      });
      expect(fake.controls).toHaveLength(1);
    });
  });

  it.effect(
    "settles writer preparation when interruption is already queued at the start boundary",
    () => {
      const fake = fakeChildLayer();
      const projections: SubagentProjection[] = [];
      let interruptAtBoundary: () => void = () => undefined;
      const layer = serviceLayer({
        publish: (projection) => {
          projections.push(projection);
          if (projection.runs[0]?.state === "starting") interruptAtBoundary();
        },
      }).pipe(Layer.provide(fake.layer));
      return withService(layer, function* (service) {
        const starting = yield* service
          .start(writer("boundary-interrupted-writer"))
          .pipe(Effect.forkScoped({ startImmediately: false }));
        interruptAtBoundary = () => starting.interruptUnsafe();
        const interrupted = yield* Fiber.await(starting);
        expect(Exit.isFailure(interrupted)).toBe(true);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopped");
        expect(fake.controls).toHaveLength(0);

        const replacement = yield* service.start(writer("after-boundary-interrupt"));
        expect(replacement.state).toBe("running");
        expect(fake.controls).toHaveLength(1);
        yield* service.stop(replacement.id);
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

  it.effect("does not resume a completed writer while another writer owns the cwd", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const first = yield* service.start(writer("writer-one", { task: "Implement auth" }));
      fake.controls[0]?.settle();
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* service.start(writer("writer-two", { task: "Implement tests" }));

      const conflict = yield* Effect.flip(service.resume(first.id, "Make another edit"));
      expect(conflict._tag).toBe("SubagentWriterConflictError");
    });
  });

  it.effect("resolves completed-writer resume uncertainty and releases ownership on exit", () => {
    const { fake, projections, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, {
        initialTransportFailures: [
          { spawnIndex: 1, type: "prompt", code: "transport_outcome_uncertain" },
        ],
      }),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(writer("uncertain-completed-writer"));
      yield* completeLocalRun(service, fake.controls[0]!, run.id, "First writer turn complete.");

      const failure = yield* service.resume(run.id, "Continue writer work.").pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "resume_outcome_uncertain" });
      expect(fake.controls).toHaveLength(2);
      expect((yield* service.status(run.id)).state).toBe("starting");

      fake.controls[1]?.exit(1);
      yield* yieldUntil(() =>
        Boolean(
          projections
            .at(-1)
            ?.runs.some((candidate) => candidate.id === run.id && candidate.state === "failed"),
        ),
      );
      yield* yieldUntil(() => fake.controls[1]?.released() === 1);
      expect(fake.controls).toHaveLength(2);

      const replacement = yield* service.start(writer("replacement-writer"));
      expect(replacement.state).toBe("running");
      expect(fake.controls).toHaveLength(3);
    });
  });

  for (const { name, leases, cwds } of [
    {
      name: "keys the fast in-memory writer guard by canonical cwd aliases",
      leases: { canonicalize: (cwd: string) => (cwd === "/project-alias" ? "/project" : cwd) },
      cwds: ["/project", "/project-alias"],
    },
    {
      name: "keys the fast writer guard by filesystem identity even when canonical paths differ",
      leases: {
        filesystemIdentity: (cwd: string) =>
          cwd === "/project-before-rename" || cwd === "/project-after-rename"
            ? "dev:1;ino:2"
            : `dev:1;ino:${cwd}`,
      },
      cwds: ["/project-before-rename", "/project-after-rename"],
    },
  ] as const)
    it.effect(name, () => {
      const counts = leaseCounts();
      const { layer } = leaseFixture({ ...leases, counts });
      return withService(layer, function* (service) {
        const first = yield* service.start(writer("guarded-writer", { cwd: cwds[0] }));
        const aliasConflict = yield* service
          .start(writer("alias-writer", { cwd: cwds[1] }))
          .pipe(Effect.flip);
        expect(aliasConflict).toMatchObject({
          _tag: "SubagentWriterConflictError",
          activeId: first.id,
        });
        expect(counts.acquire).toBe(1);

        const other = yield* service.start(writer("other-cwd-writer", { cwd: "/other-project" }));
        expect(other.state).toBe("running");
        expect(counts.acquire).toBe(2);
        yield* service.stop(first.id);
        yield* service.stop(other.id);
      });
    });

  it.effect("rejects Windows writers before canonicalization, lease acquisition, or spawn", () => {
    const counts = leaseCounts();
    const { fake, layer } = leaseFixture({ platform: "win32", counts });
    return withService(layer, function* (service) {
      const failure = yield* service.start(writer("windows-writer")).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "UnsupportedSafeWriterOwnershipError",
        code: "unsupported_safe_writer_ownership",
        platform: "win32",
      });
      expect(counts.canonicalize).toBe(0);
      expect(counts.acquire).toBe(0);
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([]);

      const reader = yield* service.start(
        request({ name: "windows-reader", writeIntent: "read-only" }),
      );
      expect(reader.state).toBe("running");
      expect(fake.controls).toHaveLength(1);
      yield* service.stop(reader.id);
    });
  });

  it.effect("does not canonicalize or acquire a lease for read-only runs", () => {
    const counts = leaseCounts();
    const { layer } = leaseFixture({ counts });
    return withService(layer, function* (service) {
      const reader = yield* service.start(request({ name: "reader", writeIntent: "read-only" }));
      expect(reader.state).toBe("running");
      expect(counts.canonicalize).toBe(0);
      expect(counts.acquire).toBe(0);
      yield* service.stop(reader.id);
    });
  });

  it.effect("fails typed writer canonicalization before reservation or backend spawn", () => {
    const { fake, layer } = leaseFixture({ failCanonicalization: true });
    return withService(layer, function* (service) {
      const failure = yield* service.start(writer("bad-cwd-writer")).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "writer_cwd_canonicalization_failed",
      });
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([]);
    });
  });

  it.effect(
    "settles a failed cross-process reservation without spawning or retaining the slot",
    () => {
      const { fake, layer } = leaseFixture({ failAcquire: true });
      return withService(layer, function* (service) {
        const conflict = yield* service.start(writer("cross-process-conflict")).pipe(Effect.flip);
        expect(conflict).toMatchObject({
          _tag: "SubagentWriterConflictError",
          activeId: "unknown-cross-process-writer",
        });
        expect(fake.controls).toHaveLength(0);
        expect(yield* service.list).toEqual([
          expect.objectContaining({ name: "cross-process-conflict", state: "failed" }),
        ]);

        const admitted = yield* service.start(writer("after-cross-process-conflict"));
        expect(admitted.state).toBe("running");
        expect(fake.controls).toHaveLength(1);
        yield* service.stop(admitted.id);
      });
    },
  );

  it.effect("releases a stopped startup lease without ever spawning the backend", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const counts = leaseCounts();
      const { fake, projections, layer } = leaseFixture({ acquireGate: gate, counts });
      yield* withService(layer, function* (service) {
        const starting = yield* service
          .start(writer("stopped-during-lease"))
          .pipe(Effect.exit, Effect.forkScoped);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "starting");
        const id = projections.at(-1)?.runs[0]?.id;
        expect(id).toBeDefined();
        const stopping = yield* service.stop(id!).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        expect((yield* Fiber.join(stopping)).state).toBe("stopped");
        expect(Exit.isFailure(yield* Fiber.join(starting))).toBe(true);
        expect(fake.controls).toHaveLength(0);
        expect(counts.release).toBe(1);
      });
    }),
  );

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
      expect(failure).toMatchObject({
        _tag: "SubagentProcessError",
        code: "writer_lease_mark_failed",
      });
      expect(order).toEqual(["lease-acquire", "lease-mark-attempt", "lease-release"]);
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([
        expect.objectContaining({ name: "mark-failure-writer", state: "failed" }),
      ]);
    });
  });

  it.effect("marks a fresh lease before every backend respawn", () => {
    const order: string[] = [];
    const { fake, layer } = leaseFixture(
      {
        onAcquire: () => void order.push("lease-acquire"),
        onMark: () => void order.push("lease-spawn-started"),
        onRelease: () => void order.push("lease-release"),
      },
      fakeChildLayer(
        Effect.sync(() => void order.push("spawn")),
        { onRelease: () => void order.push("backend-release") },
      ),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(writer("respawn-mark-writer"));
      expect(order.slice(0, 3)).toEqual(["lease-acquire", "lease-spawn-started", "spawn"]);
      yield* completeLocalRun(service, fake.controls[0]!, run.id);
      order.length = 0;

      const resumed = yield* service.resume(run.id, "Continue after respawn.");
      expect(resumed.state).toBe("running");
      expect(order.slice(0, 3)).toEqual(["lease-acquire", "lease-spawn-started", "spawn"]);
      yield* service.stop(run.id);
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
        warning: expect.stringContaining("ownership remain quarantined"),
      });
      const conflict = yield* service
        .start(writer("blocked-after-release-failure"))
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: run.id,
      });
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

  it.effect("releases shared-cwd writer ownership after scope cleanup succeeds", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const first = yield* service.start(writer("writer-one", { task: "Implement auth" }));
      const conflict = yield* Effect.flip(
        service.start(writer("writer-two", { task: "Implement tests" })),
      );
      expect(conflict._tag).toBe("SubagentWriterConflictError");

      const stopped = yield* service.stop(first.id);
      expect(stopped.state).toBe("stopped");
      expect(stopped.warning).toBeUndefined();
      expect(fake.controls[0]?.released()).toBe(1);
      const second = yield* service.start(writer("writer-two", { task: "Implement tests" }));
      expect(second.state).toBe("running");
    });
  });

  it.effect(
    "shares one cwd lease across disjoint writers, resumes included, until the last",
    () => {
      const counts = leaseCounts();
      const { fake, layer } = leaseFixture({ counts });
      return withService(layer, function* (service) {
        const first = yield* service.start(claimedWriter("claimed-first", ["src/first.ts"]));
        const second = yield* service.start(claimedWriter("claimed-peer", ["src/peer.ts"]));
        expect(second.writeClaims).toEqual(["src/peer.ts"]);
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

  it.effect("rejects overlapping claimed writers while admitting another exact file", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const first = yield* service.start(
        claimedWriter("claim-owner", ["packages/auth/src/token.ts"]),
      );
      const conflict = yield* service
        .start(claimedWriter("claim-collision", ["packages/auth/src/TOKEN.ts"]))
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: first.id,
        message: expect.stringContaining("already claims"),
      });
      const disjoint = yield* service.start(
        claimedWriter("claim-disjoint", ["packages/auth/src/errors.ts"]),
      );
      expect(disjoint.state).toBe("running");
    });
  });

  it.effect("quarantines an entire claimed pool when one member cleanup defects", () => {
    const { fake, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, { releaseDefect: true }),
    );
    return withService(layer, function* (service) {
      const defective = yield* service.start(
        claimedWriter("defective-claimed-writer", ["src/a.ts"]),
      );
      yield* service.start(claimedWriter("claimed-peer", ["src/b.ts"]));
      const stopped = yield* service.stop(defective.id);
      expect(stopped.warning).toContain("ownership remain quarantined");

      const conflict = yield* service
        .start(claimedWriter("disjoint-but-quarantined", ["src/c.ts"]))
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        message: expect.stringContaining("quarantined"),
      });
      expect(fake.controls).toHaveLength(2);
    });
  });

  it.effect("quarantines writer ownership when child scope cleanup defects", () => {
    const { fake, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, { releaseDefect: true }),
    );
    return withService(layer, function* (service) {
      const first = yield* service.start(writer("defective-writer"));
      const stopped = yield* service.stop(first.id);
      expect(stopped).toMatchObject({
        state: "stopped",
        warning: expect.stringContaining("ownership remain quarantined"),
      });
      expect(fake.controls[0]?.released()).toBe(1);

      const conflict = yield* service.start(writer("replacement-writer")).pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: first.id,
        message: expect.stringContaining("cleanup could not be confirmed"),
      });
      expect(fake.controls).toHaveLength(1);
    });
  });

  it.effect("retains failed writer ownership until its child scope is released", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      yield* service.start(writer("failed-writer"));
      fake.controls[0]?.offer({ type: "tool_execution_start" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect(fake.controls[0]?.released()).toBe(0);

      const conflict = yield* Effect.flip(service.start(writer("next-writer")));
      expect(conflict._tag).toBe("SubagentWriterConflictError");

      fake.controls[0]?.exit(1);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const next = yield* service.start(writer("next-writer"));
      expect(next.state).toBe("running");
    });
  });
});
