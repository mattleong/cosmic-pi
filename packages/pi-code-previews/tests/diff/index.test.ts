import assert from "node:assert/strict";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, test } from "vitest";
import { applyPresentationSettings } from "../../testing";
import { plainTheme, stripAnsi } from "../support/render";
import { FullWidthDiffText } from "../../src/diff/full-width-text";
import { renderPlainDiff } from "../../src/diff/render";
import { parseDiffLine, withNewContextLineNumbers } from "../../src/diff/parse";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

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
  const before = Arr.join(
    Array.from({ length: 40 }, (_, index) => `line ${index}`),
    "\n",
  );
  const after = Fn.pipe(
    before,
    Str.replace("line 3\n", "LINE 3\n"),
    Str.replace("line 35\n", "LINE 35\n"),
  );
  const lines = Str.split(generateDiffString(before, after).diff, "\n");
  const gaps = Arr.filter(lines, (line) => Str.trim(line) === "...");
  assert.ok(gaps.length > 0);
  for (const gap of gaps) assert.equal(parseDiffLine(gap), null);
  assert.ok(
    Arr.every(
      Arr.filter(lines, (line) => Str.trim(line) !== "..."),
      (line) => Boolean(parseDiffLine(line)),
    ),
  );
});

test("skipped-context gaps count the unchanged lines they hide", () => {
  const before = Arr.join(
    Array.from({ length: 60 }, (_, index) => `line ${index}`),
    "\n",
  );
  const after = Fn.pipe(
    before,
    Str.replace("line 20\n", "LINE 20\n"),
    Str.replace("line 50\n", "LINE 50\n"),
  );
  const diff = generateDiffString(before, after).diff;
  const rows = Str.split(stripAnsi(renderPlainDiff(diff, plainTheme, 1000)), "\n");
  const gaps = Arr.filter(rows, (row) => Fn.pipe(row, Str.includes("…")));
  const counts = Arr.map(gaps, (row) => /(\d+)/u.exec(row)?.[1]);
  // Pi shows four context lines: lines 1–16 lead, 26–46 sit between the changes, and the
  // trailing gap's size isn't in the diff, so it stays uncounted.
  assert.deepEqual(counts, ["16", "21", undefined]);
});

test("plain diff escapes terminal control characters", () => {
  const escape = String.fromCharCode(27);
  const nul = String.fromCharCode(0);
  const untrustedSequence = `${escape}[31m`;
  const rendered = renderPlainDiff(`+1 hello ${untrustedSequence}red${nul}`, plainTheme, 1);
  const baseline = renderPlainDiff("+1 hello red", plainTheme, 1);
  assert.equal(Fn.pipe(rendered, Str.includes(untrustedSequence)), false);
  assert.equal(Str.split(rendered, nul).length, Str.split(baseline, nul).length);
  assert.match(stripAnsi(rendered), /red/);
});

test("full-width diff wrapping preserves wide graphemes beside a narrow continuation gutter", () => {
  const diffText = renderPlainDiff("+1 a😀b", plainTheme, 1);
  const rows = new FullWidthDiffText(diffText, plainTheme).render(6);

  assert.ok(Arr.every(rows, (row) => visibleWidth(row) <= 6));
  assert.match(stripAnsi(Arr.join(rows, "")), /😀/);
});

test("edit diff context after a change is numbered by its position in the edited file", () => {
  const before = Arr.join(
    Arr.makeBy(20, (index) => `line ${index + 1}`),
    "\n",
  );
  const lines = Str.split(before, "\n");
  const after = Arr.join(
    [...lines.slice(0, 2), "inserted a", "inserted b", ...lines.slice(2, 9), ...lines.slice(10)],
    "\n",
  );
  const { diff } = generateDiffString(before, after);
  const numbered = Arr.flatMap(Str.split(withNewContextLineNumbers(diff), "\n"), (line) => {
    const parsed = parseDiffLine(line);
    return parsed && parsed.kind !== "-"
      ? [[Number(Str.trim(parsed.lineNumber)), parsed.content]]
      : [];
  });
  const afterLines = Str.split(after, "\n");
  for (const [number, content] of numbered) assert.equal(afterLines[Number(number) - 1], content);
  assert.ok(Arr.some(numbered, ([, content]) => content === "line 11"));
});
