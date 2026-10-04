import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { SubagentRuntimeClosedError } from "../run/errors.ts";
import type { StartSubagentRequest } from "../run/model.ts";
import type { SubagentServiceContract } from "../run/service.ts";

/**
 * Where a waiting agent() call stands: its queue time, then its rank among its run's calls
 * queued at that same time, then its run's start order, so runs alternate at equal times.
 */
export interface WorkflowWaitOrder {
  readonly queuedAt: number;
  readonly rank: number;
  readonly run: number;
}

/** Anything an admission queue orders. */
export interface WorkflowQueued {
  readonly order: WorkflowWaitOrder;
}

/** A workflow start waiting for root capacity, with the launch the root checks. */
export interface WorkflowCapacityWaiter extends WorkflowQueued {
  readonly request: StartSubagentRequest;
  /** The run id the call reserved, so the root stops counting its grant once it holds a slot. */
  readonly runId: string;
}

const compareOrder = (left: WorkflowWaitOrder, right: WorkflowWaitOrder): number =>
  left.queuedAt - right.queuedAt || left.rank - right.rank || left.run - right.run;

/** Orders one run's calls; ranks count the calls queued at the same time, in call order. */
export const makeWorkflowWaitOrder = (run: number) => {
  let lastAt: number | undefined;
  let rank = 0;
  return (queuedAt: number): WorkflowWaitOrder => {
    rank = queuedAt === lastAt ? rank + 1 : 0;
    lastAt = queuedAt;
    return { queuedAt, rank, run };
  };
};

/** How a wait ends without a grant, and what it reports when it can't get in at once. */
export interface WorkflowWait {
  /** Runs once when the waiter isn't granted on arrival. */
  readonly onWait: Effect.Effect<void>;
  /** Ends the wait without a grant when it completes first. */
  readonly abort: Effect.Effect<void>;
}

