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
  readonly offer: (value: A) => SynchronousIngressOfferResult;
  readonly shutdown: Effect.Effect<void>;
}

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
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          () =>
            Effect.logWarning(
              "Synchronous ingress handler raised an unexpected defect; the worker continues.",
            ),
        ),
      );

    const offerQueue = (value: A) => Queue.offerUnsafe(queue, value);

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
    const shutdown = Effect.uninterruptible(
      Effect.suspend(() =>
        closed ? awaitShutdown : close().pipe(Effect.andThen(Fiber.interrupt(fiber))),
      ),
    );

    return { offer, shutdown };
  });
