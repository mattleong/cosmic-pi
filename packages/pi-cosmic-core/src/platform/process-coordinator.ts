import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

interface ProcessLock {
  readonly semaphore: Semaphore.Semaphore;
  users: number;
}

/**
 * Extension Layers are built independently, so a Layer-local semaphore cannot
 * coordinate access to a file shared by multiple extension runtimes. This
 * registry is intentionally process-global and entries are removed after the
 * final active or waiting user exits.
 */
const processLocks = new Map<string, ProcessLock>();

/** Serializes keyed effects across independently built Layers and runtimes in this process. */
export const withProcessLock = <A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const existing = processLocks.get(key);
    const lock = existing ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    if (existing === undefined) processLocks.set(key, lock);
    lock.users++;

    return lock.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lock.users--;
          if (lock.users === 0 && processLocks.get(key) === lock) processLocks.delete(key);
        }),
      ),
    );
  });
