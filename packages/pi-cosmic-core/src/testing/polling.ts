import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class TestPollingTimeout extends Schema.TaggedError<
  TestPollingTimeout,
  { readonly brand: unique symbol }
>()("TestPollingTimeout", {
  attempts: Schema.Int,
}) {}

export const yieldUntil = (
  predicate: () => boolean,
  attempts = 100,
): Effect.Effect<void, TestPollingTimeout> =>
  Effect.suspend(() => {
    if (predicate()) return Effect.void;
    if (attempts <= 0) return TestPollingTimeout.make({ attempts: 0 });
    return Effect.yieldNow.pipe(Effect.andThen(yieldUntil(predicate, attempts - 1)));
  });

/**
 * Checks `predicate` up to `attempts` times in real time, sleeping `interval` between checks, and
 * returns its final value. For conditions another process or the event loop settles; use
 * `yieldUntil` for work that fibers finish without real time passing.
 */
export const pollUntil = Effect.fnUntraced(function* (
  predicate: () => boolean,
  attempts = 200,
  interval: Duration.Input = "10 millis",
): Effect.fn.Return<boolean> {
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (predicate()) return true;
    yield* Effect.sleep(interval);
  }
  return predicate();
});
