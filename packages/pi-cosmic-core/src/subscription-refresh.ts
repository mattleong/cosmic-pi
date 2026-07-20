import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { makeRefreshCoordinatorWith } from "./refresh-coordinator.ts";

export interface SubscriptionRefreshOptions<Request, Key, Value, E, R> {
  readonly mergeRequest: (current: Request | undefined, next: Request) => Request;
  readonly currentKey: Effect.Effect<Key, never, R>;
  readonly interval: Effect.Effect<number, never, R>;
  readonly fetch: (request: Request) => Effect.Effect<Value, E, R>;
  readonly commit: (value: Value, request: Request) => Effect.Effect<void, E, R>;
  readonly equals?: (left: Key, right: Key) => boolean;
  readonly spanName?: string;
}

export interface SubscriptionRefresh<Request, E, R> {
  readonly request: (request: Request) => Effect.Effect<void, E, R>;
  readonly invalidate: Effect.Effect<void>;
  readonly wake: Effect.Effect<void>;
  readonly startPolling: (request: Request) => Effect.Effect<void, E, R>;
  readonly revision: Effect.Effect<number>;
}

/**
 * Shared provider refresh engine. It owns single-flight coordination, interval wakeups,
 * and stale-result suppression while provider payloads and policy remain local.
 */
export const makeSubscriptionRefresh = <Request, Key, Value, E, R>(
  options: SubscriptionRefreshOptions<Request, Key, Value, E, R>,
): Effect.Effect<SubscriptionRefresh<Request, E, R>> =>
  Effect.gen(function* () {
    const coordinator = yield* makeRefreshCoordinatorWith<Request, E>(options.mergeRequest);
    const revisionRef = yield* SynchronizedRef.make(0);
    const initialWake = yield* Deferred.make<void>();
    const wakeRef = yield* SynchronizedRef.make(initialWake);
    const equals = options.equals ?? Object.is;
    const spanName = options.spanName ?? "pi-cosmic-core.subscription.refresh";

    const wake = Effect.gen(function* () {
      const previous = yield* SynchronizedRef.modifyEffect(wakeRef, (current) =>
        Deferred.make<void>().pipe(Effect.map((next) => [current, next] as const)),
      );
      yield* Deferred.succeed(previous, undefined);
    });

    const invalidate = SynchronizedRef.update(revisionRef, (revision) => revision + 1).pipe(
      Effect.andThen(wake),
      Effect.asVoid,
    );

    const perform = Effect.fn(spanName)(function* (request: Request) {
      const capturedRevision = yield* SynchronizedRef.get(revisionRef);
      const capturedKey = yield* options.currentKey;
      const value = yield* options.fetch(request);
      const currentRevision = yield* SynchronizedRef.get(revisionRef);
      const currentKey = yield* options.currentKey;
      if (capturedRevision !== currentRevision || !equals(capturedKey, currentKey)) return;
      yield* options.commit(value, request);
    });

    const request = (next: Request) => coordinator.run(next, perform);

    const startPolling = (pollRequest: Request) =>
      Effect.gen(function* () {
        while (true) {
          const interval = yield* options.interval;
          const currentWake = yield* SynchronizedRef.get(wakeRef);
          yield* Effect.raceFirst(Effect.sleep(interval), Deferred.await(currentWake));
          yield* request(pollRequest);
        }
      });

    return {
      request,
      invalidate,
      wake,
      startPolling,
      revision: SynchronizedRef.get(revisionRef),
    };
  });
