import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Ref from "effect/Ref";
import * as TxReentrantLock from "effect/TxReentrantLock";
import {
  makeRefreshCoordinatorWith,
  mergeRefreshRequest,
  type RefreshRequest,
} from "./refresh-coordinator.ts";

interface SubscriptionRefreshOptions<Key, Value, E, R> {
  readonly currentKey: Effect.Effect<Key, never, R>;
  readonly interval: Effect.Effect<number, never, R>;
  readonly fetch: (request: RefreshRequest) => Effect.Effect<Value, E, R>;
  readonly commit: (value: Value) => Effect.Effect<void, E, R>;
  readonly spanName?: string;
}

interface SubscriptionRefresh<E, R> {
  readonly request: (request: RefreshRequest) => Effect.Effect<void, E, R>;
  /** Consumer invalidation and stale validation/publication share the same reentrant gate. */
  readonly invalidateWith: <A, E2, R2>(
    effect: Effect.Effect<A, E2, R2>,
  ) => Effect.Effect<A, E2, R2>;
  readonly startPolling: (request: RefreshRequest) => Effect.Effect<void, E, R>;
}

/**
 * Shared provider refresh engine. It owns single-flight coordination, interval wakeups,
 * and stale-result suppression while provider payloads and policy remain local.
 */
export const makeSubscriptionRefresh = <Key, Value, E, R>(
  options: SubscriptionRefreshOptions<Key, Value, E, R>,
): Effect.Effect<SubscriptionRefresh<E, R>> =>
  Effect.gen(function* () {
    const coordinator = yield* makeRefreshCoordinatorWith<RefreshRequest, E>(mergeRefreshRequest);
    const revisionRef = yield* Ref.make(0);
    const commitGate = yield* TxReentrantLock.make();
    const wakeLatch = yield* Latch.make();
    const spanName = options.spanName ?? "pi-cosmic-core.subscription.refresh";

    // Validation and commit share one reentrant gate with external invalidation so a commit may
    // deliberately invalidate its own result without admitting any other fiber.
    const withCommitPermit = <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
      TxReentrantLock.withLock(commitGate, effect);

    const invalidateWith: SubscriptionRefresh<E, R>["invalidateWith"] = (effect) =>
      withCommitPermit(
        Ref.update(revisionRef, (revision) => revision + 1).pipe(Effect.andThen(effect)),
      ).pipe(Effect.tap(() => Latch.release(wakeLatch)));

    const perform = Effect.fn(spanName)(function* (request: RefreshRequest) {
      const capturedRevision = yield* Ref.get(revisionRef);
      const capturedKey = yield* options.currentKey;
      const value = yield* options.fetch(request);
      yield* withCommitPermit(
        Effect.gen(function* () {
          if (capturedRevision !== (yield* Ref.get(revisionRef))) return;
          const currentKey = yield* options.currentKey;
          if (Object.is(capturedKey, currentKey)) yield* options.commit(value);
        }),
      );
    });

    const request = (next: RefreshRequest) => coordinator.run(next, perform);

    const startPolling = (pollRequest: RefreshRequest) =>
      Effect.forever(
        options.interval.pipe(
          Effect.flatMap((interval) => Latch.await(wakeLatch).pipe(Effect.timeoutOption(interval))),
          Effect.andThen(request(pollRequest)),
          // A joined owner's interruption is replayed to its joiners; only this fiber's own
          // interruption ends polling.
          Effect.catchCauseIf(
            (cause) => Cause.hasInterruptsOnly(cause),
            () => Effect.void,
          ),
        ),
      );

    return { request, invalidateWith, startPolling };
  });
