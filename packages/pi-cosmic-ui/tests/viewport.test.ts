import { describe, expect, it } from "vitest";
import { screenViewport } from "../src/manager/viewport.ts";

describe("screen viewport", () => {
  it.each([
    [200, 60, 180, 54, true],
    [160, 40, 144, 36, true],
    [125, 30, 112, 27, true],
    [126, 31, 113, 27, true],
    [124, 40, 124, 40, false],
    [160, 29, 160, 29, false],
    [80, 60, 80, 60, false],
    [0, 0, 0, 0, false],
    [1, 3, 1, 3, false],
    // Unusable and fractional terminal dimensions stay bounded.
    [-1, Number.NaN, 0, 0, false],
    [Number.POSITIVE_INFINITY, 24.9, 0, 24, false],
    [124.9, 30, 124, 30, false],
  ])("allocates %d×%d as %i×%i", (columns, rows, width, height, inset) => {
    expect(screenViewport({ columns, rows })).toEqual({ width, height, inset });
  });
});
