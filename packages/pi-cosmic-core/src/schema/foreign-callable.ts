import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * Admits a function received from another package. Only callability is checked at runtime;
 * `Args` is the documented calling contract and cannot be verified. The `void` result means
 * callers must not trust the returned value: invoke the function through `Effect.try` or
 * `Effect.tryPromise`, or a synchronous host-callback helper, and decode what it returns.
 */
export const ForeignCallable = <Args extends ReadonlyArray<unknown>>() =>
  Schema.declare(
    (value: unknown): value is (...args: Args) => void => Predicate.isFunction(value),
    { expected: "function" },
  );
