import assert from "node:assert/strict";
import { test } from "vitest";
import {
  prefixAlignedPairs,
  suffixAlignedPairs,
  suffixAlignmentScore,
} from "../../../src/diff/word/alignment";

const unitScore = () => 1;
const crossingScore = (i: number, j: number) => (i === j ? -Infinity : 1);
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

test.each([
  [0, 3],
  [3, 0],
  [0, 0],
])("alignment skips score lookups for empty dimensions %i x %i", (before, after) => {
  assert.deepEqual(suffixAlignedPairs(before, after, unexpectedScore), []);
  assert.deepEqual(prefixAlignedPairs(before, after, unexpectedScore), []);
  assert.equal(suffixAlignmentScore(before, after, unexpectedScore), 0);
});

test("alignment preserves skip-direction ties across forbidden pairs", () => {
  assert.deepEqual(suffixAlignedPairs(2, 2, crossingScore), [[1, 0]]);
  assert.deepEqual(prefixAlignedPairs(2, 2, crossingScore), [[0, 1]]);
});

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
