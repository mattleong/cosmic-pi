import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import { freezeSnapshot, makeFrozenProjection, ProjectionError } from "../src/projection.ts";

it.effect("commits authoritative state when interrupted at publication", () =>
  Effect.gen(function* () {
    let published = 0;
    let interrupted = false;
    const projection = yield* makeFrozenProjection(
      0,
      (n) => n,
      (n) => {
        published = n;
      },
    );
    const scheduler = new Scheduler.MixedScheduler();
    const commitScheduler: Scheduler.Scheduler = {
      executionMode: scheduler.executionMode,
      makeDispatcher: () => scheduler.makeDispatcher(),
      shouldYield: (fiber) => {
        if (published === 1 && !interrupted) {
          interrupted = true;
          fiber.interruptUnsafe();
          return true;
        }
        return false;
      },
    };
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
    const projection = yield* makeFrozenProjection(0, (n) => n);
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

class TransitionFailure extends Schema.TaggedError<TransitionFailure>()("TransitionFailure", {
  message: Schema.String,
}) {}

interface DirectCycleFixture {
  self?: unknown;
}

interface IndirectCycleFixture {
  child: { parent?: unknown };
}

it.effect("publishes cloned deeply frozen plain snapshots", () =>
  Effect.gen(function* () {
    const state = { count: 1, nested: { values: ["a"] } };
    const projection = yield* makeFrozenProjection(state, (current) => current);
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

it("allows acyclic shared references while preserving snapshot identity", () => {
  const shared = { value: 1 };
  const snapshot = freezeSnapshot({ left: shared, right: shared });

  expect(snapshot.left).toBe(snapshot.right);
  expect(snapshot.left).not.toBe(shared);
  expect(Object.isFrozen(snapshot.left)).toBe(true);
});

it.each([
  ["NaN", Number.NaN],
  ["positive infinity", Number.POSITIVE_INFINITY],
  ["negative infinity", Number.NEGATIVE_INFINITY],
])("rejects %s as a typed projection failure", (_name, value) => {
  try {
    freezeSnapshot({ nested: value });
    throw new Error("expected projection failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectionError);
    if (!(error instanceof ProjectionError)) throw error;
    expect(error.path).toBe("$.nested");
    expect(error.message).toContain("non-finite number");
  }
});

it("rejects direct and indirect cycles with the offending path", () => {
  const direct: DirectCycleFixture = {};
  direct.self = direct;
  expect(() => freezeSnapshot(direct)).toThrow("cyclic reference to $");

  const root: IndirectCycleFixture = { child: {} };
  root.child.parent = root;
  try {
    freezeSnapshot(root);
    throw new Error("expected projection failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectionError);
    if (!(error instanceof ProjectionError)) throw error;
    expect(error.path).toBe("$.child.parent");
    expect(error.message).toContain("cyclic reference to $");
  }

  const array: unknown[] = [];
  array.push(array);
  expect(() => freezeSnapshot(array)).toThrow("$[0]");
});

it("preserves an own __proto__ property without changing the clone prototype", () => {
  const source = Object.defineProperty({ ok: true }, "__proto__", {
    value: { polluted: true },
    enumerable: true,
  });
  const snapshot = freezeSnapshot(source);

  expect(Object.hasOwn(snapshot, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(snapshot, "__proto__")?.value).toEqual({ polluted: true });
  expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
  expect("polluted" in snapshot).toBe(false);
  expect(Object.isFrozen(Object.getOwnPropertyDescriptor(snapshot, "__proto__")?.value)).toBe(true);
});

it.effect("does not publish or commit a failed transition", () =>
  Effect.gen(function* () {
    const projection = yield* makeFrozenProjection({ count: 1 }, (state) => ({
      count: state.count,
    }));
    const before = projection.getSnapshot();
    const result = yield* projection
      .transition(() => new TransitionFailure({ message: "expected" }))
      .pipe(Effect.result);

    expect(result._tag).toBe("Failure");
    expect(projection.getSnapshot()).toBe(before);
    expect((yield* projection.getState).count).toBe(1);
  }),
);

it.effect("rejects invalid projection preparation without committing and releases the lock", () =>
  Effect.gen(function* () {
    let published = 0;
    const projection = yield* makeFrozenProjection(
      0,
      (n) => (n === 1 ? Number.NaN : n),
      (n) => {
        published = n;
      },
    );
    const result = yield* projection
      .transition(() => Effect.succeed([undefined, 1] as const))
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(yield* projection.getState).toBe(0);
    expect(projection.getSnapshot()).toBe(0);
    expect(published).toBe(0);
    yield* projection.transition((n) => Effect.succeed([undefined, n + 2] as const));
    expect(yield* projection.getState).toBe(2);
    expect(projection.getSnapshot()).toBe(2);
    expect(published).toBe(2);
  }),
);

it.effect("serializes transitions and publishes each successful next state", () =>
  Effect.gen(function* () {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const projection = yield* makeFrozenProjection({ values: [] as number[] }, (state) => state);
    yield* projection.transition((state) =>
      Effect.succeed([undefined, { values: [...state.values, 1] }] as const),
    );
    yield* projection.transition((state) =>
      Effect.succeed([undefined, { values: [...state.values, 2] }] as const),
    );
    expect(projection.getSnapshot().values).toEqual([1, 2]);
  }),
);

it.each([
  ["symbol", { nested: [Symbol("capability")] }, "$.nested[0]"],
  ["bigint", { value: 1n }, "$.value"],
  ["Map", { capability: new Map() }, "$.capability"],
  [
    "accessor",
    Object.defineProperty({}, "secret", { get: () => "value", enumerable: true }),
    "$.secret",
  ],
  [
    "non-enumerable function",
    { nested: Object.defineProperty({}, "capability", { value: () => 42 }) },
    "$.nested.capability",
  ],
  ["array function property", Object.assign([], { capability: () => 42 }), "$"],
  ["array symbol property", Object.assign([], { [Symbol("capability")]: true }), "$"],
])("rejects nested %s snapshot capabilities with their path", (_name, value, path) => {
  expect(() => freezeSnapshot(value)).toThrow(path);
});

it("reports unsupported values as typed projection failures", () => {
  try {
    freezeSnapshot({ nested: { capability: () => 42 } });
    throw new Error("expected projection failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectionError);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    expect((error as ProjectionError).path).toBe("$.nested.capability");
  }
});

it("rejects symbol-keyed snapshot properties", () => {
  expect(() => freezeSnapshot({ [Symbol("capability")]: true })).toThrow("symbol-keyed property");
});

it.effect("does not commit or publish when external publication fails", () =>
  Effect.gen(function* () {
    let published = 0;
    const projection = yield* makeFrozenProjection(
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
