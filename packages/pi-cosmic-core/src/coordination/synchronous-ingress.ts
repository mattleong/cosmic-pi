import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

type SynchronousIngressOverflow = "drop" | "coalesce-latest";
type SynchronousIngressOfferResult = "accepted" | "dropped" | "coalesced" | "closed";

export class SynchronousIngressError extends Schema.TaggedError<SynchronousIngressError>()(
  "SynchronousIngressError",
  { message: Schema.String },
) {}

interface SynchronousIngressOptions<A, R> {
  readonly capacity: number;
  readonly overflow: SynchronousIngressOverflow;
  readonly handle: (value: A) => Effect.Effect<void, never, R>;
}

export interface SynchronousIngress<A> {
  /** Synchronous bounded ingress for mandatory host callbacks. */
  readonly offer: (value: A) => SynchronousIngressOfferResult;
  /** Idempotently rejects new offers, discards buffered work, and interrupts the worker. */
  readonly shutdown: Effect.Effect<void>;
}

/**
 * Bridges synchronous host callbacks into one scoped Effect worker. The queue is always bounded.
 * Coalescing retains at most one latest overflow value in addition to the bounded queue.
 */
export const makeSynchronousIngress = <A, R>(
  options: SynchronousIngressOptions<A, R>,
): Effect.Effect<SynchronousIngress<A>, SynchronousIngressError, Scope.Scope | R> =>
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
        // A defect never terminates the worker; the fixed diagnostic never includes its cause.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          () =>
            Effect.logWarning(
              "Synchronous ingress handler raised an unexpected defect; the worker continues.",
            ),
        ),
      );

    // This is the adapter's sole synchronous unsafe Queue operation.
    const offerQueue = (value: A) => Queue.offerUnsafe(queue, value);

    /** Rejects synchronous ingress at once and returns the queue shutdown. */
    const close = () => {
      closed = true;
      coalesced = undefined;
      return Queue.shutdown(queue);
    };
    const worker = Effect.forever(
      Effect.gen(function* () {
        const current = yield* Queue.take(queue);
        yield* handle(current);
        const overflow = coalesced;
        coalesced = undefined;
        // The synchronous offer cannot re-enter `offer`; a refused overflow stays coalesced.
        if (overflow !== undefined && !offerQueue(overflow.value)) coalesced = overflow;
      }),
    ).pipe(Effect.ensuring(Effect.suspend(close)));

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
    // Shutdown closes ingress as soon as it starts, before yielding to queue cleanup.
    const shutdown = Effect.uninterruptible(
      Effect.suspend(() =>
        closed ? awaitShutdown : close().pipe(Effect.andThen(Fiber.interrupt(fiber))),
      ),
    );

    return { offer, shutdown };
  });
