import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { assertBoundedPendingWork } from "./confinement.js";

/** A fiber waiting for the turn, resumed through its Deferred. */
interface Waiter {
  readonly ready: Deferred.Deferred<void>;
  granted: boolean;
}

/** Synchronous bookkeeping that must run in turn order but needs no fiber of its own. */
interface Job {
  readonly run: () => void;
}

// Guest continuations and promise reactions share a FIFO turn queue. A plain semaphore
// provides exclusion, but allows a newly arriving reaction to overtake a queued waiter.
export class GuestTurns {
  private held = false;
  private readonly queue = new Set<Waiter | Job>();

  take(owner?: { held: boolean }): Effect.Effect<void> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        if (this.held) {
          assertBoundedPendingWork(this.queue.size + 1, "Pending promise jobs");
          const waiter: Waiter = { ready: Deferred.makeUnsafe<void>(), granted: false };
          this.queue.add(waiter);
          // Completing a Deferred resumes its waiter on the releasing fiber's stack. Yielding
          // after the handoff keeps chained handoffs from nesting until the stack overflows.
          yield* restore(Effect.andThen(Deferred.await(waiter.ready), Effect.yieldNow)).pipe(
            Effect.onInterrupt(() => {
              this.queue.delete(waiter);
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

  /**
   * Queues synchronous bookkeeping (a combinator recording one settled input) behind the
   * turns already waiting. With the turn free and nothing queued, it runs at once.
   */
  enqueue(run: () => void): void {
    if (this.held) {
      assertBoundedPendingWork(this.queue.size + 1, "Pending promise jobs");
      this.queue.add({ run });
      return;
    }
    this.held = true;
    this.queue.add({ run });
    this.grantNext();
  }

  release(): Effect.Effect<void> {
    return Effect.sync(() => this.grantNext());
  }

  withPermit<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(restore(this.take()), () => Effect.ensuring(restore(effect), this.release())),
    );
  }

  /**
   * Passes the held turn on. Queued jobs run in order, iteratively, until a fiber is next or
   * nothing remains; a job that throws still lets every later entry through first.
   */
  private grantNext(): void {
    let failure: { readonly error: unknown } | undefined;
    for (;;) {
      const next = this.queue.values().next().value;
      if (next === undefined) {
        this.held = false;
        break;
      }
      this.queue.delete(next);
      if ("run" in next) {
        try {
          next.run();
        } catch (error) {
          failure ??= { error };
        }
        continue;
      }
      next.granted = true;
      // Keep the turn reserved until this specific waiter resumes; newcomers must queue.
      Deferred.doneUnsafe(next.ready, Effect.void);
      break;
    }
    if (failure !== undefined) throw failure.error;
  }
}
