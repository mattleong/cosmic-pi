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

test("text preview selection preserves head and split window behavior", () => {
  assert.deepEqual(selectPreviewTextLines("zero\none\ntwo\nthree\nfour", 3), {
    entries: [
      { kind: "line", line: "zero", index: 0 },
      { kind: "line", line: "one", index: 1 },
      { kind: "line", line: "two", index: 2 },
    ],
    shown: 3,
    hidden: 2,
    total: 5,
  });

  const twelveLines = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
  assert.deepEqual(selectPreviewTextLines(twelveLines, 8), {
    entries: [
      { kind: "line", line: "line 0", index: 0 },
      { kind: "line", line: "line 1", index: 1 },
      { kind: "line", line: "line 2", index: 2 },
      { kind: "line", line: "line 3", index: 3 },
      { kind: "line", line: "line 4", index: 4 },
      { kind: "line", line: "line 5", index: 5 },
      { kind: "hidden", hidden: 5 },
      { kind: "line", line: "line 11", index: 11 },
    ],
    shown: 7,
    hidden: 5,
    total: 12,
  });
});

test("text preview selection retains all lines when unlimited or within the limit", () => {
  for (const limit of [3, 0, Number.MAX_SAFE_INTEGER])
    assert.deepEqual(selectPreviewTextLines("one\n\ntwo", limit), {
      entries: [
        { kind: "line", line: "one", index: 0 },
        { kind: "line", line: "", index: 1 },
        { kind: "line", line: "two", index: 2 },
      ],
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

test("split window boundary stays head-only at a limit of seven", () => {
  const headOnly = selectPreviewLines(
    Array.from({ length: 20 }, (_, index) => `line ${index}`),
    7,
  );
  assert.deepEqual(
    headOnly.entries.map((entry) => entry.kind),
    Array.from({ length: 7 }, () => "line"),
  );
  assert.deepEqual({ shown: headOnly.shown, hidden: headOnly.hidden }, { shown: 7, hidden: 13 });
});
