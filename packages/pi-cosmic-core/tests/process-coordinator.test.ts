import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Scope from "effect/Scope";
import { ProcessCoordinator } from "../src/platform/process-coordinator.ts";

const coordinated = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
  ProcessCoordinator.use((coordinator) => coordinator.withLock(key, effect));

const provideCoordinator = <A, E, R>(
  effect: Effect.Effect<A, E, R | ProcessCoordinator>,
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(ProcessCoordinator.layer);
    return yield* effect.pipe(Effect.provide(context));
  });

it.effect("serializes effects using the same key", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const secondAttempted = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();

    const first = yield* coordinated(
      "process-coordinator/same-key",
      Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst))),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(firstEntered);

    const second = yield* Deferred.succeed(secondAttempted, undefined).pipe(
      Effect.andThen(
        coordinated("process-coordinator/same-key", Deferred.succeed(secondEntered, undefined)),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(secondAttempted);
    expect(yield* Deferred.isDone(secondEntered)).toBe(false);

    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Deferred.await(secondEntered);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
  }).pipe(provideCoordinator, Effect.scoped),
);

it.effect("allows independent keys to run concurrently", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();

    const first = yield* coordinated(
      "process-coordinator/independent-a",
      Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkScoped);
    const second = yield* coordinated(
      "process-coordinator/independent-b",
      Deferred.succeed(secondEntered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkScoped);

    yield* Effect.all([Deferred.await(firstEntered), Deferred.await(secondEntered)], {
      concurrency: "unbounded",
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
  }).pipe(provideCoordinator, Effect.scoped),
);

it.effect("releases a keyed lock when its owner is interrupted", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const secondAttempted = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const holdFirst = yield* Deferred.make<void>();

    const first = yield* coordinated(
      "process-coordinator/interruption",
      Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Deferred.await(holdFirst))),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(firstEntered);

    const second = yield* Deferred.succeed(secondAttempted, undefined).pipe(
      Effect.andThen(
        coordinated("process-coordinator/interruption", Deferred.succeed(secondEntered, undefined)),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(secondAttempted);
    expect(yield* Deferred.isDone(secondEntered)).toBe(false);

    yield* Fiber.interrupt(first);
    yield* Deferred.await(secondEntered);
    yield* Fiber.join(second);
  }).pipe(provideCoordinator, Effect.scoped),
);

it.effect("coordinates across independently built managed runtimes", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const secondAttempted = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();

    yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            ManagedRuntime.make(ProcessCoordinator.layer),
            ManagedRuntime.make(ProcessCoordinator.layer),
          ] as const,
      ),
      ([firstRuntime, secondRuntime]) =>
        Effect.gen(function* () {
          const first = firstRuntime.runPromise(
            coordinated(
              "process-coordinator/cross-runtime",
              Deferred.succeed(firstEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst)),
              ),
            ),
          );
          yield* Deferred.await(firstEntered);

          const second = secondRuntime.runPromise(
            Deferred.succeed(secondAttempted, undefined).pipe(
              Effect.andThen(
                coordinated(
                  "process-coordinator/cross-runtime",
                  Deferred.succeed(secondEntered, undefined),
                ),
              ),
            ),
          );
          yield* Deferred.await(secondAttempted);
          expect(yield* Deferred.isDone(secondEntered)).toBe(false);

          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Effect.promise(() => Promise.all([first, second]));
          expect(yield* Deferred.isDone(secondEntered)).toBe(true);
        }),
      ([firstRuntime, secondRuntime]) =>
        Effect.all([firstRuntime.disposeEffect, secondRuntime.disposeEffect], {
          concurrency: "unbounded",
        }).pipe(Effect.asVoid),
    );
  }),
);