/** Grants held in waiting order, such as a run's agent slots or the root's capacity. */
export interface WorkflowAdmissionQueue<Item extends WorkflowQueued> {
  /**
   * Waits for a grant in order, runs `use` holding it, and gives it back when `use` ends. It
   * returns none when `wait.abort` ends the wait first, and fails once the queue is closed.
   * Interruption while waiting leaves the queue cleanly, even after a grant.
   */
  readonly hold: <A, E, R>(
    item: Item,
    wait: WorkflowWait,
    use: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E | SubagentRuntimeClosedError, R>;
  /** Grants waiters again, such as after something outside the queue freed room. */
  readonly pump: Effect.Effect<void>;
  /** Fails every waiter and every later wait with `error`; grants already held stay. */
  readonly close: (error: SubagentRuntimeClosedError) => Effect.Effect<void>;
}

interface Waiter<Item> {
  readonly item: Item;
  readonly wake: Deferred.Deferred<void, SubagentRuntimeClosedError>;
  state: "waiting" | "granted" | "left";
}

/**
 * A FIFO of waiters. `admissible(waiting, granted)` says how many waiting items, from the front,
 * may be granted now while the `granted` items hold their grants; the rest keep waiting without
 * trying anything until the queue is pumped again, by an arrival, a release or its owner.
 */
export const makeWorkflowAdmissionQueue = <Item extends WorkflowQueued>(
  admissible: (waiting: ReadonlyArray<Item>, granted: ReadonlyArray<Item>) => Effect.Effect<number>,
): WorkflowAdmissionQueue<Item> => {
  const waiting: Array<Waiter<Item>> = [];
  const granted = new Set<Waiter<Item>>();
  let closed: SubagentRuntimeClosedError | undefined;
  const lock = Semaphore.makeUnsafe(1);

  const insert = (waiter: Waiter<Item>) => {
    const index = waiting.findIndex(
      (other) => compareOrder(other.item.order, waiter.item.order) > 0,
    );
    waiting.splice(index === -1 ? waiting.length : index, 0, waiter);
  };
  const remove = (waiter: Waiter<Item>) => {
    const index = waiting.indexOf(waiter);
    if (index !== -1) waiting.splice(index, 1);
  };

  // Grants only the waiters it checked: one that arrived meanwhile waits for the next pump, and
  // one that left meanwhile leaves its grant for that pump too.
  const pump = lock.withPermits(1)(
    Effect.suspend(() => {
      if (waiting.length === 0 || closed) return Effect.void;
      const checked = [...waiting];
      return admissible(
        checked.map((waiter) => waiter.item),
        [...granted].map((waiter) => waiter.item),
      ).pipe(
        Effect.map((count) => {
          for (const waiter of checked.slice(0, Math.max(0, count))) {
            if (waiter.state !== "waiting") continue;
            remove(waiter);
            waiter.state = "granted";
            granted.add(waiter);
            Deferred.doneUnsafe(waiter.wake, Effect.void);
          }
        }),
      );
    }),
  );

  const release = (waiter: Waiter<Item>) =>
    Effect.suspend(() => {
      if (waiter.state === "left") return Effect.void;
      if (waiter.state === "granted") granted.delete(waiter);
      else remove(waiter);
      waiter.state = "left";
      return pump;
    });

  const hold: WorkflowAdmissionQueue<Item>["hold"] = (item, wait, use) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (closed) return yield* closed;
        const waiter: Waiter<Item> = { item, wake: Deferred.makeUnsafe(), state: "waiting" };
        insert(waiter);
        const admitted = yield* restore(
          pump.pipe(
            Effect.andThen(
              Effect.suspend(() => (waiter.state === "waiting" ? wait.onWait : Effect.void)),
            ),
            Effect.andThen(
              Effect.raceFirst(
                Deferred.await(waiter.wake).pipe(Effect.as(true)),
                wait.abort.pipe(Effect.as(false)),
              ),
            ),
          ),
        ).pipe(Effect.onError(() => release(waiter)));
        if (!admitted) return yield* release(waiter).pipe(Effect.as(Option.none()));
        return yield* restore(use).pipe(Effect.asSome, Effect.ensuring(release(waiter)));
      }),
    );

  const close: WorkflowAdmissionQueue<Item>["close"] = (error) =>
    Effect.sync(() => {
      closed = error;
      for (const waiter of waiting.splice(0)) {
        waiter.state = "left";
        Deferred.doneUnsafe(waiter.wake, Effect.fail(error));
      }
    });

  return { hold, pump, close };
};

/** A run's agent slots, granted in call order. */
export const makeWorkflowSlots = (concurrency: number): WorkflowAdmissionQueue<WorkflowQueued> =>
  makeWorkflowAdmissionQueue((_waiting, granted) =>
    Effect.succeed(Math.max(0, concurrency - granted.length)),
  );

/**
 * The session's workflow starts waiting for root capacity, in queue order across runs. One
 * watcher pumps it whenever a holding that can refuse a start is released, and the root's
 * cheap check grants only as many waiters as it could admit; the rest keep waiting without a
 * start attempt. A grant lasts until its start attempt settles, and the root counts it only
 * until the start holds a slot of its own. The queue closes with the subagent service.
 */
export const makeWorkflowCapacity = (
  subagents: Pick<
    SubagentServiceContract,
    "admissionRevision" | "waitForAdmissionChange" | "queuedStartsAdmissible"
  >,
): Effect.Effect<WorkflowAdmissionQueue<WorkflowCapacityWaiter>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = makeWorkflowAdmissionQueue<WorkflowCapacityWaiter>((waiting, granted) =>
      subagents.queuedStartsAdmissible(
        waiting.map((waiter) => waiter.request),
        granted.map((waiter) => waiter.runId),
      ),
    );
    // The revision is read before each pump, so a release during it wakes the queue again.
    yield* subagents.admissionRevision.pipe(
      Effect.tap(() => queue.pump),
      Effect.flatMap(subagents.waitForAdmissionChange),
      Effect.forever,
      Effect.catch((error) => queue.close(error)),
      Effect.forkScoped,
    );
    return queue;
  });
