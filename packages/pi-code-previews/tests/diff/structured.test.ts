import assert from "node:assert/strict";
import { test } from "vitest";
import { createSimpleDiff } from "../../src/diff/structured";

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

test("createSimpleDiff omits unchanged content, including empty files", () => {
  for (const text of ["", "\n", "a", "a\r\nb\r\n", "a\rb\r"])
    assert.equal(createSimpleDiff(text, text), "");
});

test.each(["\n", "\r\n", "\r"])("createSimpleDiff normalizes %j line endings", (ending) => {
  const text = `a${ending}b${ending}`;
  assert.equal(createSimpleDiff("", text), "@@ 1 @@\n+1 a\n+2 b");
  assert.equal(createSimpleDiff(text, ""), "@@ 1 @@\n-1 a\n-2 b");
  assert.equal(createSimpleDiff(`a${ending}`, "a"), "@@ 1 @@\n-1 a\n+1 a");
});

test.each([6, 7])("createSimpleDiff compacts a %i-line gap without losing numbering", (gap) => {
  const head = Array.from({ length: 5 }, (_, i) => `head${i}`);
  const middle = Array.from({ length: gap }, (_, i) => `gap${i}`);
  const tail = Array.from({ length: 5 }, (_, i) => `tail${i}`);
  const before = [...head, "old", ...middle, "old end", ...tail].join("\n");
  const after = [...head, "new", "extra", ...middle, "new end", ...tail].join("\n");
  const kept: Array<number | "..."> = gap === 6 ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, "...", 4, 5, 6];
  assert.deepEqual(createSimpleDiff(before, after).split("\n"), [
    "@@ 6 @@",
    " 3 head2",
    " 4 head3",
    " 5 head4",
    "-6 old",
    "+6 new",
    "+7 extra",
    ...kept.map((i) => (i === "..." ? i : ` ${i + 8} gap${i}`)),
    `-${gap + 7} old end`,
    `+${gap + 8} new end`,
    ` ${gap + 9} tail0`,
    ` ${gap + 10} tail1`,
    ` ${gap + 11} tail2`,
  ]);
});
