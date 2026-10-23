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
