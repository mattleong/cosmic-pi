import assert from "node:assert/strict";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, test } from "vitest";
import { applyPresentationSettings } from "../../testing";
import { plainTheme, stripAnsi } from "../support/render";
import { FullWidthDiffText } from "../../src/diff/full-width-text";
import { renderPlainDiff } from "../../src/diff/render";
import { parseDiffLine } from "../../src/diff/parse";

beforeEach(() => applyPresentationSettings({}));

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

test("Pi's skipped-context marker parses as a gap, not a context row", () => {
  const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
  const after = before.replace("line 3\n", "LINE 3\n").replace("line 35\n", "LINE 35\n");
  const lines = generateDiffString(before, after).diff.split("\n");
  const gaps = lines.filter((line) => line.trim() === "...");
  assert.ok(gaps.length > 0);
  for (const gap of gaps) assert.equal(parseDiffLine(gap), null);
  assert.ok(lines.filter((line) => line.trim() !== "...").every((line) => parseDiffLine(line)));
});

test("plain diff escapes terminal control characters", () => {
  const escape = String.fromCharCode(27);
  const nul = String.fromCharCode(0);
  const untrustedSequence = `${escape}[31m`;
  const rendered = renderPlainDiff(`+1 hello ${untrustedSequence}red${nul}`, plainTheme, 1);
  const baseline = renderPlainDiff("+1 hello red", plainTheme, 1);
  assert.equal(rendered.includes(untrustedSequence), false);
  assert.equal(rendered.split(nul).length, baseline.split(nul).length);
  assert.match(stripAnsi(rendered), /red/);
});

test("full-width diff wrapping preserves wide graphemes beside a narrow continuation gutter", () => {
  const diffText = renderPlainDiff("+1 a😀b", plainTheme, 1);
  const rows = new FullWidthDiffText(diffText, plainTheme).render(6);

  assert.ok(rows.every((row) => visibleWidth(row) <= 6));
  assert.match(stripAnsi(rows.join("")), /😀/);
});
