import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
  escapeControlChars,
  injectVisibleRanges,
  wrapAnsiToWidth,
} from "../../src/shared/terminal-text";
import { stripAnsi } from "../support/render";

test("terminal text escapes C0, DEL, and C1 control characters", () => {
  assert.equal(
    escapeControlChars("safe\x00\x0b\x1f\x1b\r\x7f\x80\x9b\ud800text\t\n"),
    "safe���␛␍���\ud800text\t\n",
  );
});

test("visible-range injection preserves SGR foreground resets", () => {
  const highlighted = injectVisibleRanges("ab\x1b[31mc\x1b[39mde", [[1, 4]], {
    open: "<open>",
    close: "<close>",
    reopenAfterSgr: (sequence) => sequence === "\x1b[39m",
  });
  assert.equal(highlighted, "a<open>b\x1b[31mc\x1b[39m<open>d<close>e");
});

test("ANSI wrapping uses terminal cell width for wide unicode", () => {
  const rows = wrapAnsiToWidth(`\x1b[31m${"漢".repeat(8)}\x1b[39m`, 6, 10);
  assert.ok(rows.length > 1);
  assert.ok(rows.every((row) => visibleWidth(row) <= 6));
});

test("ANSI wrapping preserves short printable spans exactly", () => {
  const text = "\x1b[31mconst value = 1;\x1b[39m";

  assert.deepEqual(wrapAnsiToWidth(text, 80), [text]);
  for (const malformed of ["hello\x1b", "hello\x1b[31", "hello\x1b]8;;url\x07", "x\x1b[2J hi m"]) {
    const rows = wrapAnsiToWidth(malformed, 5, 20, "> ");
    assert.equal(stripAnsi(rows.join("")).replaceAll("> ", ""), escapeControlChars(malformed));
    assert.ok(rows.every((row) => visibleWidth(row) <= 5));
    assert.ok(rows.every((row) => !row.includes("\x1b")));
  }
});
