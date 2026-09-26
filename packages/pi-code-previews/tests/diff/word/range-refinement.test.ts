import assert from "node:assert/strict";
import { test } from "vitest";
import { changedRanges, changedRangesWithConfidence } from "../../../src/diff/word/emphasis";

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

test("token text refinement requires shared token edges", () => {
  assert.deepEqual(changedRanges("stringify", "bringHome", "all"), {
    removed: [[0, 9]],
    added: [[0, 9]],
  });
  assert.deepEqual(changedRanges("customerRecord", "mustardResult", "all"), {
    removed: [[0, 14]],
    added: [[0, 13]],
  });
});

test("emitted ranges expand to complete extended grapheme clusters", () => {
  const cases = [
    { before: "👩‍💻Foo", after: "👩‍🔬Foo", end: 5 },
    { before: "👍🏻Foo", after: "👍🏽Foo", end: 4 },
    { before: "👨‍👩‍👧‍👦Foo", after: "👨‍👩‍👧‍👧Foo", end: 11 },
  ];

  for (const { before, after, end } of cases) {
    const ranges = changedRanges(before, after, "all");
    assert.deepEqual(ranges, { removed: [[0, end]], added: [[0, end]] });
    assertRangesUseGraphemeBoundaries(before, ranges.removed);
    assertRangesUseGraphemeBoundaries(after, ranges.added);
  }
});

function assertRangesUseGraphemeBoundaries(text: string, ranges: Array<[number, number]>): void {
  const boundaries = new Set([0, text.length]);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const segment of segmenter.segment(text)) {
    boundaries.add(segment.index);
    boundaries.add(segment.index + segment.segment.length);
  }
  for (const [start, end] of ranges) {
    assert.equal(boundaries.has(start), true, `range start ${start} splits a grapheme in ${text}`);
    assert.equal(boundaries.has(end), true, `range end ${end} splits a grapheme in ${text}`);
  }
}
