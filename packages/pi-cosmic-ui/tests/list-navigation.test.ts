import { describe, expect, it } from "vitest";
import {
  isListMotion,
  movementOffset,
  nextListMotionIndex,
} from "../src/manager/list-navigation.ts";

describe("list navigation", () => {
  const steps = { page: 8, half: 4 };

  it("recognizes list motions and computes signed page offsets", () => {
    expect(isListMotion("half-page-down")).toBe(true);
    expect(isListMotion("confirm")).toBe(false);
    expect(movementOffset("half-page-up", steps)).toBe(-4);
    expect(movementOffset("full-page-down", steps)).toBe(8);
  });

  it("clamps page motions and optionally wraps row motions", () => {
    expect(nextListMotionIndex("full-page-down", 7, 10, steps)).toBe(9);
    expect(nextListMotionIndex("half-page-up", 2, 10, steps)).toBe(0);
    expect(nextListMotionIndex("up", 0, 3, steps, true)).toBe(2);
    expect(nextListMotionIndex("down", 2, 3, steps, true)).toBe(0);
    expect(nextListMotionIndex("last", 0, 0, steps)).toBe(0);
  });
});
