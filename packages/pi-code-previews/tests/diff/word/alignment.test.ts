import assert from "node:assert/strict";
import { test } from "vitest";
import {
  prefixAlignedPairs,
  suffixAlignedPairs,
  suffixAlignmentScore,
} from "../../../src/diff/word/alignment";

test("alignment chooses total weight over pair count", () => {
  const scores = [
    [1, 4, -Infinity],
    [-Infinity, 1, -Infinity],
    [-Infinity, 3, 2],
  ];
  const scoreAt = (i: number, j: number) => scores[i]![j]!;
  for (const align of [prefixAlignedPairs, suffixAlignedPairs]) {
    assert.deepEqual(align(3, 3, scoreAt), [
      [0, 1],
      [2, 2],
    ]);
    assert.deepEqual(
      align(2, 3, () => -Infinity),
      [],
    );
  }
  assert.equal(suffixAlignmentScore(3, 3, scoreAt), 6);
});
