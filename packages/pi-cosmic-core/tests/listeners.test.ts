import { expect, it } from "@effect/vitest";
import { notifyListeners } from "../src/coordination/listeners.ts";

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
