import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export const eventLoopTurn = (): Promise<void> =>
  Effect.runPromise(Effect.sleep(Duration.millis(1)));

export const step = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.promise(evaluate);

export const settle = (evaluate: () => void | PromiseLike<void>): Effect.Effect<void> =>
  Effect.promise(() => Promise.resolve(evaluate()));

export const maybe = <A>(
  evaluate: () => PromiseLike<A> | undefined,
): Effect.Effect<A | undefined> => Effect.promise(() => Promise.resolve(evaluate()));

export const macrotask = Effect.callback<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(handle));
});
