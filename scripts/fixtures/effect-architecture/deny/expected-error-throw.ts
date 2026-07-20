import * as Effect from "effect/Effect";

export const program = Effect.gen(function* () {
  yield* Effect.void;
  throw new Error("expected failure");
});
