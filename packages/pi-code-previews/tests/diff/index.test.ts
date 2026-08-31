import assert from "node:assert/strict";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test } from "vitest";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { stripAnsi, testTheme } from "../../src/testing/render";
import { renderedWordEmphasisSpans } from "../../src/testing/rendered-word-emphasis";
import { FullWidthDiffText } from "../../src/diff/full-width-text";
import { renderPlainDiff, renderSyntaxHighlightedDiff } from "../../src/diff/render";
import { summarizeDiff } from "../../src/diff/summary";
import { parseDiffLine } from "../../src/diff/parse";
import { wordEmphasisTelemetry } from "../../src/testing/word-emphasis-telemetry";
import { changedRanges, changedRangesWithConfidence } from "../../src/diff/word/emphasis";

let previousCodePreviewSettings = { ...codePreviewSettings };

beforeEach(() => {
  previousCodePreviewSettings = { ...codePreviewSettings };
});

afterEach(() => {
  setCodePreviewSettings(previousCodePreviewSettings);
});

test("summarizeDiff classifies replacements, insertions, and deletions by change group", () => {
  assert.equal(summarizeDiff("").totalLines, 1);
  assert.equal(summarizeDiff("+ 1 added\n").totalLines, 2);

  const balanced = summarizeDiff("- 1 old\n- 2 old\n+ 1 new\n+ 2 new");
  assert.equal(balanced.additions, 2);
  assert.equal(balanced.removals, 2);
  assert.equal(balanced.replacements, 1);
  assert.equal(balanced.insertions, 0);
  assert.equal(balanced.deletions, 0);

  const withExtraLines = summarizeDiff("- 1 old\n+ 1 new\n+ 2 inserted\n context\n- 3 removed");
  assert.equal(withExtraLines.additions, 2);
  assert.equal(withExtraLines.removals, 2);
  assert.equal(withExtraLines.replacements, 1);
  assert.equal(withExtraLines.insertions, 1);
  assert.equal(withExtraLines.deletions, 1);
  assert.equal(withExtraLines.hunks, 2);
});

test("parseDiffLine accepts standard body lines but not file headers", () => {
  assert.deepEqual(parseDiffLine("-old"), { kind: "-", lineNumber: "", content: "old" });
  assert.deepEqual(parseDiffLine("+new"), { kind: "+", lineNumber: "", content: "new" });
  assert.deepEqual(parseDiffLine(" context"), {
    kind: " ",
    lineNumber: "",
    content: "context",
  });
  assert.deepEqual(parseDiffLine("+  indented"), {
    kind: "+",
    lineNumber: "",
    content: "  indented",
  });
  assert.equal(parseDiffLine("--- a/file.ts"), null);
  assert.equal(parseDiffLine("+++ b/file.ts"), null);
});

test("plain diff escapes terminal control characters", () => {
  const escape = String.fromCharCode(27);
  const nul = String.fromCharCode(0);
  const untrustedSequence = `${escape}[31m`;
  const rendered = renderPlainDiff(`+1 hello ${untrustedSequence}red${nul}`, testTheme(), 1);
  const baseline = renderPlainDiff("+1 hello red", testTheme(), 1);
  assert.equal(rendered.includes(untrustedSequence), false);
  assert.equal(rendered.split(nul).length, baseline.split(nul).length);
  assert.match(stripAnsi(rendered), /red/);
});

test("diff renderers honor limits at remove/add boundaries", () => {
  const diff = "-1 old\n+1 new";
  assert.equal(renderSyntaxHighlightedDiff(diff, undefined, testTheme(), 1).split("\n").length, 1);
  assert.equal(renderPlainDiff(diff, testTheme(), 1).split("\n").length, 1);
});

test("full-width diff component wraps long ANSI lines", () => {
  const diffText = renderPlainDiff("+1 " + "x".repeat(80), testTheme(), 1);
  const rows = new FullWidthDiffText(diffText, testTheme()).render(30);
  assert.ok(rows.length > 1);
  assert.equal(visibleWidth(rows[0] ?? ""), 30);
  assert.ok(visibleWidth(rows.at(-1) ?? "") <= 30);
});

