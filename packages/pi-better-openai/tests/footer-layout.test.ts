import { describe, expect, test } from "vitest";
import {
  combineInlinePetFooter,
  isInlinePetPlacement,
  isTerminalImageLine,
  petSizeCellsForPlacement,
} from "../src/footer-layout.ts";
import { stripAnsi, visibleWidth } from "../src/format.ts";

describe("footer layout helpers", () => {
  test("classifies inline placements and caps badge size", () => {
    expect(isInlinePetPlacement("inline-left")).toBe(true);
    expect(isInlinePetPlacement("inline-right")).toBe(true);
    expect(isInlinePetPlacement("badge")).toBe(true);
    expect(isInlinePetPlacement("stacked")).toBe(false);
    expect(isInlinePetPlacement("habitat")).toBe(false);
    expect(petSizeCellsForPlacement("badge", 10)).toBe(6);
    expect(petSizeCellsForPlacement("inline-right", 10)).toBe(10);
  });

  test("keeps text pets on the requested side and clips to the available width", () => {
    const left = combineInlinePetFooter(["P"], ["abcdefghijk"], 10, "inline-left", 2);
    const right = combineInlinePetFooter(["P"], ["abcdefghijk"], 10, "inline-right", 2);

    expect(stripAnsi(left[0]!)).toBe("P   abc...");
    expect(stripAnsi(right[0]!)).toBe("abc...  P ");
    expect(visibleWidth(left[0]!)).toBe(10);
    expect(visibleWidth(right[0]!)).toBe(10);
  });

  test("recognizes both supported terminal image protocols", () => {
    expect(isTerminalImageLine("\x1b_Ga=p,i=1\x1b\\")).toBe(true);
    expect(isTerminalImageLine("\x1b]1337;File=inline=1:AAAA\x07")).toBe(true);
    expect(isTerminalImageLine("plain text")).toBe(false);
  });
});
