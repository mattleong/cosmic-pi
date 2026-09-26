import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { withProcessLock } from "../src/platform/process-coordinator.ts";

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