test("full-width diff wrapping keeps content when the gutter is wider than the viewport", () => {
  const diffText = renderPlainDiff("+1 abcdef", testTheme(), 1);
  const rows = new FullWidthDiffText(diffText, testTheme()).render(3);

  assert.ok(rows.every((row) => visibleWidth(row) <= 3));
  assert.match(stripAnsi(rows.join("")), /abc/);
});

test("full-width diff wrapping preserves wide graphemes beside a narrow continuation gutter", () => {
  const diffText = renderPlainDiff("+1 a😀b", testTheme(), 1);
  const rows = new FullWidthDiffText(diffText, testTheme()).render(6);

  assert.ok(rows.every((row) => visibleWidth(row) <= 6));
  assert.match(stripAnsi(rows.join("")), /😀/);
});

test("boxed diff rows preserve the requested width", () => {
  const box = new Box(1, 0, (text) => text);
  box.addChild(new FullWidthDiffText(renderPlainDiff("+1 short", testTheme(), 1), testTheme()));
  const line = box.render(20)[0] ?? "";
  assert.equal(visibleWidth(line), 20);
});

test("word emphasis pairs the most similar lines inside change blocks", () => {
  const diff =
    "-1 const trimmed = line.trim();\n+1 const safeLine = escapeControlChars(line);\n+2 const trimmed = safeLine.trim();";
  const spans = renderSyntaxHighlightedDiff(diff, undefined, testTheme(), 3)
    .split("\n")
    .map(renderedWordEmphasisSpans);
  assert.ok(spans[0]?.some((span) => span.includes("line")));
  assert.deepEqual(spans[1], []);
  assert.ok(spans[2]?.some((span) => span.includes("safeLine")));
});

test("word emphasis marks low-overlap one-to-one changed pairs instead of skipping them", () => {
  const diff = "-1 out.push(pair.removed, pair.added);\n+1 block.push(next);";
  const spans = renderSyntaxHighlightedDiff(diff, undefined, testTheme(), 2)
    .split("\n")
    .map(renderedWordEmphasisSpans);
  assert.ok(spans[0]?.some((span) => span.includes("out")));
  assert.ok(spans[1]?.some((span) => span.includes("block")));
});

test("word emphasis telemetry summarizes confidence and skipped pairs", () => {
  assert.deepEqual(
    wordEmphasisTelemetry("-1 const value = oldValue;\n+1 const value = newValue;", 2),
    {
      changedBlocks: 1,
      changedLines: { removed: 1, added: 1 },
      pairConfidence: { high: 0, medium: 1, low: 0 },
      rangeConfidence: { high: 1, medium: 0, low: 0 },
      emphasizedPairs: 1,
      skippedPairs: 0,
      skippedPotentialPairs: 0,
    },
  );

  assert.equal(
    wordEmphasisTelemetry(
      [
        "-1 const result = formatValue(input);",
        "+1 const result = formatLabel(input);",
        "+2 const result = formatTitle(input);",
      ].join("\n"),
      3,
    ).skippedPotentialPairs,
    1,
  );
});

test("word emphasis narrows similar single-token edits", () => {
  setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: "all" });
  assert.deepEqual(changedRanges("value1000", "value1001", "all"), {
    removed: [[8, 9]],
    added: [[8, 9]],
  });
  assert.deepEqual(changedRanges("color", "colour", "all"), {
    removed: [],
    added: [[4, 5]],
  });
});

test("word emphasis keeps unicode refinements on text boundaries", () => {
  setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: "all" });
  assert.deepEqual(changedRanges("a\u0301Value", "a\u0302Value", "all"), {
    removed: [[0, 2]],
    added: [[0, 2]],
  });
  assert.deepEqual(changedRanges("𐐀a", "𐐁a", "all"), {
    removed: [[0, 2]],
    added: [[0, 2]],
  });
});

test("word emphasis skips low-confidence positional pairs inside larger blocks", () => {
  const diff = [
    "-1 const total = calculateTotal(items);",
    "-2 notifyLegacySystem(payload);",
    "+1 const total = calculateTotal(next);",
    "+2 renderCompletelyDifferentScreen();",
  ].join("\n");
  const spans = renderSyntaxHighlightedDiff(diff, undefined, testTheme(), 4)
    .split("\n")
    .map(renderedWordEmphasisSpans);
  assert.deepEqual(spans, [["items"], [], ["next"], []]);
});

