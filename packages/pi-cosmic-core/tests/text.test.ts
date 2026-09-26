import { expect, it } from "@effect/vitest";
import { safeTextPrefix, utf8Prefix } from "../src/text.ts";

it("never splits a surrogate pair in a UTF-16 prefix", () => {
  expect(safeTextPrefix("a😀b", 2)).toBe("a");
  expect(safeTextPrefix("a😀b", 3)).toBe("a😀");
  expect(safeTextPrefix("abc", 10)).toBe("abc");
  expect(safeTextPrefix("abc", -1)).toBe("");
});

it("takes the longest code-point prefix within a UTF-8 byte budget", () => {
  expect(utf8Prefix("aé😀", 3)).toBe("aé");
  expect(utf8Prefix("aé😀", 7)).toBe("aé😀");
  expect(utf8Prefix("aé😀", 6)).toBe("aé");
  // A lone surrogate encodes as the three-byte replacement character.
  expect(utf8Prefix("\ud800x", 3)).toBe("\ud800");
  expect(utf8Prefix("\ud800x", 2)).toBe("");
});
