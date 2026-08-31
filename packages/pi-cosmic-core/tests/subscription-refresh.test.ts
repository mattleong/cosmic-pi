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

it.effect("does not retain a wake pulse emitted before polling waits", () =>
  Effect.gen(function* () {
    const intervalRead = yield* Deferred.make<void>();
    const fetched = yield* Deferred.make<void>();
    const calls = yield* Ref.make(0);
    const refresh = yield* makeSubscriptionRefresh({
      mergeRequest: merge,
      currentKey: Effect.succeed("key"),
      interval: Deferred.succeed(intervalRead, undefined).pipe(Effect.as(1_000)),
      fetch: () =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.tap(() => Deferred.succeed(fetched, undefined)),
        ),
      commit: () => Effect.void,
    });

    yield* refresh.wake;
    const poller = yield* refresh.startPolling({}).pipe(Effect.forkScoped);
    yield* Deferred.await(intervalRead);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("999 millis");
    expect(yield* Ref.get(calls)).toBe(0);
    yield* TestClock.adjust("1 millis");
    yield* Deferred.await(fetched);
    expect(yield* Ref.get(calls)).toBe(1);
    yield* Fiber.interrupt(poller);
  }).pipe(Effect.scoped),
);

it.effect("releases the current polling wait and applies the next interval", () =>
  Effect.gen(function* () {
    const interval = yield* Ref.make(60_000);
    const intervalReads = yield* Ref.make(0);
    const firstWaitReady = yield* Deferred.make<void>();
    const secondWaitReady = yield* Deferred.make<void>();
    const firstFetch = yield* Deferred.make<void>();
    const secondFetch = yield* Deferred.make<void>();
    const calls = yield* Ref.make(0);
    const refresh = yield* makeSubscriptionRefresh({
      mergeRequest: merge,
      currentKey: Effect.succeed("key"),
      interval: Effect.gen(function* () {
        const read = yield* Ref.updateAndGet(intervalReads, (count) => count + 1);
        if (read === 1) yield* Deferred.succeed(firstWaitReady, undefined);
        if (read === 2) yield* Deferred.succeed(secondWaitReady, undefined);
        return yield* Ref.get(interval);
      }),
      fetch: () =>
        Effect.gen(function* () {
          const call = yield* Ref.updateAndGet(calls, (count) => count + 1);
          if (call === 1) yield* Deferred.succeed(firstFetch, undefined);
          if (call === 2) yield* Deferred.succeed(secondFetch, undefined);
          return call;
        }),
      commit: () => Effect.void,
    });

    const poller = yield* refresh.startPolling({}).pipe(Effect.forkScoped);
    yield* Deferred.await(firstWaitReady);
    yield* Effect.yieldNow;
    yield* Ref.set(interval, 1_000);
    yield* refresh.wake;
    yield* Deferred.await(firstFetch);
    yield* Deferred.await(secondWaitReady);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("999 millis");
    expect(yield* Ref.get(calls)).toBe(1);
    yield* TestClock.adjust("1 millis");
    yield* Deferred.await(secondFetch);
    expect(yield* Ref.get(calls)).toBe(2);
    yield* Fiber.interrupt(poller);
  }).pipe(Effect.scoped),
);

it.effect("serializes final validation and commit with invalidation", () =>
  Effect.gen(function* () {
    const validationStarted = yield* Deferred.make<void>();
    const releaseValidation = yield* Deferred.make<void>();
    const invalidationFinished = yield* Deferred.make<void>();
    const events: string[] = [];
    let keyReads = 0;
    const refresh = yield* makeSubscriptionRefresh({
      mergeRequest: merge,
      currentKey: Effect.suspend(() => {
        keyReads++;
        return keyReads === 2
          ? Deferred.succeed(validationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseValidation)),
              Effect.as("key"),
            )
          : Effect.succeed("key");
      }),
      interval: Effect.succeed(60_000),
      fetch: () => Effect.succeed(1),
      commit: () => Effect.sync(() => events.push("commit")),
    });

    const request = yield* refresh.request({}).pipe(Effect.forkScoped);
    yield* Deferred.await(validationStarted);
    const invalidation = yield* refresh.invalidate.pipe(
      Effect.andThen(Effect.sync(() => events.push("invalidate"))),
      Effect.andThen(Deferred.succeed(invalidationFinished, undefined)),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    expect(yield* Deferred.isDone(invalidationFinished)).toBe(false);

    yield* Deferred.succeed(releaseValidation, undefined);
    yield* Fiber.join(request);
    yield* Fiber.join(invalidation);
    expect(events).toEqual(["commit", "invalidate"]);
    expect(yield* refresh.revision).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("allows a commit to invalidate the refresh without deadlocking its gate", () =>
  Effect.gen(function* () {
    const committed = yield* Deferred.make<void>();
    let invalidate: Effect.Effect<void> = Effect.void;
    const refresh = yield* makeSubscriptionRefresh({
      mergeRequest: merge,
      currentKey: Effect.succeed("key"),
      interval: Effect.succeed(60_000),
      fetch: () => Effect.succeed(1),
      commit: () =>
        invalidate.pipe(Effect.andThen(Deferred.succeed(committed, undefined)), Effect.asVoid),
    });
    invalidate = refresh.invalidate;

    const request = yield* refresh.request({}).pipe(Effect.forkScoped);
    for (let turn = 0; turn < 10 && !(yield* Deferred.isDone(committed)); turn++)
      yield* Effect.yieldNow;

    expect(yield* Deferred.isDone(committed)).toBe(true);
    yield* Fiber.join(request);
    expect(yield* refresh.revision).toBe(1);
  }).pipe(Effect.scoped),
);
