import * as Cause from "effect/Cause";
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
    let closed = false;
    let coalesced: { readonly value: A } | undefined;

    const handle = (value: A) =>
      Effect.suspend(() => options.handle(value)).pipe(
        Effect.catch((error) => options.onFailure?.(error) ?? Effect.void),
        // A defect never terminates the worker; the fixed diagnostic never includes its cause.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
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
      return Queue.shutdown(queue);
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

    const awaitShutdown = Fiber.await(fiber).pipe(Effect.asVoid);
    const shutdown = Effect.uninterruptible(
      Effect.suspend(() => {
        if (closed) return awaitShutdown;
        // Reject synchronous ingress as soon as shutdown starts, before yielding to queue cleanup.
        closed = true;
        coalesced = undefined;
        return Queue.shutdown(queue).pipe(Effect.andThen(Fiber.interrupt(fiber)));
      }),
    );

    return { offer, shutdown, awaitShutdown };
  });
