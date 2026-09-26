import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/** A test pause point: `pass` signals `entered`, then waits until the test runs `open`. */
export const gate = () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    return {
      pass: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
      entered: Deferred.await(entered),
      hasEntered: Deferred.isDone(entered),
      open: Deferred.succeed(released, undefined),
    };
  });

/** Signals entry, never completes, and records whether interruption ran its finalizer. */
export const blockingProbe = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  let released = false;
  return {
    entered,
    block: Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(
        Effect.sync(() => {
          released = true;
        }),
      ),
    ),
    released: () => released,
  };
});
