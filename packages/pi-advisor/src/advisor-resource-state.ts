import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface AdvisorOwnedResource<A> {
  readonly value: A;
  readonly release: Effect.Effect<void>;
}

export interface AdvisorResourceState {
  readonly child: AdvisorOwnedResource<unknown> | undefined;
}

export interface AdvisorResourceStateService {
  readonly replaceChild: <A, E, R>(
    acquire: Effect.Effect<A, E, R>,
    release: (value: A) => Effect.Effect<void>,
  ) => Effect.Effect<A, E, R>;
  readonly stopChild: Effect.Effect<void>;
}

/** Effect-owned resource authority. Resource handles never enter AdvisorApplicationState. */
export const makeAdvisorResourceState = (): Effect.Effect<AdvisorResourceStateService> =>
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<AdvisorResourceState>({ child: undefined });
    const lifecycleLock = yield* Semaphore.make(1);
    const detachChild = SynchronizedRef.getAndSet(state, { child: undefined });
    const stopChild = lifecycleLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* detachChild;
          if (current.child) yield* current.child.release;
        }),
      ),
    );
    const replaceChild: AdvisorResourceStateService["replaceChild"] = (acquire, release) =>
      lifecycleLock.withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const current = yield* detachChild;
            // Replacement stays fail-open if the previous finalizer defects.
            if (current.child) yield* current.child.release.pipe(Effect.ignoreCause);
            const value = yield* restore(acquire);
            yield* SynchronizedRef.set(state, {
              child: { value, release: Effect.suspend(() => release(value)) },
            });
            return value;
          }),
        ),
      );
    return { replaceChild, stopChild };
  });
