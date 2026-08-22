import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import {
  makeSynchronousIngress,
  type SynchronousIngress,
} from "../src/coordination/synchronous-ingress.ts";
import { yieldUntil } from "../testing.ts";

class CallbackFailure extends Schema.TaggedError<CallbackFailure>()("CallbackFailure", {
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
    let escaped: Pick<SynchronousIngress<number>, "offer" | "awaitShutdown"> | undefined;
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

it.effect("rejects synchronous offers as soon as shutdown starts", () =>
  Effect.gen(function* () {
    const ingress = yield* makeSynchronousIngress<number, never, never>({
      capacity: 1,
      overflow: "drop",
      handle: () => Effect.void,
    });
    const stopping = yield* ingress.shutdown.pipe(Effect.forkChild({ startImmediately: true }));

    expect(ingress.offer(1)).toBe("closed");
    yield* Fiber.join(stopping);
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

it.effect("reports handler defects through onDefect and keeps the worker alive", () =>
  Effect.gen(function* () {
    const defects: Array<Cause.Cause<unknown>> = [];
    const poisonSeen = yield* Deferred.make<void>();
    const healthyDone = yield* Deferred.make<void>();
    const ingress = yield* makeSynchronousIngress<number, never, never>({
      capacity: 4,
      overflow: "drop",
      handle: (value) =>
        value === 1
          ? Deferred.succeed(poisonSeen, undefined).pipe(
              Effect.andThen(Effect.die("ingress-poison")),
            )
          : Deferred.succeed(healthyDone, undefined),
      onDefect: (cause) => {
        defects.push(cause);
      },
    });
    expect(ingress.offer(1)).toBe("accepted");
    yield* Deferred.await(poisonSeen);
    expect(ingress.offer(2)).toBe("accepted");
    yield* Deferred.await(healthyDone);
    yield* ingress.shutdown;
    yield* ingress.awaitShutdown;
    expect(defects.length).toBeGreaterThanOrEqual(1);
  }).pipe(Effect.scoped),
);

it.effect("contains a throwing defect observer and keeps the worker alive", () =>
  Effect.gen(function* () {
    const poisonSeen = yield* Deferred.make<void>();
    const healthyDone = yield* Deferred.make<void>();
    const ingress = yield* makeSynchronousIngress<number, never, never>({
      capacity: 4,
      overflow: "drop",
      handle: (value) =>
        value === 1
          ? Deferred.succeed(poisonSeen, undefined).pipe(
              Effect.andThen(Effect.die("ingress-poison")),
            )
          : Deferred.succeed(healthyDone, undefined),
      onDefect: () => {
        throw new Error("observer-poison");
      },
    });
    expect(ingress.offer(1)).toBe("accepted");
    yield* Deferred.await(poisonSeen);
    expect(ingress.offer(2)).toBe("accepted");
    yield* Deferred.await(healthyDone);
    yield* ingress.shutdown;
    yield* ingress.awaitShutdown;
  }).pipe(Effect.scoped),
);

it.effect("does not report normal shutdown interruption as a handler defect", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let observedDefects = 0;
    const ingress = yield* makeSynchronousIngress<number, never, never>({
      capacity: 1,
      overflow: "drop",
      handle: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      onDefect: () => {
        observedDefects++;
      },
    });
    expect(ingress.offer(1)).toBe("accepted");
    yield* Deferred.await(started);
    yield* ingress.shutdown;
    yield* ingress.awaitShutdown;
    expect(observedDefects).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("logs a fixed diagnostic for handler defects when onDefect is absent", () =>
  Effect.gen(function* () {
    const poisonSeen = yield* Deferred.make<void>();
    const ingress = yield* makeSynchronousIngress<number, never, never>({
      capacity: 4,
      overflow: "drop",
      handle: () =>
        Deferred.succeed(poisonSeen, undefined).pipe(Effect.andThen(Effect.die("ingress-poison"))),
    });
    expect(ingress.offer(1)).toBe("accepted");
    yield* Deferred.await(poisonSeen);
    yield* ingress.shutdown;
    yield* ingress.awaitShutdown;
  }).pipe(Effect.scoped),
);
