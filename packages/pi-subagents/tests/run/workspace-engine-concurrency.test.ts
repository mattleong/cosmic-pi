import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { yieldUntil } from "pi-cosmic-core/testing";
import { SubagentRuntimeClosedError } from "../../src/run/errors.ts";
import { SubagentService, type SubagentServiceContract } from "../../src/run/service.ts";
import { completeLocalRun, request, runView, withService } from "./fixtures/service-harness.ts";
import {
  leasesWith,
  pauseAt,
  repoWriter,
  stoppedWriter,
  workspaceFixture,
} from "./fixtures/workspace-engine.ts";

type Fixture = ReturnType<typeof workspaceFixture>;

/** Runs `effect` in the background and fails unless it ends within a few scheduler turns. */
const completesPromptly = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    let ended = false;
    const fiber = yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          ended = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* yieldUntil(() => ended, 500);
    return yield* Fiber.join(fiber);
  });

/** Forks `effect`, recording when it ends so a test can show it is still waiting. */
const tracked = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const state = { ended: false };
    const fiber = yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          state.ended = true;
        }),
      ),
      Effect.forkChild,
    );
    return { fiber, state };
  });

const settleTurns = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, {
  discard: true,
});

const sharedWriter = (cwd: string) =>
  repoWriter({ cwd, writerWorkspaceModeOverride: "shared-checkout" });

/** Unrelated runs and listings must never wait for a workspace's engine work. */
const unrelatedWorkProceeds = (service: SubagentServiceContract, otherId: string, name: string) =>
  Effect.gen(function* () {
    const listing = yield* completesPromptly(service.agentList({ kind: "main" }));
    expect(listing.agents.length).toBeGreaterThan(1);
    expect((yield* completesPromptly(service.rename(otherId, name))).name).toBe(name);
  });

const gateEngine = (f: Fixture, operation: "discard" | "integrate") =>
  pauseAt.pipe(
    Effect.tap(({ pause }) =>
      Effect.sync(() => {
        f.hooks.before[operation] = pause;
      }),
    ),
  );

