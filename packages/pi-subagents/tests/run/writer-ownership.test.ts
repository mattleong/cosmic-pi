// Explicit test entry-point Layer provision owns each scoped service runtime.
// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { setImmediate as scheduleImmediate } from "node:timers";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type { BackendDriver } from "../../src/backend/model.ts";
import { makeSubagentBackendRegistry, SubagentBackendRegistry } from "../../src/backend/service.ts";
import { SubagentProcessError } from "../../src/run/errors.ts";
import type { SubagentProjection } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  fakeChildLayer,
  fakeWriterLeaseLayer,
  profileLayerFor,
  request,
  serviceLayer,
} from "./fixtures/service-harness.ts";

describe("SubagentService", () => {
  it.effect(
    "quarantines a spawn-started writer when a failed Herdr acquisition owns uncertain cleanup",
    () => {
      let leaseReleases = 0;
      const projections: SubagentProjection[] = [];
      const driver: BackendDriver = {
        host: "herdr",
        runtime: "pi",
        capabilities: ["steer"],
        supportsContext: (context) => context === "fresh",
        preflight: () => Effect.void,
        spawn: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.fail(
                new SubagentProcessError({
                  operation: "finalize Herdr launch",
                  code: "herdr_launch_cleanup_unconfirmed",
                  message: "Fixture applied start and failed rollback cleanup.",
                }),
              ).pipe(Effect.orDie),
            );
            return yield* new SubagentProcessError({
              operation: "launch Herdr agent",
              code: "herdr_start_agent_outcome_uncertain",
              message: "Fixture Herdr start may have applied.",
            });
          }),
      };
      const registry = Layer.succeed(
        SubagentBackendRegistry,
        makeSubagentBackendRegistry([driver]),
      );
      const leases = fakeWriterLeaseLayer({
        onRelease: () => {
          leaseReleases += 1;
        },
      });
      const layer = SubagentService["layer"]({
        publish: (projection) => projections.push(projection),
      }).pipe(
        Layer.provide(Layer.merge(registry, leases)),
        Layer.provideMerge(profileLayerFor({})),
      );
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const failure = yield* service
          .start(
            request({
              host: "herdr",
              runtime: "pi",
              writeIntent: "writer",
              closeOnReport: true,
              name: "uncertain-herdr-writer",
            }),
          )
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ code: "herdr_start_agent_outcome_uncertain" });
        expect(leaseReleases).toBe(0);
        expect(projections.at(-1)?.runs[0]).toMatchObject({
          state: "failed",
          warning: expect.stringContaining("ownership remain quarantined"),
        });
        const conflict = yield* service
          .start(
            request({
              host: "herdr",
              runtime: "pi",
              name: "replacement",
              writeIntent: "writer",
            }),
          )
          .pipe(Effect.flip);
        expect(conflict).toMatchObject({ _tag: "SubagentWriterConflictError" });
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("quarantines a writer when awaitExit failure finalization defects", () => {
    const fake = fakeChildLayer(Effect.void, { releaseDefect: true });
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ name: "await-failure-defect", writeIntent: "writer" }),
      );
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

      const conflict = yield* service
        .start(request({ name: "blocked-writer", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: run.id,
        message: expect.stringContaining("cleanup could not be confirmed"),
      });
      expect(fake.controls).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
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
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const starting = yield* service
          .start(request({ name: "boundary-interrupted-writer", writeIntent: "writer" }))
          .pipe(Effect.forkScoped({ startImmediately: false }));
        interruptAtBoundary = () => starting.interruptUnsafe();
        const interrupted = yield* Fiber.await(starting);
        expect(Exit.isFailure(interrupted)).toBe(true);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopped");
        expect(fake.controls).toHaveLength(0);

        const replacement = yield* service.start(
          request({ name: "after-boundary-interrupt", writeIntent: "writer" }),
        );
        expect(replacement.state).toBe("running");
        expect(fake.controls).toHaveLength(1);
        yield* service.stop(replacement.id);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("settles in-flight writer preparation when session shutdown starts at startup", () =>
    Effect.gen(function* () {
      const acquireGate = yield* Deferred.make<void>();
      const acquireStarted = yield* Deferred.make<void>();
      const fake = fakeChildLayer();
      let releases = 0;
      const writerLeases = fakeWriterLeaseLayer({
        acquireGate,
        onAcquireStarted: () => Deferred.doneUnsafe(acquireStarted, Effect.void),
        onRelease: () => {
          releases += 1;
        },
      });
      const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
        Layer.provide(fake.layer),
      );

      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        yield* service
          .startSessionOwned(request({ name: "shutdown-start-boundary", writeIntent: "writer" }))
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(acquireStarted);
        scheduleImmediate(() => Deferred.doneUnsafe(acquireGate, Effect.void));
      }).pipe(Effect.scoped, Effect.provide(layer));

      expect(fake.controls).toHaveLength(0);
      expect(releases).toBe(1);
    }),
  );

  it.effect("does not resume a completed writer while another writer owns the cwd", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(
        request({ name: "writer-one", writeIntent: "writer", task: "Implement auth" }),
      );
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* service.start(
        request({ name: "writer-two", writeIntent: "writer", task: "Implement tests" }),
      );

      const conflict = yield* Effect.flip(service.resume(first.id, "Make another edit"));
      expect(conflict._tag).toBe("SubagentWriterConflictError");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("resolves completed-writer resume uncertainty and releases ownership on exit", () => {
    const fake = fakeChildLayer(Effect.void, {
      initialTransportFailures: [
        { spawnIndex: 1, type: "prompt", code: "transport_outcome_uncertain" },
      ],
    });
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ name: "uncertain-completed-writer", writeIntent: "writer" }),
      );
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "First writer turn complete." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);

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

      const replacement = yield* service.start(
        request({ name: "replacement-writer", writeIntent: "writer" }),
      );
      expect(replacement.state).toBe("running");
      expect(fake.controls).toHaveLength(3);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keys the fast in-memory writer guard by canonical cwd aliases", () => {
    const fake = fakeChildLayer();
    let acquisitions = 0;
    const writerLeases = fakeWriterLeaseLayer({
      canonicalize: (cwd) => (cwd === "/project-alias" ? "/project" : cwd),
      onAcquire: () => {
        acquisitions += 1;
      },
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(
        request({ name: "canonical-writer", writeIntent: "writer", cwd: "/project" }),
      );
      const aliasConflict = yield* service
        .start(request({ name: "alias-writer", writeIntent: "writer", cwd: "/project-alias" }))
        .pipe(Effect.flip);
      expect(aliasConflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: first.id,
      });
      expect(acquisitions).toBe(1);

      const other = yield* service.start(
        request({ name: "other-cwd-writer", writeIntent: "writer", cwd: "/other-project" }),
      );
      expect(other.state).toBe("running");
      expect(acquisitions).toBe(2);
      yield* service.stop(first.id);
      yield* service.stop(other.id);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "keys the fast writer guard by filesystem identity even when canonical paths differ",
    () => {
      const fake = fakeChildLayer();
      let acquisitions = 0;
      const writerLeases = fakeWriterLeaseLayer({
        filesystemIdentity: (cwd) =>
          cwd === "/project-before-rename" || cwd === "/project-after-rename"
            ? "dev:1;ino:2"
            : `dev:1;ino:${cwd}`,
        onAcquire: () => {
          acquisitions += 1;
        },
      });
      const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
        Layer.provide(fake.layer),
      );
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const first = yield* service.start(
          request({
            name: "identity-writer",
            writeIntent: "writer",
            cwd: "/project-before-rename",
          }),
        );
        const conflict = yield* service
          .start(
            request({
              name: "renamed-identity-writer",
              writeIntent: "writer",
              cwd: "/project-after-rename",
            }),
          )
          .pipe(Effect.flip);
        expect(conflict).toMatchObject({
          _tag: "SubagentWriterConflictError",
          activeId: first.id,
        });
        expect(acquisitions).toBe(1);
        yield* service.stop(first.id);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("rejects Windows writers before canonicalization, lease acquisition, or spawn", () => {
    const fake = fakeChildLayer();
    let canonicalizations = 0;
    let acquisitions = 0;
    const writerLeases = fakeWriterLeaseLayer({
      platform: "win32",
      onCanonicalize: () => {
        canonicalizations += 1;
      },
      onAcquire: () => {
        acquisitions += 1;
      },
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* service
        .start(request({ name: "windows-writer", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "UnsupportedSafeWriterOwnershipError",
        code: "unsupported_safe_writer_ownership",
        platform: "win32",
      });
      expect(canonicalizations).toBe(0);
      expect(acquisitions).toBe(0);
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([]);

      const reader = yield* service.start(
        request({ name: "windows-reader", writeIntent: "read-only" }),
      );
      expect(reader.state).toBe("running");
      expect(fake.controls).toHaveLength(1);
      yield* service.stop(reader.id);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("does not canonicalize or acquire a lease for read-only runs", () => {
    const fake = fakeChildLayer();
    let canonicalizations = 0;
    let acquisitions = 0;
    const writerLeases = fakeWriterLeaseLayer({
      onCanonicalize: () => {
        canonicalizations += 1;
      },
      onAcquire: () => {
        acquisitions += 1;
      },
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const reader = yield* service.start(request({ name: "reader", writeIntent: "read-only" }));
      expect(reader.state).toBe("running");
      expect(canonicalizations).toBe(0);
      expect(acquisitions).toBe(0);
      yield* service.stop(reader.id);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("fails typed writer canonicalization before reservation or backend spawn", () => {
    const fake = fakeChildLayer();
    const writerLeases = fakeWriterLeaseLayer({ failCanonicalization: true });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* service
        .start(request({ name: "bad-cwd-writer", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "writer_cwd_canonicalization_failed",
      });
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "settles a failed cross-process reservation without spawning or retaining the slot",
    () => {
      const fake = fakeChildLayer();
      const writerLeases = fakeWriterLeaseLayer({ failAcquire: true });
      const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
        Layer.provide(fake.layer),
      );
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const conflict = yield* service
          .start(request({ name: "cross-process-conflict", writeIntent: "writer" }))
          .pipe(Effect.flip);
        expect(conflict).toMatchObject({
          _tag: "SubagentWriterConflictError",
          activeId: "other-run",
        });
        expect(fake.controls).toHaveLength(0);
        expect(yield* service.list).toEqual([
          expect.objectContaining({ name: "cross-process-conflict", state: "failed" }),
        ]);

        const admitted = yield* service.start(
          request({ name: "after-cross-process-conflict", writeIntent: "writer" }),
        );
        expect(admitted.state).toBe("running");
        expect(fake.controls).toHaveLength(1);
        yield* service.stop(admitted.id);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("releases a stopped startup lease without ever spawning the backend", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const projections: SubagentProjection[] = [];
      const fake = fakeChildLayer();
      let releases = 0;
      const writerLeases = fakeWriterLeaseLayer({
        acquireGate: gate,
        onRelease: () => {
          releases += 1;
        },
      });
      const layer = serviceLayer(
        { publish: (projection) => projections.push(projection) },
        profileLayerFor({}),
        writerLeases,
      ).pipe(Layer.provide(fake.layer));
      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const starting = yield* service
          .start(request({ name: "stopped-during-lease", writeIntent: "writer" }))
          .pipe(Effect.exit, Effect.forkScoped);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "starting");
        const id = projections.at(-1)?.runs[0]?.id;
        expect(id).toBeDefined();
        const stopping = yield* service.stop(id!).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        yield* TestClock.adjust("25 millis");
        expect((yield* Fiber.join(stopping)).state).toBe("stopped");
        expect(Exit.isFailure(yield* Fiber.join(starting))).toBe(true);
        expect(fake.controls).toHaveLength(0);
        expect(releases).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("acquires before spawn and releases only after backend cleanup confirms", () => {
    const order: string[] = [];
    const fake = fakeChildLayer(
      Effect.sync(() => void order.push("spawn")),
      {
        onRelease: () => void order.push("backend"),
      },
    );
    const writerLeases = fakeWriterLeaseLayer({
      onAcquire: () => void order.push("lease-acquire"),
      onMark: () => void order.push("lease-spawn-started"),
      onRelease: () => void order.push("lease-release"),
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const writer = yield* service.start(
        request({ name: "ordered-writer", writeIntent: "writer" }),
      );
      expect(order).toEqual(["lease-acquire", "lease-spawn-started", "spawn"]);
      yield* service.stop(writer.id);
      expect(order).toEqual([
        "lease-acquire",
        "lease-spawn-started",
        "spawn",
        "backend",
        "lease-release",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("does not spawn when the durable spawn-started mark fails", () => {
    const order: string[] = [];
    const fake = fakeChildLayer(Effect.sync(() => void order.push("spawn")));
    const writerLeases = fakeWriterLeaseLayer({
      failMark: true,
      onAcquire: () => void order.push("lease-acquire"),
      onMark: () => void order.push("lease-mark-attempt"),
      onRelease: () => void order.push("lease-release"),
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* service
        .start(request({ name: "mark-failure-writer", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "SubagentProcessError",
        code: "writer_lease_mark_failed",
      });
      expect(order).toEqual(["lease-acquire", "lease-mark-attempt", "lease-release"]);
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([
        expect.objectContaining({ name: "mark-failure-writer", state: "failed" }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("marks a fresh lease before every backend respawn", () => {
    const order: string[] = [];
    const fake = fakeChildLayer(
      Effect.sync(() => void order.push("spawn")),
      {
        onRelease: () => void order.push("backend-release"),
      },
    );
    const writerLeases = fakeWriterLeaseLayer({
      onAcquire: () => void order.push("lease-acquire"),
      onMark: () => void order.push("lease-spawn-started"),
      onRelease: () => void order.push("lease-release"),
    });
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer(
      { publish: (projection) => projections.push(projection) },
      profileLayerFor({}),
      writerLeases,
    ).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const writer = yield* service.start(
        request({ name: "respawn-mark-writer", writeIntent: "writer" }),
      );
      expect(order.slice(0, 3)).toEqual(["lease-acquire", "lease-spawn-started", "spawn"]);
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() =>
        projections.some((projection) => projection.runs[0]?.state === "completed"),
      );
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      order.length = 0;

      const resumed = yield* service.resume(writer.id, "Continue after respawn.");
      expect(resumed.state).toBe("running");
      expect(order.slice(0, 3)).toEqual(["lease-acquire", "lease-spawn-started", "spawn"]);
      yield* service.stop(writer.id);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("quarantines the session and retains ownership when lease release fails", () => {
    const fake = fakeChildLayer();
    let releases = 0;
    const writerLeases = fakeWriterLeaseLayer({
      failRelease: true,
      onRelease: () => {
        releases += 1;
      },
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const writer = yield* service.start(
        request({ name: "release-failure-writer", writeIntent: "writer" }),
      );
      const stopped = yield* service.stop(writer.id);
      expect(fake.controls[0]?.released()).toBe(1);
      expect(releases).toBe(1);
      expect(stopped).toMatchObject({
        state: "stopped",
        warning: expect.stringContaining("ownership remain quarantined"),
      });
      const conflict = yield* service
        .start(request({ name: "blocked-after-release-failure", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: writer.id,
      });
      expect(fake.controls).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("closes every owned writer lease after backend cleanup on session shutdown", () => {
    const order: string[] = [];
    const fake = fakeChildLayer(Effect.void, {
      onRelease: (index) => void order.push(`backend-${index}`),
    });
    const writerLeases = fakeWriterLeaseLayer({
      onRelease: (lease) => void order.push(`lease-${lease.evidence.runId}`),
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const ids = yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const first = yield* service.start(
          request({ name: "shutdown-one", writeIntent: "writer", cwd: "/project-one" }),
        );
        const second = yield* service.start(
          request({ name: "shutdown-two", writeIntent: "writer", cwd: "/project-two" }),
        );
        return [first.id, second.id] as const;
      }).pipe(Effect.scoped, Effect.provide(layer));
      for (const [index, id] of ids.entries()) {
        const backendIndex = order.indexOf(`backend-${index}`);
        const leaseIndex = order.indexOf(`lease-${id}`);
        expect(backendIndex).toBeGreaterThanOrEqual(0);
        expect(leaseIndex).toBeGreaterThan(backendIndex);
      }
    });
  });

  it.effect("releases shared-cwd writer ownership after scope cleanup succeeds", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(
        request({ name: "writer-one", writeIntent: "writer", task: "Implement auth" }),
      );
      const conflict = yield* Effect.flip(
        service.start(
          request({ name: "writer-two", writeIntent: "writer", task: "Implement tests" }),
        ),
      );
      expect(conflict._tag).toBe("SubagentWriterConflictError");

      const stopped = yield* service.stop(first.id);
      expect(stopped.state).toBe("stopped");
      expect(stopped.warning).toBeUndefined();
      expect(fake.controls[0]?.released()).toBe(1);
      const second = yield* service.start(
        request({ name: "writer-two", writeIntent: "writer", task: "Implement tests" }),
      );
      expect(second.state).toBe("running");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("quarantines writer ownership when child scope cleanup defects", () => {
    const fake = fakeChildLayer(Effect.void, { releaseDefect: true });
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(
        request({ name: "defective-writer", writeIntent: "writer" }),
      );
      const stopped = yield* service.stop(first.id);
      expect(stopped).toMatchObject({
        state: "stopped",
        warning: expect.stringContaining("ownership remain quarantined"),
      });
      expect(fake.controls[0]?.released()).toBe(1);

      const conflict = yield* service
        .start(request({ name: "replacement-writer", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: first.id,
        message: expect.stringContaining("cleanup could not be confirmed"),
      });
      expect(fake.controls).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("retains failed writer ownership until its child scope is released", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      yield* service.start(request({ name: "failed-writer", writeIntent: "writer" }));
      fake.controls[0]?.offer({ type: "tool_execution_start" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect(fake.controls[0]?.released()).toBe(0);

      const conflict = yield* Effect.flip(
        service.start(request({ name: "next-writer", writeIntent: "writer" })),
      );
      expect(conflict._tag).toBe("SubagentWriterConflictError");

      fake.controls[0]?.exit(1);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const next = yield* service.start(request({ name: "next-writer", writeIntent: "writer" }));
      expect(next.state).toBe("running");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
