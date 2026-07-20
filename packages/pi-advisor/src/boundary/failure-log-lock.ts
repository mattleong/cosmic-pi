import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/** Shared across session Layers because every session writes the same bounded log. */
const processFailureLogLock = Semaphore.makeUnsafe(1);

/** Serializes rotation and append as one platform operation. */
export class AdvisorFailureLogLock extends Context.Service<
  AdvisorFailureLogLock,
  { readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> }
>()("pi-advisor/boundary/failure-log-lock/AdvisorFailureLogLock") {
  static readonly layer = Layer.succeed(
    this,
    this.of({ withLock: (effect) => processFailureLogLock.withPermits(1)(effect) }),
  );
}
