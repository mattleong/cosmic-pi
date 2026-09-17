import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { assertBoundedCollectionSize } from "./confinement.js";

interface Waiter {
  readonly ready: Deferred.Deferred<void>;
  granted: boolean;
}

// Guest continuations and promise reactions share a FIFO turn queue. A plain semaphore
// provides exclusion, but allows a newly arriving reaction to overtake a queued waiter.
export class GuestTurns {
  private held = false;
  private readonly waiters = new Set<Waiter>();

  take(owner?: { held: boolean }): Effect.Effect<void> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        if (this.held) {
          assertBoundedCollectionSize(this.waiters.size + 1, "Pending promise jobs");
          const waiter: Waiter = { ready: Deferred.makeUnsafe<void>(), granted: false };
          this.waiters.add(waiter);
          yield* restore(Deferred.await(waiter.ready)).pipe(
            Effect.onInterrupt(() => {
              this.waiters.delete(waiter);
              // Release a reserved turn if interruption wins before the waiter resumes.
              return waiter.granted ? this.release() : Effect.void;
            }),
          );
        } else {
          this.held = true;
        }
        // Set ownership before restoring interruptibility, not in the acquiring caller.
        if (owner !== undefined) owner.held = true;
      }),
    );
  }

  release(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const next = this.waiters.values().next().value;
      if (next === undefined) {
        this.held = false;
        return Effect.void;
      }
      this.waiters.delete(next);
      next.granted = true;
      // Keep the turn reserved until this specific waiter resumes; newcomers must queue.
      return Effect.asVoid(Deferred.succeed(next.ready, undefined));
    });
  }

  withPermit<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(restore(this.take()), () => Effect.ensuring(restore(effect), this.release())),
    );
  }
}
