import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class HostBootstrapError extends Schema.TaggedError<HostBootstrapError>()("HostBootstrapError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/**
 * Lifts a best-effort Promise host prerequisite into an interruptible startup workflow. The
 * loader receives an owned cancellation signal. A foreign Promise that ignores it is detached on
 * interruption, and its late settlement cannot delay session replacement.
 */
export const bestEffortHostBootstrap = <Value>(
  operation: string,
  load: (signal: AbortSignal) => PromiseLike<Value>,
): Effect.Effect<void> =>
  Effect.tryPromise({
    // Keep the explicit parameter: RC.108 allocates the interruption signal from function arity.
    try: (signal) => load(signal),
    catch: () =>
      new HostBootstrapError({
        operation,
        message: "A best-effort host startup prerequisite failed.",
      }),
  }).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.logDebug(error.message).pipe(Effect.annotateLogs("operation", error.operation)),
    ),
  );
