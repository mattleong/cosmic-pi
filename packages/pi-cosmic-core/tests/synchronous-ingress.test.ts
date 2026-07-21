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

it.effect("coalesces overflow to the latest value", () =>
  Effect.gen(function* () {
    const values: number[] = [];
    const ingress = yield* makeSynchronousIngress<number, never, never>({
      capacity: 2,
      overflow: "coalesce-latest",
      handle: (value) => Effect.sync(() => void values.push(value)),
    });
    const offered = yield* Effect.sync(() => [
      ingress.offer(1),
      ingress.offer(2),
      ingress.offer(3),
      ingress.offer(4),
    ]);
    expect(offered).toEqual(["accepted", "accepted", "coalesced", "coalesced"]);
    yield* yieldUntil(() => values.length >= 3);
    expect(values).toEqual([1, 2, 4]);
    yield* ingress.shutdown;
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
