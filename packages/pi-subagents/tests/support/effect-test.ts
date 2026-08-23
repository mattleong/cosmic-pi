// Shared Effect-generator test registration for promise-shaped test boundaries.
import { it } from "@effect/vitest";
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

/** Registers one @effect/vitest test whose body is a single Effect generator. */
export const effectTest = (
  name: string,
  body: () => Generator<Effect.Effect<any, never, never>, void, never>,
  timeout?: number,
): void => it.effect(name, () => Effect.gen(body), timeout);
