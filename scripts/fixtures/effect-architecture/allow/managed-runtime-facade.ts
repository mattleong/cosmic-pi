import type * as Effect from "effect/Effect";

declare const runtime: {
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
};
declare const program: Effect.Effect<void>;
void runtime.run(program);
