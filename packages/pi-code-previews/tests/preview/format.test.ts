import assert from "node:assert/strict";
import { test } from "vitest";
import {
  selectPreviewLines,
  selectPreviewTextLines,
  trimSingleTrailingNewline,
} from "../../src/preview/format";
import { countContentLines } from "../../src/preview/line-counts";

test("trimSingleTrailingNewline preserves leading and meaningful trailing spaces", () => {
  assert.equal(trimSingleTrailingNewline("  indented\n"), "  indented");
  assert.equal(trimSingleTrailingNewline("   \n"), "   ");
  assert.equal(trimSingleTrailingNewline("line\r\n"), "line");
  assert.equal(trimSingleTrailingNewline("line\n\n"), "line\n");
});

test("line counters preserve file, preview, and mixed newline semantics", () => {
  assert.equal(countContentLines(""), 0);
  assert.equal(countContentLines("one"), 1);
  assert.equal(countContentLines("one\n"), 1);
  assert.equal(countContentLines("\n\n"), 2);
  assert.equal(countContentLines("\r\n\r\n"), 2);
  // Like Pi's read, a lone carriage return is content, not a line break.
  assert.equal(countContentLines("one\rtwo\r"), 1);
  assert.equal(countContentLines("one\r\ntwo\nthree\rfour"), 3);
  assert.equal(selectPreviewTextLines("\n\n", 0).total, 1);
  assert.equal(selectPreviewTextLines("one\n\ntwo", 0).total, 3);
});

const line = (index: number, text = `line ${index}`) =>
  ({ kind: "line", line: text, index }) as const;

test("text preview selection preserves head and split window behavior", () => {
  assert.deepEqual(selectPreviewTextLines("zero\none\ntwo\nthree\nfour", 3), {
    entries: [line(0, "zero"), line(1, "one"), line(2, "two")],
    shown: 3,
    hidden: 2,
    total: 5,
  });

  const twelveLines = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
  assert.deepEqual(selectPreviewTextLines(twelveLines, 8), {
    entries: [
      ...[0, 1, 2, 3, 4, 5].map((index) => line(index)),
      { kind: "hidden", hidden: 5 },
      line(11),
    ],
    shown: 7,
    hidden: 5,
    total: 12,
  });
  // The split begins at a limit of eight; seven still shows only the head.
  const headOnly = selectPreviewTextLines(twelveLines, 7);
  assert.deepEqual(
    headOnly.entries,
    [0, 1, 2, 3, 4, 5, 6].map((index) => line(index)),
  );
  assert.deepEqual({ shown: headOnly.shown, hidden: headOnly.hidden }, { shown: 7, hidden: 5 });
});

test("text preview selection retains all lines when unlimited or within the limit", () => {
  for (const limit of [3, 0, Number.MAX_SAFE_INTEGER])
    assert.deepEqual(selectPreviewTextLines("one\n\ntwo", limit), {
      entries: [line(0, "one"), line(1, ""), line(2, "two")],
      shown: 3,
      hidden: 0,
      total: 3,
    });
});

test("streaming text selection matches array selection across split boundaries", () => {
  for (const total of [1, 7, 8, 9, 12, 30]) {
    const lines = Array.from({ length: total }, (_, index) => `line ${index}`);
    const text = lines.join("\n");
    for (const limit of [0, 1, 6, 7, 8, 9, 10, total, total + 1]) {
      const fromArray = selectPreviewLines(lines, limit);
      const fromText = selectPreviewTextLines(text, limit);
      assert.deepEqual(fromText, { ...fromArray, total }, `limit ${limit} of ${total} lines`);
    }
  }
});
