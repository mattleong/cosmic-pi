import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import { interruptingScheduler, yieldUntil } from "pi-cosmic-core/testing";
import { SubagentService } from "../../src/run/service.ts";
import {
  awaitRuns,
  contactParentFrame,
  fakeChildLayer,
  fakeWriterLeaseLayer,
  leaseCounts,
  localServiceFixture,
  request,
  runView,
  withService,
} from "./fixtures/service-harness.ts";
import { SubagentRuntimeClosedError } from "../../src/run/errors.ts";

const cycles = 4;

describe("SubagentService lifecycle stress", () => {
  it.effect(
    "compensates pre-backend cancellation checkpoints before writer reuse and shutdown",
    () =>
      Effect.gen(function* () {
        for (let interruptAt = 1; interruptAt <= 100; interruptAt++) {
          const leases = leaseCounts();
          const { fake, projections, layer } = localServiceFixture(
            {},
            fakeChildLayer(),
            undefined,
            fakeWriterLeaseLayer({ counts: leases }),
          );
          const owner = yield* Scope.fork(yield* Effect.scope);
          const context = yield* Layer.buildWithScope(layer, owner);
          const service = Context.get(context, SubagentService);
          let checkpoints = 0;
          let cancelled = false;
          const scheduler = interruptingScheduler(() => {
            if (leases.mark === 0 || fake.controls.length > 0) return false;
            cancelled = ++checkpoints === interruptAt || cancelled;
            return checkpoints === interruptAt;
          });
          const starting = yield* service
            .start(request({ writeIntent: "writer" }))
            .pipe(Effect.provideService(Scheduler.Scheduler, scheduler), Effect.forkScoped);
          yield* yieldUntil(() => starting.pollUnsafe() !== undefined);
          const result = yield* Fiber.await(starting);
          if (cancelled) {
            expect(Exit.isFailure(result), `interruption checkpoint ${interruptAt}`).toBe(true);
            expect(projections.at(-1)?.runs[0]?.state).toBe("stopped");
            expect(fake.controls.every((control) => control.released() === 1)).toBe(true);
            expect(leases.release).toBe(1);
            const spawnedBeforeStop = fake.controls.length;
            yield* service.stop(projections.at(-1)!.runs[0]!.id);
            expect(fake.controls).toHaveLength(spawnedBeforeStop);
          } else if (Exit.isSuccess(result)) yield* service.stop(result.value.id);
          else return yield* Effect.failCause(result.cause);

          const replacement = yield* service.start(request({ writeIntent: "writer" }));
          if (interruptAt % 2 === 0) yield* service.stop(replacement.id);
          let disposed = false;
          const shutdown = yield* Scope.close(owner, Exit.void).pipe(
            Effect.tap(() => Effect.sync(() => void (disposed = true))),
            Effect.forkScoped,
          );
          yield* yieldUntil(() => disposed);
          yield* Fiber.join(shutdown);
          expect(leases.release).toBe(leases.acquire);
          expect(fake.controls.every((control) => control.released() === 1)).toBe(true);
        }
        return undefined;
      }),
  );

  it.effect(
    "isolates siblings and rejects new descendants through repeated overlapping subtree stops",
    () => {
      const { fake, projections, layer } = localServiceFixture();
      return withService(layer, function* (service) {
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
            const observing = yield* awaitRuns(
              service,
              [leaf.id],
              "all_finished",
              () => cancelledUpdates++,
            ).pipe(Effect.forkScoped);
            yield* yieldUntil(() => cancelledUpdates > 0);
            const stoppingParent = yield* service.stop(parent.id).pipe(Effect.forkScoped);
            yield* yieldUntil(
              () =>
                projections.at(-1)?.runs.find((run) => run.id === leaf.id)?.state === "stopping",
            );
            const stoppingChild = yield* service
              .stop(child.id)
              .pipe(Effect.forkScoped({ startImmediately: true }));
            yield* Fiber.interrupt(stoppingParent);
            yield* Fiber.interrupt(observing);
            const updatesAtCancellation = cancelledUpdates;

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

            siblingControl.settle();
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
              () =>
                projections.at(-1)?.runs.find((run) => run.id === parent.id)?.state === "stopped",
            );
            for (const id of [parent.id, child.id, leaf.id]) {
              expect(yield* runView(service, id)).toMatchObject({
                state: "stopped",
                question: undefined,
              });
              expect((yield* service.stop(id)).state).toBe("stopped");
            }
            expect(
              [parentControl, childControl, leafControl].map((control) => control.released()),
            ).toEqual([1, 1, 1]);
            expect(yield* runView(service, sibling.id)).toMatchObject({
              state: "running",
              reportGeneration: 1,
            });
            expect(resumedControl.released()).toBe(0);
            expect(cancelledUpdates).toBe(updatesAtCancellation);
            yield* service.stop(sibling.id);
            expect(fake.controls.slice(offset).map((control) => control.released())).toEqual([
              1, 1, 1, 1, 1,
            ]);
            return undefined;
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        }
      });
    },
  );

  it.effect(
    "joins cancelled subtree cleanup during repeated session shutdown without stale publication",
    () =>
      Effect.gen(function* () {
        for (let cycle = 0; cycle < cycles; cycle++) {
          const release = yield* Deferred.make<void>();
          yield* Effect.gen(function* () {
            const { fake, projections, notifications, layer } = localServiceFixture();
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
            const waiting = yield* awaitRuns(
              service,
              [sibling.id],
              "all_finished",
              () => updates++,
            ).pipe(Effect.flip, Effect.forkScoped);
            yield* yieldUntil(() => updates > 0);

            const shutdown = yield* Scope.close(owner, Exit.void).pipe(
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* TestClock.adjust("30 seconds");
            expect(shutdown.pollUnsafe()).toBeUndefined();
            expect(fake.controls.slice(0, 3).map((control) => control.released())).toEqual([
              0, 0, 0,
            ]);
            fake.controls[2]!.offer({ type: "agent_start" });
            fake.controls[2]!.offer({ type: "agent_settled" });
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(shutdown);
            expect(yield* Fiber.join(waiting)).toBeInstanceOf(SubagentRuntimeClosedError);
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
