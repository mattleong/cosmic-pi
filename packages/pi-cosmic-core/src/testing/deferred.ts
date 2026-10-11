import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

export const deferredPromise = <A = void>() => {
  const deferred = Deferred.makeUnsafe<A, Error>();
  return {
    promise: Effect.runPromise(Deferred.await(deferred)),
    resolve: (value: A): void => {
      Deferred.doneUnsafe(deferred, Effect.succeed(value));
    },
    reject: (error: Error): void => {
      Deferred.doneUnsafe(deferred, Effect.fail(error));
    },
  };
};
