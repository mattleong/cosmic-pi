import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeSynchronousIngress, type SynchronousIngress } from "../src/synchronous-ingress.ts";
import { yieldUntil } from "../testing.ts";

class CallbackFailure extends Schema.TaggedErrorClass<CallbackFailure>()("CallbackFailure", {
  message: Schema.String,
}) {}

it.effect("drains accepted values in offer order and reports dropped overflow", () =>
  Effect.gen(function* () {
    const values: number[] = [];
    const ingress = yield* makeSynchronousIngress<number, never, never>({
      capacity: 2,
      overflow: "drop",
      handle: (value) => Effect.sync(() => void values.push(value)),
    });
    const offered = yield* Effect.sync(() => [
      ingress.offer(1),
      ingress.offer(2),
      ingress.offer(3),
    ]);
    expect(offered).toEqual(["accepted", "accepted", "dropped"]);
    yield* yieldUntil(() => values.length >= 2);
    expect(values).toEqual([1, 2]);
    yield* ingress.shutdown;
  }),
);

it.effect("keeps the latest coalesced value behind already queued work", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const releaseSecond = yield* Deferred.make<void>();
    const handledLatest = yield* Deferred.make<void>();
    const values: number[] = [];
    const ingress = yield* makeSynchronousIngress<number, never, never>({
      capacity: 1,
      overflow: "coalesce-latest",
      handle: (value) =>
        Effect.gen(function* () {
          values.push(value);
          if (value === 1) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          } else if (value === 2) {
            yield* Deferred.succeed(secondStarted, undefined);
            yield* Deferred.await(releaseSecond);
          } else if (value === 4) {
            yield* Deferred.succeed(handledLatest, undefined);
          }
        }),
    });

    expect(ingress.offer(1)).toBe("accepted");
    yield* Deferred.await(firstStarted);
    expect(ingress.offer(2)).toBe("accepted");
    expect(ingress.offer(3)).toBe("coalesced");
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Deferred.await(secondStarted);
    expect(ingress.offer(4)).toBe("coalesced");
    yield* Deferred.succeed(releaseSecond, undefined);
    yield* Deferred.await(handledLatest);
    yield* Effect.yieldNow;

    expect(values).toEqual([1, 2, 4]);
    yield* ingress.shutdown;
  }),
);

it.effect("rejects non-finite and non-integer capacities", () =>
  Effect.gen(function* () {
    for (const capacity of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const result = yield* makeSynchronousIngress<number, never, never>({
        capacity,
        overflow: "drop",
        handle: () => Effect.void,
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }
  }),
);

it.effect("isolates callback and failure-observer failures", () =>
  Effect.gen(function* () {
    const handled: number[] = [];
    const failures: string[] = [];
    const ingress = yield* makeSynchronousIngress<number, CallbackFailure, never>({
      capacity: 4,
      overflow: "drop",
      handle: (value) =>
        value === 1
          ? new CallbackFailure({ message: "expected" })
          : Effect.sync(() => void handled.push(value)),
      onFailure: (error) =>
        Effect.sync(() => void failures.push(error.message)).pipe(
          Effect.andThen(Effect.die("hostile failure observer")),
        ),
    });
    yield* Effect.sync(() => {
      ingress.offer(1);
      ingress.offer(2);
    });
    yield* yieldUntil(() => handled.length >= 1);
    expect(failures).toEqual(["expected"]);
    expect(handled).toEqual([2]);
    yield* ingress.shutdown;
  }),
);

it.effect("keeps draining after a handler throws while constructing its Effect", () =>
  Effect.gen(function* () {
    const handled: number[] = [];
    const ingress = yield* makeSynchronousIngress<number, never, never>({
      capacity: 2,
      overflow: "drop",
      handle: (value) => {
        if (value === 1) throw new Error("hostile handler factory");
        return Effect.sync(() => void handled.push(value));
      },
    });

    expect(ingress.offer(1)).toBe("accepted");
    expect(ingress.offer(2)).toBe("accepted");
    yield* yieldUntil(() => handled.length === 1);

    expect(handled).toEqual([2]);
    yield* ingress.shutdown;
  }),
);

it.effect("scope closure interrupts a waiting worker and returns promptly", () =>
  Effect.gen(function* () {
    let escaped: SynchronousIngress<number> | undefined;
    yield* Effect.scoped(
      Effect.gen(function* () {
        escaped = yield* makeSynchronousIngress<number, never, never>({
          capacity: 1,
          overflow: "drop",
          handle: () => Effect.void,
        });
        yield* Effect.yieldNow;
      }),
    ).pipe(Effect.timeout("500 millis"));
    yield* escaped!.awaitShutdown.pipe(Effect.timeout("500 millis"));
    expect(escaped!.offer(1)).toBe("closed");
  }),
);

it.effect("scope closure interrupts an active handler with no surviving worker", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    let escaped:
      | { readonly offer: (value: number) => unknown; readonly awaitShutdown: Effect.Effect<void> }
      | undefined;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const ingress = yield* makeSynchronousIngress<number, never, never>({
          capacity: 1,
          overflow: "drop",
          handle: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)),
            ),
        });
        escaped = ingress;
        expect(ingress.offer(1)).toBe("accepted");
        yield* Deferred.await(started);
      }),
    ).pipe(Effect.timeout("500 millis"));
    yield* Deferred.await(interrupted).pipe(Effect.timeout("500 millis"));
    yield* escaped!.awaitShutdown.pipe(Effect.timeout("500 millis"));
    expect(escaped!.offer(2)).toBe("closed");
  }),
);

it.effect("explicit shutdown interrupts an idle waiting worker", () =>
  Effect.gen(function* () {
    const ingress = yield* makeSynchronousIngress<number, never, never>({
      capacity: 1,
      overflow: "drop",
      handle: () => Effect.void,
    });
    yield* ingress.shutdown.pipe(Effect.timeout("500 millis"));
    yield* ingress.awaitShutdown.pipe(Effect.timeout("500 millis"));
    expect(ingress.offer(1)).toBe("closed");
  }),
);

it.effect("shutdown rejects offers and leaves no surviving worker fiber", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const ingress = yield* makeSynchronousIngress<number, never, never>({
      capacity: 1,
      overflow: "drop",
      handle: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)),
        ),
    });
    expect(ingress.offer(1)).toBe("accepted");
    yield* Deferred.await(started);
    yield* ingress.shutdown;
    yield* ingress.awaitShutdown;
    yield* Deferred.await(interrupted);
    expect(ingress.offer(2)).toBe("closed");
    yield* ingress.shutdown;
  }),
);
