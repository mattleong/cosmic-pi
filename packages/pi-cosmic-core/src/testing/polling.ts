import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class TestPollingTimeout extends Schema.TaggedError<TestPollingTimeout>()(
  "TestPollingTimeout",
  { attempts: Schema.Number },
) {}

/** Deterministic bounded polling for tests whose scoped worker advances via Effect yields. */
export const yieldUntil = (
  predicate: () => boolean,
  attempts = 100,
): Effect.Effect<void, TestPollingTimeout> =>
  Effect.suspend(() => {
    if (predicate()) return Effect.void;
    if (attempts <= 0) return new TestPollingTimeout({ attempts: 0 });
    return Effect.yieldNow.pipe(Effect.andThen(yieldUntil(predicate, attempts - 1)));
  });
