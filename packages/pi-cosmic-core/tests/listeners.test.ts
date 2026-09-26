import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { notifyListeners, scopedListener } from "../src/coordination/listeners.ts";

it("notifies a snapshot, skips listeners removed mid-delivery, and contains throws", () => {
  const delivered: string[] = [];
  const listeners = new Set<(value: string) => void>();
  const late = (value: string) => void delivered.push(`late:${value}`);
  const removed = (value: string) => void delivered.push(`removed:${value}`);
  listeners.add((value) => {
    delivered.push(`first:${value}`);
    listeners.delete(removed);
    listeners.add(late);
    throw new Error("hostile listener");
  });
  listeners.add(removed);
  notifyListeners(listeners, "one");
  notifyListeners(listeners, "two");
  expect(delivered).toEqual(["first:one", "first:two", "late:two"]);
});

it.effect("registers a listener for exactly its scope through the guard", () =>
  Effect.gen(function* () {
    const listeners = new Set<() => void>();
    const listener = () => undefined;
    let guarded = 0;
    const guard = (step: Effect.Effect<void>) =>
      Effect.sync(() => guarded++).pipe(Effect.andThen(step));
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* scopedListener(listeners, listener, guard);
        expect(listeners.has(listener)).toBe(true);
      }),
    );
    expect(listeners.has(listener)).toBe(false);
    expect(guarded).toBe(2);
  }),
);
