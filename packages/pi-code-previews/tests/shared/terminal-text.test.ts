import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { escapeControlChars, wrapAnsiToWidth } from "../../src/shared/terminal-text";
import { stripAnsi } from "../support/render";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

test("terminal text escapes C0, DEL, and C1 control characters", () => {
  assert.equal(
    escapeControlChars("safe\x00\x0b\x1f\x1b\r\x7f\x80\x9b\ud800text\t\n"),
    "safe���␛␍���\ud800text\t\n",
  );
});

test("ANSI wrapping preserves short printable spans exactly", () => {
  const text = "\x1b[31mconst value = 1;\x1b[39m";

  assert.deepEqual(wrapAnsiToWidth(text, 80), [text]);
  for (const malformed of ["hello\x1b", "hello\x1b[31", "hello\x1b]8;;url\x07", "x\x1b[2J hi m"]) {
    const rows = wrapAnsiToWidth(malformed, 5, 20, "> ");
    assert.equal(
      Fn.pipe(stripAnsi(Arr.join(rows, "")), Str.replaceAll("> ", "")),
      escapeControlChars(malformed),
    );
    assert.ok(Arr.every(rows, (row) => visibleWidth(row) <= 5));
    assert.ok(Arr.every(rows, (row) => !Fn.pipe(row, Str.includes("\x1b"))));
  }
});

const wordWrap = (text: string, width: number) =>
  Arr.map(wrapAnsiToWidth(text, width, 10, "  ", { breakAtWords: true }), stripAnsi);

test("word-aware wrapping moves a word near the edge whole, and splits one that isn't", () => {
  // `number` starts within a few columns of the edge, so it moves to the next row.
  assert.deepEqual(wordWrap("items: LineItem[]): number {", 22), [
    "items: LineItem[]): ",
    "  number {",
  ]);
  // A token longer than the window still breaks at the edge rather than leaving a mostly empty row.
  assert.deepEqual(wordWrap("a abcdefghijklmnopqrstuvwxyz", 20), [
    "a abcdefghijklmnopqr",
    "  stuvwxyz",
  ]);
  // Colors carry onto the moved word's row.
  const colored = wrapAnsiToWidth("\x1b[31mred words here\x1b[39m", 12, 10, "", {
    breakAtWords: true,
  });
  assert.equal(colored.length, 2);
  assert.ok(Fn.pipe(colored[1] ?? "", Str.startsWith("\x1b[31m")));
});
