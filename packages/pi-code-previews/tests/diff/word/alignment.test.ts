import assert from "node:assert/strict";
import { test } from "vitest";
import { prefixAlignedPairs, suffixAlignedPairs } from "../../../src/diff/word/alignment";

const unitScore = () => 1;
const unexpectedScore = () => {
  throw new Error("score callback should not run");
};

test("alignment preserves directional tie-breaking", () => {
  const scoreAt = unitScore;

  assert.deepEqual(suffixAlignedPairs(2, 1, scoreAt), [[0, 0]]);
  assert.deepEqual(prefixAlignedPairs(2, 1, scoreAt), [[1, 0]]);
  assert.deepEqual(suffixAlignedPairs(1, 2, scoreAt), [[0, 0]]);
  assert.deepEqual(prefixAlignedPairs(1, 2, scoreAt), [[0, 1]]);
});

test("alignment skips score lookups for empty dimensions", () => {
  const scoreAt = unexpectedScore;

  assert.deepEqual(suffixAlignedPairs(0, 3, scoreAt), []);
  assert.deepEqual(prefixAlignedPairs(3, 0, scoreAt), []);
});
