import assert from "node:assert/strict";
import { test } from "vitest";
import { changedRangesWithConfidence } from "../../../src/diff/word/emphasis";
import type { TextRange } from "../../../src/diff/word/types";

test("token refinement preserves the identity of alignment gaps", () => {
  assert.deepEqual(
    changedRangesWithConfidence("a b oldValue c", "a insertedValue b newValue c", "all"),
    {
      removed: [[4, 7]],
      added: [
        [2, 15],
        [18, 21],
      ],
      confidence: "high",
    },
  );
});

test.each<[before: string, after: string, removed: TextRange[], added: TextRange[]]>([
  // Similar single-token edits narrow to the changed text.
  ["value1000", "value1001", [[8, 9]], [[8, 9]]],
  ["color", "colour", [], [[4, 5]]],
  // Text refinement requires shared token edges.
  ["stringify", "bringHome", [[0, 9]], [[0, 9]]],
  ["customerRecord", "mustardResult", [[0, 14]], [[0, 13]]],
  // Refinements expand to complete extended grapheme clusters.
  ["a\u0301Value", "a\u0302Value", [[0, 2]], [[0, 2]]],
  ["𐐀a", "𐐁a", [[0, 2]], [[0, 2]]],
  ["👨‍👩‍👧‍👦Foo", "👨‍👩‍👧‍👧Foo", [[0, 11]], [[0, 11]]],
])("token refinement of %j to %j", (before, after, removed, added) => {
  const ranges = changedRangesWithConfidence(before, after, "all");
  assert.deepEqual({ removed: ranges.removed, added: ranges.added }, { removed, added });
});
