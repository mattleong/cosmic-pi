import { describe, expect, it } from "vitest";
import { screenViewport } from "../src/manager/viewport.ts";

describe("screen viewport", () => {
  it.each([
    [0, 0, 0, 0, false],
    [1, 3, 1, 3, false],
    [-1, Number.NaN, 0, 0, false],
    [Number.POSITIVE_INFINITY, 24.9, 0, 24, false],
  ])("allocates %d×%d as %i×%i", (columns, rows, width, height, inset) => {
    expect(screenViewport({ columns, rows })).toEqual({ width, height, inset });
  });
});
