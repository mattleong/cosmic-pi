import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { freezeSnapshot, makeFrozenProjection, ProjectionError } from "../src/projection.ts";

class TransitionFailure extends Schema.TaggedErrorClass<TransitionFailure>()("TransitionFailure", {
  message: Schema.String,
}) {}

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

it.effect("serializes transitions and publishes each successful next state", () =>
  Effect.gen(function* () {
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
