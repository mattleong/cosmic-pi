// Test harness boundary: Promise-shaped driver fixtures intentionally live here.
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** Tagged carrier so the deferred rejects with the exact Error a test provided. */
class DeferredRejection extends Data.TaggedError("DeferredRejection")<{ cause: Error }> {}

/** A plain Promise deferred for Promise-shaped test driver boundaries. */
export function deferred<T>() {
  const gate = Deferred.makeUnsafe<T, DeferredRejection>();
  return {
    promise: Effect.runPromise(Effect.result(Deferred.await(gate))).then((result) =>
      result._tag === "Success" ? result.success : Promise.reject(result.failure.cause),
    ),
    resolve: (value: T) => void Deferred.doneUnsafe(gate, Effect.succeed(value)),
    reject: (cause?: Error) =>
      void Deferred.doneUnsafe(
        gate,
        Effect.fail(new DeferredRejection({ cause: cause ?? new Error("Deferred rejected.") })),
      ),
  };
}

/** Waits at least one macrotask so detached handler work can settle. */
export function tick(): Promise<void> {
  return Effect.runPromise(Effect.sleep(Duration.millis(1)));
}
