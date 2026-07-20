import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { makeSubscriptionRefresh, type RefreshRequest } from "../index.ts";

const merge = (current: RefreshRequest | undefined, next: RefreshRequest): RefreshRequest => ({
  force: current?.force === true || next.force === true,
  notify: current?.notify === true || next.notify === true,
});

it.effect("discards a response when its key or revision becomes stale", () =>
  Effect.gen(function* () {
    const key = yield* Ref.make("first");
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const commits: number[] = [];
    const refresh = yield* makeSubscriptionRefresh({
      mergeRequest: merge,
      currentKey: Ref.get(key),
      interval: Effect.succeed(60_000),
      fetch: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(1),
        ),
      commit: (value: number) => Effect.sync(() => commits.push(value)),
    });
    const request = yield* refresh.request({}).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Ref.set(key, "second");
    yield* refresh.invalidate;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(request);
    expect(commits).toEqual([]);
    expect(yield* refresh.revision).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("wakes polling so a shortened interval takes effect immediately", () =>
  Effect.gen(function* () {
    const interval = yield* Ref.make(60_000);
    const calls = yield* Ref.make(0);
    const refresh = yield* makeSubscriptionRefresh({
      mergeRequest: merge,
      currentKey: Effect.succeed("key"),
      interval: Ref.get(interval),
      fetch: () => Ref.updateAndGet(calls, (count) => count + 1),
      commit: () => Effect.void,
    });
    const poller = yield* refresh.startPolling({}).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Ref.set(interval, 1_000);
    yield* refresh.wake;
    yield* Effect.yieldNow;
    expect(yield* Ref.get(calls)).toBe(1);
    yield* TestClock.adjust("1 second");
    yield* Effect.yieldNow;
    expect(yield* Ref.get(calls)).toBe(2);
    yield* Fiber.interrupt(poller);
  }).pipe(Effect.scoped),
);
