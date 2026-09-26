// Host-side Code Mode limits: exact UTF-8 accounting, exact thresholds, single counting.
import { describe, expect, it } from "vitest";
import {
  checkSourceSize,
  clampModelVisibleText,
  makeCumulativeOutputBudget,
  utf8ByteLength,
} from "../src/tools/limits.ts";

describe("UTF-8 truncation", () => {
  it("preserves complete replacement characters and drops only partial code points", () => {
    for (const [text, limit, expected] of [
      ["�x", 3, "�"],
      ["�x", 2, ""],
      ["🙂x", 3, ""],
      ["éx", 2, "é"],
      ["�", 3, "�"],
      ["�", 0, ""],
    ] as const) {
      expect(clampModelVisibleText(text, limit)).toBe(expected);
      const budget = makeCumulativeOutputBudget(limit);
      expect(budget.admitFailure(text)).toBe(expected);
      expect(budget.remaining()).toBe(limit - utf8ByteLength(expected));
      expect(budget.admitFailure("x".repeat(limit + 1))).toBe(
        "x".repeat(limit - utf8ByteLength(expected)),
      );
      expect(budget.remaining()).toBe(0);
    }
  });
});

describe("checkSourceSize", () => {
  it("accepts an exact fit and refuses one byte over", () => {
    expect(checkSourceSize("a".repeat(16), 16)).toBeUndefined();
    const refusal = checkSourceSize("a".repeat(17), 16);
    expect(refusal).toContain("17 UTF-8 bytes");
    expect(refusal).toContain("maxSourceBytes limit of 16");
  });

  it("measures multibyte source in exact UTF-8 bytes", () => {
    // 8 × "🙂" = 32 UTF-8 bytes but only 16 UTF-16 code units.
    const emoji = "🙂".repeat(8);
    expect(checkSourceSize(emoji, 32)).toBeUndefined();
    expect(checkSourceSize(emoji, 31)).toBeDefined();
  });
});

describe("clampModelVisibleText (final model-visible bound)", () => {
  it("admits an exact fit unchanged", () => {
    const text = "a".repeat(64);
    expect(clampModelVisibleText(text, 64)).toBe(text);
    expect(utf8ByteLength(clampModelVisibleText(text, 64))).toBe(64);
  });

  it("truncates one byte over the budget with the marker reserved inside it", () => {
    const clamped = clampModelVisibleText("a".repeat(65), 64);
    expect(utf8ByteLength(clamped)).toBeLessThanOrEqual(64);
    expect(clamped).toContain("[output truncated:");
  });

  it("bare-truncates when even the marker cannot fit", () => {
    const clamped = clampModelVisibleText("b".repeat(200), 8);
    expect(clamped).toBe("b".repeat(8));
    expect(utf8ByteLength(clamped)).toBe(8);
  });
});

describe("makeCumulativeOutputBudget", () => {
  it("admits an exact cumulative fit and counts each admission exactly once", () => {
    const budget = makeCumulativeOutputBudget(10);
    expect(budget.admit("aaaa")).toEqual({ admitted: true });
    expect(budget.admit("bbbb")).toEqual({ admitted: true });
    expect(budget.remaining()).toBe(2);
    // Exact threshold: the remaining 2 bytes are admitted.
    expect(budget.admit("cc").admitted).toBe(true);
    expect(budget.remaining()).toBe(0);
  });

  it("refuses the first overrun deterministically without consuming the budget", () => {
    const budget = makeCumulativeOutputBudget(10);
    expect(budget.admit("aaaaaaaa").admitted).toBe(true);
    const refused = budget.admit("bbb");
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) {
      expect(refused.message).toContain("3 bytes");
      expect(refused.message).toContain("8 of 10 bytes already used");
    }
    // The refusal consumed nothing: an exactly fitting later result still passes.
    expect(budget.remaining()).toBe(2);
    expect(budget.admit("bb").admitted).toBe(true);
    expect(budget.remaining()).toBe(0);
  });

  it("bounds and consumes nested failure text from the same budget", () => {
    const budget = makeCumulativeOutputBudget(7);
    expect(budget.admit("ok").admitted).toBe(true);
    expect(budget.admitFailure("ééé")).toBe("éé");
    expect(budget.remaining()).toBe(1);
    expect(budget.admitFailure("xy")).toBe("x");
    expect(budget.remaining()).toBe(0);
    expect(budget.admitFailure("later")).toBe("");
  });
});
