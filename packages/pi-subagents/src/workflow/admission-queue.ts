import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

/**
 * Where a waiting agent() call stands in its run's slot queue: its queue time, then its rank
 * among the run's calls queued at that same time.
 */
export interface WorkflowWaitOrder {
  readonly queuedAt: number;
  readonly rank: number;
}

const compareOrder = (left: WorkflowWaitOrder, right: WorkflowWaitOrder): number =>
  left.queuedAt - right.queuedAt || left.rank - right.rank;

/** How a wait ends without a slot, and what it reports when it can't get one at once. */
export interface WorkflowWait {
  /** Runs once when the waiter isn't granted a slot on arrival. */
  readonly onWait: Effect.Effect<void>;
  /** Ends the wait without a slot when it completes first. */
  readonly abort: Effect.Effect<void>;
}

interface Waiter {
  readonly order: WorkflowWaitOrder;
  readonly wake: Deferred.Deferred<void>;
  state: "waiting" | "granted" | "left";
}

/**
 * A run's `concurrency` agent slots, granted to waiters in order. A waiter that comes back later
 * with an earlier order, such as a call that waited behind a writer, goes ahead of later calls.
 */
export const makeWorkflowSlots = (concurrency: number) => {
  const waiting: Array<Waiter> = [];
  let held = 0;
  let lastAt: number | undefined;
  let rank = 0;

  /** Orders the run's calls; ranks count the calls queued at the same time, in call order. */
  const order = (queuedAt: number): WorkflowWaitOrder => {
    rank = queuedAt === lastAt ? rank + 1 : 0;
    lastAt = queuedAt;
    return { queuedAt, rank };
  };
  const grant = () => {
    while (held < concurrency && waiting.length > 0) {
      const next = waiting.shift()!;
      next.state = "granted";
      held += 1;
      Deferred.doneUnsafe(next.wake, Effect.void);
    }
  };
  const arrive = (waiter: Waiter) =>
    Effect.sync(() => {
      const index = waiting.findIndex((other) => compareOrder(other.order, waiter.order) > 0);
      waiting.splice(index === -1 ? waiting.length : index, 0, waiter);
      grant();
    });
  const release = (waiter: Waiter) =>
    Effect.sync(() => {
      if (waiter.state === "left") return;
      if (waiter.state === "granted") held -= 1;
      const index = waiting.indexOf(waiter);
      if (index !== -1) waiting.splice(index, 1);
      waiter.state = "left";
      grant();
    });

  /**
   * Waits for a slot in order, runs `use` holding it, and gives it back when `use` ends. It
   * returns none when `wait.abort` ends the wait first. Interruption while waiting leaves the
   * queue cleanly, even after a grant.
   */
  const hold = <A, E, R>(
    at: WorkflowWaitOrder,
    wait: WorkflowWait,
    use: Effect.Effect<A, E, R>,
  ): Effect.Effect<Option.Option<A>, E, R> =>
    Effect.acquireUseRelease(
      Deferred.make<void>().pipe(
        Effect.map((wake): Waiter => ({ order: at, wake, state: "waiting" })),
        Effect.tap(arrive),
      ),
      // Read once the waiter has arrived, so a slot granted on arrival reports no wait.
      (waiter) =>
        (waiter.state === "waiting" ? wait.onWait : Effect.void).pipe(
          Effect.andThen(
            Effect.raceFirst(
              Deferred.await(waiter.wake).pipe(Effect.as(true)),
              wait.abort.pipe(Effect.as(false)),
            ),
          ),
          Effect.flatMap((admitted) => (admitted ? Effect.asSome(use) : Effect.succeedNone)),
        ),
      (waiter) => release(waiter),
    );

  return { order, hold };
};

/** A run's agent slots, granted in waiting order. */
export type WorkflowSlots = ReturnType<typeof makeWorkflowSlots>;
