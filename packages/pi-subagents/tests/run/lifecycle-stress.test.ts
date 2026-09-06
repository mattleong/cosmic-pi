// Each cycle uses owned process fakes and explicit release barriers, never wall-clock sleeps.
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { provideBuiltLayer } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import type { SubagentProjection } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import {
  fakeChildLayer,
  fakeWriterLeaseLayer,
  request,
  serviceLayer,
  contactParentFrame,
} from "./fixtures/service-harness.ts";

const cycles = 4;

describe("SubagentService lifecycle stress", () => {
  it.effect("joins terminal descendant cleanup without replacing its outcome", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const cleanupOrder: number[] = [];
      const fake = fakeChildLayer(Effect.void, {
        onRelease: (index) => cleanupOrder.push(index),
      });
      let projection: SubagentProjection | undefined;
      const layer = serviceLayer({ publish: (value) => void (projection = value) }).pipe(
        Layer.provide(fake.layer),
      );
      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const parent = yield* service.start(request());
        const child = yield* service.startSessionOwnedFrom(parent.id, request());
        fake.controls[1]!.gateRelease(release);
        fake.controls[1]!.offer({ type: "agent_settled" });
        yield* yieldUntil(
          () => projection?.runs.find((run) => run.id === child.id)?.state === "completed",
        );
        const stopping = yield* service.stop(parent.id).pipe(Effect.forkScoped);
        yield* TestClock.adjust("30 seconds");
        expect(stopping.pollUnsafe()).toBeUndefined();
        expect(cleanupOrder).toEqual([]);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(stopping)).state).toBe("stopped");
        expect((yield* service.status(child.id)).state).toBe("completed");
        expect(cleanupOrder).toEqual([1, 0]);
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.scoped,
        provideBuiltLayer(layer),
      );
    }),
  );

  it.effect("reclaims interrupted pre-spawn cleanup before releasing a writer lease", () =>
    Effect.gen(function* () {
      const spawnEntered = yield* Deferred.make<void>();
      const spawnGate = yield* Deferred.make<void>();
      const cleanupOrder: string[] = [];
      const fake = fakeChildLayer(
        Deferred.succeed(spawnEntered, undefined).pipe(Effect.andThen(Deferred.await(spawnGate))),
        { onRelease: () => cleanupOrder.push("backend") },
      );
      let projection: SubagentProjection | undefined;
      let publications = 0;
      const layer = serviceLayer(
        {
          publish: (value) => {
            projection = value;
            publications++;
          },
        },
        undefined,
        fakeWriterLeaseLayer({ onRelease: () => cleanupOrder.push("lease") }),
      ).pipe(Layer.provide(fake.layer));
      const owner = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
      const context = yield* Layer.buildWithScope(layer, owner);
      const service = Context.get(context, SubagentService);
      yield* Effect.gen(function* () {
        const starting = yield* service
          .startSessionOwned(request({ writeIntent: "writer" }))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(spawnEntered);
        const id = projection!.runs[0]!.id;
        const stopping = yield* service.stop(id).pipe(Effect.forkScoped);
        yield* yieldUntil(() => projection?.runs[0]?.state === "stopping");
        // Let the stop owner enter its spawn wait before owner shutdown interrupts it.
        yield* TestClock.adjust("30 seconds");
        const shutdown = yield* Scope.close(owner, Exit.void).pipe(Effect.forkScoped);
        yield* TestClock.adjust("30 seconds");
        expect(shutdown.pollUnsafe()).toBeUndefined();
        expect(cleanupOrder).toEqual([]);
        expect(fake.controls).toHaveLength(0);
        const publicationsAtShutdown = publications;
        yield* Deferred.succeed(spawnGate, undefined);
        yield* Fiber.join(shutdown);
        // Shutdown itself is the ownership barrier, not a later join of callers.
        expect(fake.controls).toHaveLength(1);
        expect(fake.controls[0]!.released()).toBe(1);
        expect(cleanupOrder).toEqual(["backend", "lease"]);
        expect(fake.reclaimedRunIds).toEqual([id]);
        expect(publications).toBe(publicationsAtShutdown);
        yield* Fiber.await(starting);
        yield* Fiber.await(stopping);
      }).pipe(Effect.ensuring(Deferred.succeed(spawnGate, undefined)));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "isolates siblings and rejects new descendants through repeated overlapping subtree stops",
    () => {
      const fake = fakeChildLayer();
      let projection: SubagentProjection | undefined;
      const layer = serviceLayer({ publish: (value) => void (projection = value) }).pipe(
        Layer.provide(fake.layer),
      );
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        for (let cycle = 0; cycle < cycles; cycle++) {
          const release = yield* Deferred.make<void>();
          yield* Effect.gen(function* () {
            const offset = fake.controls.length;
            const parent = yield* service.start(request({ name: `parent-${cycle}` }));
            const child = yield* service.startSessionOwnedFrom(parent.id, request());
            const leaf = yield* service.startSessionOwnedFrom(child.id, request());
            const sibling = yield* service.start(request({ name: `sibling-${cycle}` }));
            const [parentControl, childControl, leafControl, siblingControl] =
              fake.controls.slice(offset);
            if (!parentControl || !childControl || !leafControl || !siblingControl)
              return yield* Effect.die("Missing acquired child controls");
            leafControl.gateRelease(release);

            let cancelledUpdates = 0;
            const observing = yield* service
              .awaitTerminal([leaf.id], "all_finished", () => cancelledUpdates++)
              .pipe(Effect.forkScoped);
            yield* yieldUntil(() => cancelledUpdates > 0);
            const stoppingParent = yield* service.stop(parent.id).pipe(Effect.forkScoped);
            yield* yieldUntil(
              () => projection?.runs.find((run) => run.id === leaf.id)?.state === "stopping",
            );
            const stoppingChild = yield* service
              .stop(child.id)
              .pipe(Effect.forkScoped({ startImmediately: true }));
            yield* Fiber.interrupt(stoppingParent);
            yield* Fiber.interrupt(observing);
            const updatesAtCancellation = cancelledUpdates;

            // Neither ancestor has reached its own stop yet, but the subtree claim must
            // already prevent new descendants from escaping both traversals.
            for (const id of [parent.id, child.id]) {
              expect(
                yield* service.startSessionOwnedFrom(id, request()).pipe(Effect.flip),
              ).toMatchObject({
                code: "parent_run_disconnected",
              });
            }
            expect(parentControl.released()).toBe(0);
            expect(childControl.released()).toBe(0);
            expect(stoppingChild.pollUnsafe()).toBeUndefined();

            // An unrelated root completes and resumes while descendant cleanup is blocked.
            siblingControl.offer({ type: "agent_settled" });
            yield* yieldUntil(() => siblingControl.released() === 1);
            expect((yield* service.resume(sibling.id, "Next assignment")).state).toBe("running");
            const resumedControl = fake.controls.at(-1)!;
            siblingControl.offer({ type: "agent_start" });
            siblingControl.offer({ type: "agent_settled" });
            leafControl.offerIpc(
              contactParentFrame(`late-${cycle}`, "question", "Arrived during stop"),
            );
            leafControl.offer({ type: "agent_settled" });
            yield* Deferred.succeed(release, undefined);
            expect((yield* Fiber.join(stoppingChild)).state).toBe("stopped");
            yield* yieldUntil(
              () => projection?.runs.find((run) => run.id === parent.id)?.state === "stopped",
            );
            for (const id of [parent.id, child.id, leaf.id]) {
              expect(yield* service.status(id)).toMatchObject({
                state: "stopped",
                question: undefined,
              });
              expect((yield* service.stop(id)).state).toBe("stopped");
            }
            expect(
              [parentControl, childControl, leafControl].map((control) => control.released()),
            ).toEqual([1, 1, 1]);
            expect(yield* service.status(sibling.id)).toMatchObject({
              state: "running",
              reportGeneration: 1,
            });
            expect(resumedControl.released()).toBe(0);
            expect(cancelledUpdates).toBe(updatesAtCancellation);
            yield* service.stop(sibling.id);
            expect(fake.controls.slice(offset).map((control) => control.released())).toEqual([
              1, 1, 1, 1, 1,
            ]);
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        }
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    },
  );

  it.effect(
    "joins cancelled subtree cleanup during repeated session shutdown without stale publication",
    () =>
      Effect.gen(function* () {
        for (let cycle = 0; cycle < cycles; cycle++) {
          const release = yield* Deferred.make<void>();
          yield* Effect.gen(function* () {
            const fake = fakeChildLayer();
            const notifications: SubagentNotification[] = [];
            const projections: SubagentProjection[] = [];
            const layer = serviceLayer({
              publish: (value) => void projections.push(value),
              notify: (value) => void notifications.push(value),
            }).pipe(Layer.provide(fake.layer));
            const owner = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
            const context = yield* Layer.buildWithScope(layer, owner);
            const service = Context.get(context, SubagentService);
            const parent = yield* service.start(request({ name: `shutdown-parent-${cycle}` }));
            const child = yield* service.startSessionOwnedFrom(parent.id, request());
            const leaf = yield* service.startSessionOwnedFrom(child.id, request());
            const sibling = yield* service.start(request());
            fake.controls[2]!.gateRelease(release);
            const stopping = yield* service.stop(parent.id).pipe(Effect.forkScoped);
            yield* yieldUntil(
              () =>
                projections.at(-1)?.runs.find((run) => run.id === leaf.id)?.state === "stopping",
            );
            yield* Fiber.interrupt(stopping);
            let updates = 0;
            const waiting = yield* service
              .awaitTerminal([sibling.id], "all_finished", () => updates++)
              .pipe(Effect.result, Effect.forkScoped);
            yield* yieldUntil(() => updates > 0);

            const shutdown = yield* Scope.close(owner, Exit.void).pipe(
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* TestClock.adjust("30 seconds");
            // Scope closure must join the in-flight release, not abandon its ancestors.
            expect(shutdown.pollUnsafe()).toBeUndefined();
            expect(fake.controls.slice(0, 3).map((control) => control.released())).toEqual([
              0, 0, 0,
            ]);
            fake.controls[2]!.offer({ type: "agent_start" });
            fake.controls[2]!.offer({ type: "agent_settled" });
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(shutdown);
            expect(yield* Fiber.join(waiting)).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "SubagentRuntimeClosedError" },
            });
            yield* Scope.close(owner, Exit.void);
            expect(fake.controls.map((control) => control.released())).toEqual([1, 1, 1, 1]);
            expect(new Set(fake.reclaimedRunIds)).toEqual(
              new Set([parent.id, child.id, leaf.id, sibling.id]),
            );
            expect(fake.reclaimedRunIds).toHaveLength(4);

            const publicationsAtShutdown = projections.length;
            const updatesAtShutdown = updates;
            for (const control of fake.controls) {
              control.offer({ type: "agent_start" });
              control.offer({ type: "agent_settled" });
              control.offerIpc(
                contactParentFrame(`closed-${cycle}`, "question", "Arrived after shutdown"),
              );
              control.exit(1);
            }
            yield* TestClock.adjust("30 seconds");
            expect(projections).toHaveLength(publicationsAtShutdown);
            expect(updates).toBe(updatesAtShutdown);
            expect(notifications).toEqual([]);
            expect(fake.controls.map((control) => control.released())).toEqual([1, 1, 1, 1]);
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        }
      }).pipe(Effect.scoped),
  );
});
