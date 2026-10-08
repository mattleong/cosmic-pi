/** Runner-neutral steps for Effect tests that drive Promise-shaped host boundaries. */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** Waits at least one macrotask so detached host work can settle. */
export const eventLoopTurn = (): Promise<void> =>
  Effect.runPromise(Effect.sleep(Duration.millis(1)));

/** One promise-shaped scaffolding or boundary step inside a test Effect. */
export const step = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.promise(evaluate);

/** Awaits a host callback that may return either nothing or a Promise. */
export const settle = (evaluate: () => void | PromiseLike<void>): Effect.Effect<void> =>
  Effect.promise(() => Promise.resolve(evaluate()));

/** Awaits an optional promise-shaped harness call, preserving undefined results. */
export const maybe = <A>(
  evaluate: () => PromiseLike<A> | undefined,
): Effect.Effect<A | undefined> => Effect.promise(() => Promise.resolve(evaluate()));

/** Resumes on the next macrotask, after every Promise settlement already queued has run. */
export const macrotask = Effect.callback<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(handle));
});
