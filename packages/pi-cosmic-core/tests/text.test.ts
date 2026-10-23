import { expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
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

/** The first candidate, longest first, whose UTF-8 encoding fits the budget. */
const longestWithin = (candidates: ReadonlyArray<ReadonlyArray<string>>, maxBytes: number) =>
  Option.getOrElse(
    Arr.findFirst(
      Arr.map(candidates, (points) => Arr.join(points, "")),
      (text) => utf8ByteLength(text) <= maxBytes,
    ),
    () => "",
  );

it("keeps surrogate pairs whole and lone surrogates at three bytes for every budget", () => {
  const inputs = [
    "",
    "a\u00e9\u4e2d\ud83d\ude00",
    "\ud800\ud800\udc00",
    "\ud83d\ude00\udc00",
    "\udc00\ud800",
    "\udfffx\ud800",
    "\u007f\u0080\u07ff\u0800\uffff",
  ];
  for (const input of inputs) {
    const points = Arr.fromIterable(input);
    const counts = Arr.makeBy(points.length + 1, (count) => count);
    for (let maxBytes = -1; maxBytes <= utf8ByteLength(input) + 1; maxBytes++) {
      const suffixes = Arr.map(counts, (dropped) => Arr.drop(points, dropped));
      const prefixes = Arr.map(Arr.reverse(counts), (kept) => Arr.take(points, kept));
      expect(utf8Suffix(input, maxBytes)).toBe(longestWithin(suffixes, maxBytes));
      expect(utf8Prefix(input, maxBytes)).toBe(longestWithin(prefixes, maxBytes));
    }
  }
});
