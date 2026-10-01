import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import { vi } from "vitest";
import { interruptingScheduler } from "../testing.ts";
import { withProcessLock } from "../src/platform/process-coordinator.ts";

it.effect("releases the keyed registry reference across interrupted admission and reuse", () =>
  Effect.gen(function* () {
    // Capture only the owned registry's unique key, leaving real Effect semaphores intact.
    let key = "";
    const observed = new Set<Map<unknown, unknown>>();
    const observedRegistry = () => observed.values().next().value;
    const set = Map.prototype.set;
    const observer = vi
      .spyOn(Map.prototype, "set")
      .mockImplementation(function (this: Map<unknown, unknown>, candidate, value) {
        if (candidate === key) observed.add(this);
        return set.call(this, candidate, value);
      });
    try {
      for (let checkpoint = 1; checkpoint <= 50; checkpoint++) {
        key = `process-coordinator/admission-${checkpoint}`;
        observed.clear();
        let checks = 0;
        const scheduler = interruptingScheduler(() => ++checks === checkpoint);
        const interrupted = yield* withProcessLock(key, Effect.void).pipe(
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkScoped,
        );
        yield* Fiber.await(interrupted);
        yield* withProcessLock(key, Effect.void);
        expect(observedRegistry(), `observed registry at checkpoint ${checkpoint}`).toBeDefined();
        expect(observedRegistry()?.has(key), `released registry at checkpoint ${checkpoint}`).toBe(
          false,
        );
        yield* withProcessLock(key, Effect.void);
        expect(observedRegistry()?.has(key)).toBe(false);
      }
    } finally {
      observer.mockRestore();
    }
  }),
);

for (const ending of ["release", "interrupt"] as const) {
  it.effect(`serializes same-key effects until the owner ends by ${ending}`, () =>
    Effect.gen(function* () {
      const key = `process-coordinator/same-key-${ending}`;
      const firstEntered = yield* Deferred.make<void>();
      const secondAttempted = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();

      const first = yield* withProcessLock(
        key,
        Deferred.succeed(firstEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(firstEntered);

      const second = yield* Deferred.succeed(secondAttempted, undefined).pipe(
        Effect.andThen(withProcessLock(key, Deferred.succeed(secondEntered, undefined))),
        Effect.forkScoped,
      );
      yield* Deferred.await(secondAttempted);
      expect(yield* Deferred.isDone(secondEntered)).toBe(false);

      yield* ending === "release"
        ? Deferred.succeed(releaseFirst, undefined)
        : Fiber.interrupt(first);
      yield* Deferred.await(secondEntered);
      yield* Fiber.await(first);
      yield* Fiber.join(second);
    }).pipe(Effect.scoped),
  );
}

it.effect("allows independent keys to run concurrently", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();

    const first = yield* withProcessLock(
      "process-coordinator/independent-a",
      Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkScoped);
    const second = yield* withProcessLock(
      "process-coordinator/independent-b",
      Deferred.succeed(secondEntered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkScoped);

    yield* Effect.all([Deferred.await(firstEntered), Deferred.await(secondEntered)], {
      concurrency: "unbounded",
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
  }).pipe(Effect.scoped),
);
