import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import { freezeSnapshot, frozenProjection } from "../src/projection.ts";
import { interruptingScheduler } from "../testing.ts";

it.effect("commits authoritative state when interrupted at publication", () =>
  Effect.gen(function* () {
    let published = 0;
    let interrupted = false;
    const projection = yield* frozenProjection(
      0,
      (n) => n,
      (n) => {
        published = n;
      },
    );
    const commitScheduler = interruptingScheduler(
      () => published === 1 && !interrupted && (interrupted = true),
    );
    const fiber = yield* projection
      .transition(() => Effect.succeed([undefined, 1] as const))
      .pipe(Effect.provideService(Scheduler.Scheduler, commitScheduler), Effect.forkScoped);
    yield* Fiber.await(fiber);
    expect(interrupted).toBe(true);
    expect(published).toBe(1);
    expect(projection.getSnapshot()).toBe(published);
    expect(yield* projection.getState).toBe(published);
  }),
);

it.effect("interrupts lock wait and update work without blocking later transitions", () =>
  Effect.gen(function* () {
    const projection = yield* frozenProjection(
      0,
      (n) => n,
      () => undefined,
    );
    const started = yield* Deferred.make<void>();
    const owner = yield* projection
      .transition(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    let waitingUpdateRan = false;
    const waiter = yield* projection
      .transition((n) =>
        Effect.sync(() => {
          waitingUpdateRan = true;
          return [undefined, n + 1] as const;
        }),
      )
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(waiter);
    expect(waitingUpdateRan).toBe(false);
    yield* Fiber.interrupt(owner);
    expect(yield* projection.getState).toBe(0);
    yield* Effect.all(
      Array.from({ length: 20 }, () =>
        projection.transition((n) => Effect.yieldNow.pipe(Effect.as([undefined, n + 1] as const))),
      ),
      { concurrency: "unbounded" },
    );
    expect(yield* projection.getState).toBe(20);
    expect(projection.getSnapshot()).toBe(20);
  }),
);

it.effect("publishes cloned deeply frozen plain snapshots", () =>
  Effect.gen(function* () {
    const state = { count: 1, nested: { values: ["a"] } };
    const projection = yield* frozenProjection(
      state,
      (current) => current,
      () => undefined,
    );
    const snapshot = projection.getSnapshot();

    expect(snapshot).not.toBe(state);
    expect(snapshot.nested).not.toBe(state.nested);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nested)).toBe(true);
    expect(Object.isFrozen(snapshot.nested.values)).toBe(true);

    state.nested.values.push("state-only");
    expect(snapshot.nested.values).toEqual(["a"]);
  }),
);

it("preserves an own __proto__ property without changing the clone prototype", () => {
  const source = Object.defineProperty({ ok: true }, "__proto__", {
    value: { polluted: true },
    enumerable: true,
  });
  const snapshot = freezeSnapshot(source);

  expect(Rec.has<string, unknown>(snapshot, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(snapshot, "__proto__")?.value).toEqual({ polluted: true });
  expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
  expect("polluted" in snapshot).toBe(false);
  expect(Object.isFrozen(Object.getOwnPropertyDescriptor(snapshot, "__proto__")?.value)).toBe(true);
});

it.effect("does not commit or publish when external publication fails", () =>
  Effect.gen(function* () {
    let published = 0;
    const projection = yield* frozenProjection(
      { count: 1 },
      (state) => state,
      (snapshot) => {
        if (snapshot.count === 2) throw new Error("renderer unavailable");
        published = snapshot.count;
      },
    );
    const result = yield* projection
      .transition(() => Effect.succeed([undefined, { count: 2 }] as const))
      .pipe(Effect.result);

    expect(result._tag).toBe("Failure");
    expect(published).toBe(1);
    expect(projection.getSnapshot().count).toBe(1);
    expect((yield* projection.getState).count).toBe(1);
  }),
);
