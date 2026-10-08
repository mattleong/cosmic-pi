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
  // Admission owns a registry reference before the permit is acquired. Its release handler is
  // installed while masked; waiting for the permit and the work itself stay interruptible.
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
