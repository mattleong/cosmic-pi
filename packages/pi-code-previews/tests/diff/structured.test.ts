import assert from "node:assert/strict";
import { test } from "vitest";
import { createSimpleDiff } from "../../src/diff/structured";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";

test("createSimpleDiff keeps separated changes distinct", () => {
  const diff = createSimpleDiff("a\nold one\nkeep\nold two\nz", "a\nnew one\nkeep\nnew two\nz");
  assert.match(diff, /-2 old one/);
  assert.match(diff, /\+2 new one/);
  assert.match(diff, / 3 keep/);
  assert.match(diff, /-4 old two/);
  assert.match(diff, /\+4 new two/);
  assert.doesNotMatch(diff, /-3 keep/);
  assert.doesNotMatch(diff, /\+3 keep/);
});

test.each([
  ["a\nb", "a\nb\n"],
  ["a\r\nb\r\n", "a\nb\n"],
])("createSimpleDiff shows an ending-only change from %j to %j", (before, after) => {
  const rows = (kind: string) =>
    Arr.map(
      Arr.filter(Str.split(createSimpleDiff(before, after), "\n"), (line) =>
        Fn.pipe(line, Str.startsWith(kind)),
      ),
      (line) => Fn.pipe(line, Str.replace(/^[+-]\d+ /u, "")),
    );
  const removed = rows("-");
  const added = rows("+");
  assert.ok(removed.length > 0);
  assert.equal(added.length, removed.length);
  for (const [index, text] of removed.entries()) assert.notEqual(added[index], text);
});

test.each([6, 7])("createSimpleDiff compacts a %i-line gap without losing numbering", (gap) => {
  const head = Array.from({ length: 5 }, (_, i) => `head${i}`);
  const middle = Array.from({ length: gap }, (_, i) => `gap${i}`);
  const tail = Array.from({ length: 5 }, (_, i) => `tail${i}`);
  const before = Arr.join([...head, "old", ...middle, "old end", ...tail], "\n");
  const after = Arr.join([...head, "new", "extra", ...middle, "new end", ...tail], "\n");
  const kept: Array<number | "..."> = gap === 6 ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, "...", 4, 5, 6];
  assert.deepEqual(Str.split(createSimpleDiff(before, after), "\n"), [
    "@@ 6 @@",
    " 3 head2",
    " 4 head3",
    " 5 head4",
    "-6 old",
    "+6 new",
    "+7 extra",
    ...Arr.map(kept, (i) => (i === "..." ? i : ` ${i + 8} gap${i}`)),
    `-${gap + 7} old end`,
    `+${gap + 8} new end`,
    ` ${gap + 9} tail0`,
    ` ${gap + 10} tail1`,
    ` ${gap + 11} tail2`,
  ]);
});
