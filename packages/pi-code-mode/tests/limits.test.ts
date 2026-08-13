// Host-side Code Mode limits: exact UTF-8 accounting, exact thresholds, single counting.
import { describe, expect, it } from "vitest";
import {
  checkSourceSize,
  clampModelVisibleText,
  makeCumulativeOutputBudget,
  utf8ByteLength,
} from "../src/tools/limits.ts";

describe("utf8ByteLength", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("→")).toBe(3);
    expect(utf8ByteLength("🙂")).toBe(4);
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
  it("returns empty for a zero budget", () => {
    expect(clampModelVisibleText("anything at all", 0)).toBe("");
    expect(clampModelVisibleText("", 0)).toBe("");
  });

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

  it("never splits a multibyte code point", () => {
    // 10 × "🙂" = 40 UTF-8 bytes; a 15-byte budget lands mid-emoji and must drop the partial.
    const clamped = clampModelVisibleText("🙂".repeat(10), 15);
    expect(utf8ByteLength(clamped)).toBeLessThanOrEqual(15);
    expect(clamped).not.toContain("�");
  });

  it("bounds a hostile 100KB text inside the budget", () => {
    const clamped = clampModelVisibleText("E".repeat(100_000), 256);
    expect(utf8ByteLength(clamped)).toBeLessThanOrEqual(256);
  });
});

describe("makeCumulativeOutputBudget", () => {
  it("admits an exact cumulative fit and counts each admission exactly once", () => {
    const budget = makeCumulativeOutputBudget(10);
    expect(budget.admit("aaaa")).toEqual({ admitted: true });
    expect(budget.admit("bbbb")).toEqual({ admitted: true });
    expect(budget.used()).toBe(8);
    // Exact threshold: the remaining 2 bytes are admitted.
    expect(budget.admit("cc").admitted).toBe(true);
    expect(budget.used()).toBe(10);
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
    expect(budget.used()).toBe(8);
    expect(budget.admit("bb").admitted).toBe(true);
    expect(budget.used()).toBe(10);
  });

  it("counts multibyte guest data in exact UTF-8 bytes", () => {
    const budget = makeCumulativeOutputBudget(4);
    // "éé" is 4 UTF-8 bytes (2 UTF-16 code units): an exact fit.
    expect(budget.admit("éé").admitted).toBe(true);
    expect(budget.used()).toBe(4);
    expect(budget.admit("a").admitted).toBe(false);
  });

  it("bounds and consumes nested failure text from the same budget", () => {
    const budget = makeCumulativeOutputBudget(7);
    expect(budget.admit("ok").admitted).toBe(true);
    expect(budget.admitFailure("ééé")).toBe("éé");
    expect(budget.used()).toBe(6);
    expect(budget.admitFailure("xy")).toBe("x");
    expect(budget.used()).toBe(7);
    expect(budget.admitFailure("later")).toBe("");
  });

  it("stays deterministic under interleaved admissions of equal size", () => {
    // Check-and-consume is one synchronous step, so any settle order of 5 equal-sized
    // results against a 3-result budget admits exactly 3 and refuses exactly 2.
    const budget = makeCumulativeOutputBudget(12);
    const outcomes = ["11", "22", "33", "44", "55"].map((data) => budget.admit(data + data));
    expect(outcomes.filter((outcome) => outcome.admitted)).toHaveLength(3);
    expect(budget.used()).toBe(12);
  });
});
