import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

interface ProcessLock {
  readonly semaphore: Semaphore.Semaphore;
  users: number;
}

const processLocks = new Map<string, ProcessLock>();

export const withProcessLock = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const lock = processLocks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      processLocks.set(key, lock);
      lock.users++;
      return lock;
    }),
    (lock) => lock.semaphore.withPermit(effect),
    (lock) =>
      Effect.sync(() => {
        if (--lock.users === 0 && processLocks.get(key) === lock) processLocks.delete(key);
      }),
  );