test("word emphasis skips ambiguous positional fallback above pairing threshold", () => {
  const count = 33;
  const diff = [
    ...Array.from(
      { length: count },
      (_, index) =>
        `- ${index + 1} items.map((item) => item.shared${index % 4}).filter(Boolean) // old ${index % 3}`,
    ),
    ...Array.from({ length: count }, (_, index) => {
      const reversed = count - 1 - index;
      return `+ ${index + 1} items.map((item) => item.shared${reversed % 4}).filter(Boolean) // new ${reversed % 3}`;
    }),
  ].join("\n");

  const telemetry = wordEmphasisTelemetry(diff, count * 2);
  assert.equal(telemetry.emphasizedPairs, 0);
  assert.equal(telemetry.skippedPotentialPairs, count);
  const spans = renderSyntaxHighlightedDiff(diff, undefined, testTheme(), count * 2)
    .split("\n")
    .flatMap(renderedWordEmphasisSpans);
  assert.deepEqual(spans, []);
});

test("word emphasis can be disabled", () => {
  const diff = "-1 const value = oldValue;\n+1 const value = newValue;";
  setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: "off" });
  const spans = renderSyntaxHighlightedDiff(diff, undefined, testTheme(), 2)
    .split("\n")
    .flatMap(renderedWordEmphasisSpans);
  assert.deepEqual(spans, []);

  assert.deepEqual(changedRanges("const value = oldValue;", "const value = newValue;", "off"), {
    removed: [],
    added: [],
  });
  assert.deepEqual(
    changedRangesWithConfidence("const value = oldValue;", "const value = newValue;", "off"),
    { removed: [], added: [], confidence: "low" },
  );
  assert.equal(wordEmphasisTelemetry(diff, 2, "off").emphasizedPairs, 0);
});

test("word emphasis ranges stay aligned when indentation changes", () => {
  const diff =
    "-1 \tconst next = parseDiffLine(lines[i + 1]!);\n+1 \t\tconst next = parseDiffLine(lines[end]!);";
  const spans = renderSyntaxHighlightedDiff(diff, undefined, testTheme(), 2)
    .split("\n")
    .map(renderedWordEmphasisSpans);
  assert.ok(spans[0]?.some((span) => span.includes("i + 1")));
  assert.ok(spans[1]?.some((span) => span.includes("end")));
});

test("word emphasis is applied synchronously for large changed lines", () => {
  const shared = Array.from({ length: 300 }, (_, index) => `token${index}`).join(" ");
  const diff = `-1 ${shared} oldValue ${shared}\n+1 ${shared} newValue ${shared}`;
  let invalidations = 0;
  const spans = renderSyntaxHighlightedDiff(diff, undefined, testTheme(), 2, () => invalidations++)
    .split("\n")
    .flatMap(renderedWordEmphasisSpans);
  assert.equal(invalidations, 0);
  assert.ok(spans.some((span) => span.includes("old")));
  assert.ok(spans.some((span) => span.includes("new")));
});

test("word range emphasis returns changed spans for unrelated token-heavy lines", () => {
  const before = Array.from({ length: 400 }, (_, index) => `before_${index}`).join(" ");
  const after = Array.from({ length: 400 }, (_, index) => `after_${index}`).join(" ");
  const ranges = changedRanges(before, after, "smart");
  assert.deepEqual(ranges.removed, [[0, before.length]]);
  assert.deepEqual(ranges.added, [[0, after.length]]);
});

test("word range confidence distinguishes exact and fallback-heavy changes", () => {
  assert.equal(
    changedRangesWithConfidence("const value = oldValue;", "const value = newValue;", "smart")
      .confidence,
    "high",
  );

  const before = Array.from({ length: 600 }, (_, index) => `before_${index}`).join(" ");
  const after = Array.from({ length: 600 }, (_, index) => `after_${index}`).join(" ");
  assert.equal(changedRangesWithConfidence(before, after, "smart").confidence, "low");
});
