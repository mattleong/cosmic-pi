import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

export interface WorkflowWaitOrder {
  readonly queuedAt: number;
  readonly rank: number;
}

const compareOrder = (left: WorkflowWaitOrder, right: WorkflowWaitOrder): number =>
  left.queuedAt - right.queuedAt || left.rank - right.rank;

export interface WorkflowWait {
  readonly onWait: Effect.Effect<void>;
  readonly abort: Effect.Effect<void>;
}

interface Waiter {
  readonly order: WorkflowWaitOrder;
  readonly wake: Deferred.Deferred<void>;
  state: "waiting" | "granted" | "left";
}

export const makeWorkflowSlots = (concurrency: number) => {
  const waiting: Array<Waiter> = [];
  let held = 0;
  let lastAt: number | undefined;
  let rank = 0;

  const order = (queuedAt: number): WorkflowWaitOrder => {
    rank = queuedAt === lastAt ? rank + 1 : 0;
    lastAt = queuedAt;
    return { queuedAt, rank };
  };
  const grant = () => {
    while (held < concurrency) {
      const next = waiting.shift();
      if (!next) return;
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

export type WorkflowSlots = ReturnType<typeof makeWorkflowSlots>;
