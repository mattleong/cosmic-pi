import * as Effect from "effect/Effect";

export const program = Effect.gen(function* () {
  return yield* Effect.fail("expected" as const);
});
