import { expect, it } from "@effect/vitest";
import { utf8ByteLength, utf8Prefix, utf8Suffix } from "../src/text.ts";

it("takes the longest code-point prefix within a UTF-8 byte budget", () => {
  expect(utf8Prefix("aé😀", 3)).toBe("aé");
  expect(utf8Prefix("aé😀", 7)).toBe("aé😀");
  expect(utf8Prefix("aé😀", 6)).toBe("aé");
  expect(utf8Prefix("\ud800x", 3)).toBe("\ud800");
  expect(utf8Prefix("\ud800x", 2)).toBe("");
});

it("takes the longest code-point suffix within a UTF-8 byte budget", () => {
  expect(utf8Suffix("😀éa", 3)).toBe("éa");
  expect(utf8Suffix("😀éa", 7)).toBe("😀éa");
  expect(utf8Suffix("😀éa", 6)).toBe("éa");
  expect(utf8Suffix("abc", 0)).toBe("");
  expect(utf8Suffix("abc", -1)).toBe("");
  expect(utf8ByteLength("x\ud800")).toBe(4);
  expect(utf8Suffix("x\ud800", 3)).toBe("\ud800");
  expect(utf8Suffix("x\ud800", 2)).toBe("");
});
