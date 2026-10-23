import { expect, it } from "@effect/vitest";
import { codeUnitAt, indexOfFrom, lastIndexOfFrom } from "../src/text-scan.ts";

it("finds a substring at or after a start position", () => {
  expect(indexOfFrom("a\nb\nc", "\n", 0)).toBe(1);
  expect(indexOfFrom("a\nb\nc", "\n", 1)).toBe(1);
  expect(indexOfFrom("a\nb\nc", "\n", 2)).toBe(3);
  expect(indexOfFrom("a\nb\nc", "\n", 4)).toBe(-1);
  expect(indexOfFrom("abc", "x", 0)).toBe(-1);
});

it("finds a substring at or before a start position", () => {
  expect(lastIndexOfFrom("a/b/c", "/", 4)).toBe(3);
  expect(lastIndexOfFrom("a/b/c", "/", 2)).toBe(1);
  expect(lastIndexOfFrom("a/b/c", "/", 0)).toBe(-1);
});

it("reads UTF-16 code units and reports out-of-range indexes as NaN", () => {
  expect(codeUnitAt("\u001b[", 0)).toBe(0x1b);
  expect(codeUnitAt("😀", 1)).toBe(0xde00);
  expect(codeUnitAt("a", 1)).toBeNaN();
  expect(codeUnitAt("a", -1)).toBeNaN();
});
