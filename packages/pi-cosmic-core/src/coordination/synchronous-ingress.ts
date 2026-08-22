import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export type SynchronousIngressOverflow = "drop" | "coalesce-latest";
export type SynchronousIngressOfferResult = "accepted" | "dropped" | "coalesced" | "closed";

export class SynchronousIngressError extends Schema.TaggedError<SynchronousIngressError>()(
  "SynchronousIngressError",
  { message: Schema.String },
) {}

export interface SynchronousIngressOptions<A, E, R, FailureR = never> {
  readonly capacity: number;
  readonly overflow: SynchronousIngressOverflow;
  readonly handle: (value: A) => Effect.Effect<void, E, R>;
  /** Failure observation is isolated too; failure of this callback never terminates the worker. */
  readonly onFailure?: (error: E) => Effect.Effect<void, never, FailureR>;
  /**
   * Defect observation runs when a handler violates an invariant; the worker continues
   * either way. Defaults to a fixed-string diagnostic that never includes the cause,
   * so unexpected defects can no longer disappear without any trace.
   */
  readonly onDefect?: (cause: Cause.Cause<E>) => void;
}

export interface SynchronousIngress<A> {
  /** Synchronous bounded ingress for mandatory host callbacks. */
  readonly offer: (value: A) => SynchronousIngressOfferResult;
  /** Idempotently rejects new offers, discards buffered work, and interrupts the worker. */
  readonly shutdown: Effect.Effect<void>;
  /** Completes after the scoped worker has terminated. */
  readonly awaitShutdown: Effect.Effect<void>;
}

/**
 * Bridges synchronous host callbacks into one scoped Effect worker. The queue is always bounded.
 * Coalescing retains at most one latest overflow value in addition to the bounded queue.
 */
export const makeSynchronousIngress = <A, E, R, FailureR = never>(
  options: SynchronousIngressOptions<A, E, R, FailureR>,
): Effect.Effect<SynchronousIngress<A>, SynchronousIngressError, Scope.Scope | R | FailureR> =>
  Effect.gen(function* () {
    const capacity = options.capacity;
    if (!(Number.isSafeInteger(capacity) && capacity > 0)) {
      return yield* new SynchronousIngressError({
        message: "Ingress capacity must be a positive safe integer.",
      });
    }

    const queue = yield* Queue.dropping<A>(capacity);
    const workerDone = yield* Deferred.make<void>();
    let closed = false;
    let coalesced: { readonly value: A } | undefined;
    const reportDefect = options.onDefect;

    const handle = (value: A) =>
      Effect.suspend(() => options.handle(value)).pipe(
        Effect.catch((error) => options.onFailure?.(error) ?? Effect.void),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : reportDefect
              ? Effect.sync(() => {
                  try {
                    reportDefect(cause);
                  } catch {
                    // Failure observation must never terminate the ingress worker.
                  }
                })
              : Effect.logWarning(
                  "Synchronous ingress handler raised an unexpected defect; the worker continues.",
                ),
        ),
      );

    // This is the adapter's sole synchronous unsafe Queue operation.
    const offerQueue = (value: A) => Queue.offerUnsafe(queue, value);

    const close = Effect.suspend(() => {
      closed = true;
      coalesced = undefined;
      return Queue.shutdown(queue).pipe(
        Effect.andThen(Deferred.succeed(workerDone, undefined)),
        Effect.asVoid,
      );
    });
    const worker = Effect.forever(
      Effect.gen(function* () {
        const current = yield* Queue.take(queue);
        yield* handle(current);
        const overflow = coalesced;
        coalesced = undefined;
        if (overflow !== undefined && !offerQueue(overflow.value) && coalesced === undefined) {
          coalesced = overflow;
        }
      }),
    ).pipe(Effect.ensuring(close));

    const fiber = yield* worker.pipe(Effect.forkScoped({ startImmediately: true }));

    const offer = (value: A): SynchronousIngressOfferResult => {
      if (closed) return "closed";
      if (options.overflow === "coalesce-latest" && coalesced !== undefined) {
        coalesced = { value };
        return "coalesced";
      }
      if (offerQueue(value)) return "accepted";
      if (options.overflow === "drop") return "dropped";
      coalesced = { value };
      return "coalesced";
    };

    const shutdown = Effect.suspend(() =>
      closed
        ? Deferred.await(workerDone)
        : Queue.shutdown(queue).pipe(
            Effect.andThen(Fiber.interrupt(fiber)),
            Effect.andThen(Deferred.await(workerDone)),
            Effect.asVoid,
          ),
    );

    return { offer, shutdown, awaitShutdown: Deferred.await(workerDone) };
  });
