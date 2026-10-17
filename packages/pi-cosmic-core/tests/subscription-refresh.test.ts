import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { createSubscriptionRefresh } from "../index.ts";
import { yieldUntil } from "../testing.ts";

it.effect("discards a response when its key or revision becomes stale", () =>
  Effect.gen(function* () {
    const key = yield* Ref.make("first");
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const commits: number[] = [];
    const refresh = yield* createSubscriptionRefresh({
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
    yield* refresh.invalidateWith(Effect.void);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(request);
    expect(commits).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("allows a commit to invalidate the refresh without deadlocking its gate", () =>
  Effect.gen(function* () {
    const committed = yield* Deferred.make<void>();
    let invalidate: Effect.Effect<void> = Effect.void;
    const refresh = yield* createSubscriptionRefresh({
      currentKey: Effect.succeed("key"),
      interval: Effect.succeed(60_000),
      fetch: () => Effect.succeed(1),
      commit: () =>
        invalidate.pipe(Effect.andThen(Deferred.succeed(committed, undefined)), Effect.asVoid),
    });
    invalidate = refresh.invalidateWith(Effect.void);

    const request = yield* refresh.request({}).pipe(Effect.forkScoped);
    for (let turn = 0; turn < 10 && !(yield* Deferred.isDone(committed)); turn++)
      yield* Effect.yieldNow;

    expect(yield* Deferred.isDone(committed)).toBe(true);
    yield* Fiber.join(request);
  }).pipe(Effect.scoped),
);

it.effect("keeps polling after the refresh it joined is interrupted", () =>
  Effect.gen(function* () {
    const ownerStarted = yield* Deferred.make<void>();
    const polled = yield* Deferred.make<void>();
    let intervalReads = 0;
    let calls = 0;
    const refresh = yield* createSubscriptionRefresh({
      currentKey: Effect.succeed("key"),
      interval: Effect.sync(() => ++intervalReads).pipe(Effect.as(1_000)),
      fetch: () =>
        ++calls === 1
          ? Deferred.succeed(ownerStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Deferred.succeed(polled, undefined),
      commit: () => Effect.void,
    });
    const owner = yield* refresh.request({}).pipe(Effect.forkScoped);
    yield* Deferred.await(ownerStarted);
    const poller = yield* refresh.startPolling({}).pipe(Effect.forkScoped);
    yield* yieldUntil(() => intervalReads === 1);
    yield* TestClock.adjust("1 second");
    for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
    yield* Fiber.interrupt(owner);
    yield* yieldUntil(() => intervalReads === 2);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(polled);
    expect(calls).toBe(2);
    yield* Fiber.interrupt(poller);
  }).pipe(Effect.scoped),
);
