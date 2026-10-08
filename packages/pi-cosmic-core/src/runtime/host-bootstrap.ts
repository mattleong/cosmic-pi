import * as Effect from "effect/Effect";

/**
 * Lifts a best-effort Promise host prerequisite into an interruptible startup workflow. The
 * loader receives an owned cancellation signal. A foreign Promise that ignores it is detached on
 * interruption, and its late settlement cannot delay session replacement.
 */
export const bestEffortHostBootstrap = <Value>(
  operation: string,
  load: (signal: AbortSignal) => PromiseLike<Value>,
): Effect.Effect<void> =>
  // Keep the explicit parameter: Effect allocates the interruption signal from function arity.
  Effect.tryPromise((signal) => load(signal)).pipe(
    Effect.asVoid,
    // The failure itself may carry host secrets; only the operation name is recorded.
    Effect.catch(() =>
      Effect.logDebug("A best-effort host startup prerequisite failed.").pipe(
        Effect.annotateLogs("operation", operation),
      ),
    ),
  );