describe("workspace engine work outside the run lock", () => {
  it.effect("keeps unrelated runs responsive while a discard's engine work runs", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const other = yield* service.start(request({ cwd: "/elsewhere" }));
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const gate = yield* gateEngine(f, "discard");
      const discarding = yield* service.workspaceDiscard(id).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      yield* unrelatedWorkProceeds(service, other.id, "unrelated");
      expect(f.entries.get(id)?.status).toBe("active");
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(discarding);
      expect(f.entries.get(id)?.status).toBe("discarded");
    });
  });

  it.effect("keeps unrelated runs responsive while an apply integrates", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const other = yield* service.start(request({ cwd: "/elsewhere" }));
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const gate = yield* gateEngine(f, "integrate");
      const applying = yield* service.workspaceApply(id).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      yield* unrelatedWorkProceeds(service, other.id, "unrelated");
      // Shared-checkout writers elsewhere start; one in the target waits for the integration.
      const elsewhere = yield* completesPromptly(service.start(sharedWriter("/elsewhere")));
      const target = yield* tracked(service.start(sharedWriter("/repo/packages/a")));
      yield* settleTurns;
      expect(target.state.ended).toBe(false);
      expect(f.integrations).toEqual([]);
      yield* Deferred.succeed(gate.release, undefined);
      expect(yield* Fiber.join(applying)).toMatchObject({ testing: "untested" });
      const admitted = yield* Fiber.join(target.fiber);
      expect(admitted.cwd).toBe("/repo/packages/a");
      expect(f.entries.get(id)?.status).toBe("integrated");
      yield* service.stop(admitted.id);
      yield* service.stop(elsewhere.id);
    });
  });

  it.effect("keeps new runs out of the integration target until the integration ends", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const resident = yield* service.start(request({ cwd: "/repo" }));
      yield* service.stop(resident.id);
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const gate = yield* gateEngine(f, "integrate");
      const applying = yield* service.workspaceApply(id).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      // A reader elsewhere starts; one in the half-written target waits, and none resumes there.
      const elsewhere = yield* completesPromptly(service.start(request({ cwd: "/elsewhere" })));
      const reader = yield* tracked(service.start(request({ cwd: "/repo/src" })));
      expect(yield* completesPromptly(service.resume(resident.id).pipe(Effect.flip))).toMatchObject(
        { code: "workspace_operation_in_progress" },
      );
      yield* settleTurns;
      expect(reader.state.ended).toBe(false);
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(applying);
      const admitted = yield* Fiber.join(reader.fiber);
      expect(admitted.cwd).toBe("/repo/src");
      expect((yield* service.resume(resident.id)).state).not.toBe("stopped");
      for (const run of [admitted, elsewhere, resident]) yield* service.stop(run.id);
    });
  });

  it.effect("holds a reader launch into a tree a discard is removing until it ends", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const writer = yield* stoppedWriter(service);
      const gate = yield* gateEngine(f, "discard");
      const discarding = yield* service
        .workspaceDiscard(writer.workspaceId!)
        .pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      const reader = yield* tracked(service.start(request({ cwd: writer.cwd })));
      yield* settleTurns;
      expect(reader.state.ended).toBe(false);
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("active");
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(discarding);
      const admitted = yield* Fiber.join(reader.fiber);
      expect(f.entries.get(writer.workspaceId!)?.status).toBe("discarded");
      yield* service.stop(admitted.id);
    });
  });

  it.effect("refuses a discard while a launch into its tree is still being admitted", () => {
    let admitting: string | undefined;
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    // The launch waits between reserving its directory and its admission.
    const f = workspaceFixture({
      writerLeases: leasesWith((base) => ({
        canonicalize: (cwd) =>
          cwd === admitting
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(base.canonicalize(cwd)),
              )
            : base.canonicalize(cwd),
      })),
    });
    return withService(f.layer, function* (service) {
      const writer = yield* stoppedWriter(service);
      const id = writer.workspaceId!;
      admitting = writer.cwd;
      const launching = yield* service.start(sharedWriter(writer.cwd)).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(
        yield* completesPromptly(service.workspaceDiscard(id).pipe(Effect.flip)),
      ).toMatchObject({ code: "workspace_process_unsettled" });
      expect(f.entries.get(id)?.status).toBe("active");
      admitting = undefined;
      yield* Deferred.succeed(release, undefined);
      yield* service.stop((yield* Fiber.join(launching)).id);
      yield* service.workspaceDiscard(id);
      expect(f.entries.get(id)?.status).toBe("discarded");
    });
  });

  it.effect(
    "keeps unrelated runs responsive while a completed writer's workspace is discarded",
    () => {
      const f = workspaceFixture();
      f.hooks.workerChanges = { changedPaths: [], uncapturedPaths: [], diffStat: [] };
      return withService(f.layer, function* (service) {
        const other = yield* service.start(request({ cwd: "/elsewhere" }));
        const gate = yield* gateEngine(f, "discard");
        const writer = yield* service.start(repoWriter());
        yield* completeLocalRun(service, f.children.controls.at(-1)!, writer.id, "Done.");
        yield* Deferred.await(gate.entered);
        yield* unrelatedWorkProceeds(service, other.id, "unrelated");
        expect(yield* service.resume(writer.id).pipe(Effect.flip)).toMatchObject({
          code: "workspace_operation_in_progress",
        });
        yield* Deferred.succeed(gate.release, undefined);
        for (let turn = 0; turn < 200; turn++) {
          if ((yield* runView(service, writer.id)).workspaceOutcome) break;
          yield* Effect.yieldNow;
        }
        expect((yield* runView(service, writer.id)).workspaceOutcome).toEqual({
          status: "auto-discarded",
        });
        expect(f.entries.get(writer.workspaceId!)?.status).toBe("discarded");
      });
    },
  );

  it.effect("refuses or queues other operations on a workspace its engine work holds", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const writer = yield* service.start(repoWriter());
      const reader = yield* service.startSessionOwnedFrom(
        writer.id,
        request({ cwd: writer.cwd, writeIntent: "read-only" }),
      );
      yield* service.stop(writer.id);
      const id = writer.workspaceId!;
      const gate = yield* gateEngine(f, "discard");
      const discarding = yield* service.workspaceDiscard(id).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      const busy = { code: "workspace_operation_in_progress" };
      expect(yield* completesPromptly(service.workspaceApply(id).pipe(Effect.flip))).toMatchObject(
        busy,
      );
      expect(yield* completesPromptly(service.resume(writer.id).pipe(Effect.flip))).toMatchObject(
        busy,
      );
      expect(
        yield* completesPromptly(
          service.agentSend({ kind: "main" }, writer.id, "Continue.").pipe(Effect.flip),
        ),
      ).toMatchObject(busy);
      // A run whose directory the discard is removing can't resume into it.
      expect(yield* completesPromptly(service.resume(reader.id).pipe(Effect.flip))).toMatchObject(
        busy,
      );
      // A second discard queues behind the first instead of interleaving with its engine work.
      const second = yield* tracked(service.workspaceDiscard(id).pipe(Effect.exit));
      yield* settleTurns;
      expect(second.state.ended).toBe(false);
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(discarding);
      yield* Fiber.join(second.fiber);
      expect(f.entries.get(id)?.status).toBe("discarded");
      expect(yield* service.resume(writer.id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_finished",
      });
    });
  });

  it.effect("restores the workspace when a discard's engine work fails", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const writer = yield* stoppedWriter(service);
      const id = writer.workspaceId!;
      f.hooks.failDiscard = true;
      expect(yield* service.workspaceDiscard(id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_operation_failed",
      });
      // Neither the hold nor the exclusion outlives the failure.
      const reader = yield* completesPromptly(service.start(request({ cwd: writer.cwd })));
      yield* service.stop(reader.id);
      f.hooks.failDiscard = false;
      yield* service.workspaceDiscard(id);
      expect(f.entries.get(id)?.status).toBe("discarded");
    });
  });

  it.effect("a cancelled discard stops its engine work and restores the workspace", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const writer = yield* stoppedWriter(service);
      const id = writer.workspaceId!;
      const gate = yield* gateEngine(f, "discard");
      const discarding = yield* service.workspaceDiscard(id).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      yield* completesPromptly(Fiber.interrupt(discarding));
      expect(f.entries.get(id)?.status).toBe("active");
      const reader = yield* completesPromptly(service.start(request({ cwd: writer.cwd })));
      yield* service.stop(reader.id);
      f.hooks.before.discard = undefined;
      yield* service.workspaceDiscard(id);
      expect(f.entries.get(id)?.status).toBe("discarded");
    });
  });

  it.effect("a cancelled apply still commits the integration it started", () => {
    const f = workspaceFixture();
    return withService(f.layer, function* (service) {
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const gate = yield* gateEngine(f, "integrate");
      const applying = yield* service.workspaceApply(id).pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      const cancelling = yield* tracked(Fiber.interrupt(applying));
      yield* settleTurns;
      expect(cancelling.state.ended).toBe(false);
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(cancelling.fiber);
      expect(f.entries.get(id)?.status).toBe("integrated");
      expect(yield* service.workspaceApply(id).pipe(Effect.flip)).toMatchObject({
        code: "workspace_finished",
      });
    });
  });

  it.effect("shutdown interrupts a discard's engine work instead of waiting for it", () => {
    const f = workspaceFixture();
    return Effect.gen(function* () {
      const serviceScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(f.layer, serviceScope);
      const service = Context.get(context, SubagentService);
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const gate = yield* gateEngine(f, "discard");
      const discarding = yield* service.workspaceDiscard(id).pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(gate.entered);
      yield* completesPromptly(Scope.close(serviceScope, Exit.void));
      expect(yield* Fiber.join(discarding)).toBeInstanceOf(SubagentRuntimeClosedError);
      expect(f.entries.get(id)?.status).toBe("active");
    }).pipe(Effect.scoped);
  });

  it.effect("shutdown waits for an integration in progress to commit", () => {
    const f = workspaceFixture();
    return Effect.gen(function* () {
      const serviceScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(f.layer, serviceScope);
      const service = Context.get(context, SubagentService);
      const id = (yield* stoppedWriter(service)).workspaceId!;
      const gate = yield* gateEngine(f, "integrate");
      const applying = yield* service.workspaceApply(id).pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(gate.entered);
      const closing = yield* tracked(Scope.close(serviceScope, Exit.void));
      yield* settleTurns;
      expect(closing.state.ended).toBe(false);
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(closing.fiber);
      yield* Fiber.join(applying);
      expect(f.entries.get(id)?.status).toBe("integrated");
    }).pipe(Effect.scoped);
  });
});
