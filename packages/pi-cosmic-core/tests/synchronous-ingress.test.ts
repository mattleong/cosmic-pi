import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  makeSynchronousIngress,
  type SynchronousIngress,
} from "../src/coordination/synchronous-ingress.ts";
import { capturedTelemetrySnapshot, makeCapturedLogger, yieldUntil } from "../testing.ts";

it.effect("drains accepted values in offer order and reports dropped overflow", () =>
  Effect.gen(function* () {
    const values: number[] = [];
    const ingress = yield* makeSynchronousIngress<number, never>({
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
    const ingress = yield* makeSynchronousIngress<number, never>({
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
      const result = yield* makeSynchronousIngress<number, never>({
        capacity,
        overflow: "drop",
        handle: () => Effect.void,
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }
  }),
);

it.effect("keeps draining after a handler throws while constructing its Effect", () =>
  Effect.gen(function* () {
    const handled: number[] = [];
    const ingress = yield* makeSynchronousIngress<number, never>({
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

for (const trigger of ["scope", "shutdown"] as const) {
  for (const active of [false, true]) {
    it.effect(
      `${trigger} closure interrupts ${active ? "an active handler" : "an idle worker"}`,
      () =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const interrupted = yield* Deferred.make<void>();
          const create = makeSynchronousIngress<number, never>({
            capacity: 1,
            overflow: "drop",
            handle: () =>
              active
                ? Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)),
                  )
                : Effect.void,
          });
          const begin = (ingress: SynchronousIngress<number>) =>
            active
              ? Effect.sync(() => expect(ingress.offer(1)).toBe("accepted")).pipe(
                  Effect.andThen(Deferred.await(started)),
                )
              : Effect.yieldNow;
          const ingress = yield* trigger === "scope"
            ? Effect.scoped(create.pipe(Effect.tap(begin)))
            : create.pipe(
                Effect.tap((ingress) =>
                  begin(ingress).pipe(
                    Effect.andThen(ingress.shutdown),
                    Effect.andThen(ingress.shutdown),
                  ),
                ),
              );
          if (active) yield* Deferred.await(interrupted);
          expect(ingress.offer(2)).toBe("closed");
        }),
    );
  }
}

it.effect("rejects synchronous offers as soon as shutdown starts", () =>
  Effect.gen(function* () {
    const ingress = yield* makeSynchronousIngress<number, never>({
      capacity: 1,
      overflow: "drop",
      handle: () => Effect.void,
    });
    const stopping = yield* ingress.shutdown.pipe(Effect.forkChild({ startImmediately: true }));

    expect(ingress.offer(1)).toBe("closed");
    yield* Fiber.join(stopping);
  }),
);

it.effect("logs a cause-free diagnostic for handler defects and keeps the worker alive", () => {
  const logger = makeCapturedLogger();
  return Effect.gen(function* () {
    const poisonSeen = yield* Deferred.make<void>();
    const healthyDone = yield* Deferred.make<void>();
    const ingress = yield* makeSynchronousIngress<number, never>({
      capacity: 4,
      overflow: "drop",
      handle: (value) =>
        value === 1
          ? Deferred.succeed(poisonSeen, undefined).pipe(
              Effect.andThen(Effect.die("ingress-poison")),
            )
          : Deferred.succeed(healthyDone, undefined),
    });
    expect(ingress.offer(1)).toBe("accepted");
    yield* Deferred.await(poisonSeen);
    expect(ingress.offer(2)).toBe("accepted");
    yield* Deferred.await(healthyDone);
    yield* ingress.shutdown;
    expect(logger.entries).toHaveLength(1);
    expect(capturedTelemetrySnapshot(logger)).not.toContain("ingress-poison");
  }).pipe(Effect.provide(logger.layer));
});

it.effect("does not report normal shutdown interruption as a handler defect", () => {
  const logger = makeCapturedLogger();
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const ingress = yield* makeSynchronousIngress<number, never>({
      capacity: 1,
      overflow: "drop",
      handle: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    });
    expect(ingress.offer(1)).toBe("accepted");
    yield* Deferred.await(started);
    yield* ingress.shutdown;
    expect(logger.entries).toEqual([]);
  }).pipe(Effect.provide(logger.layer));
});
