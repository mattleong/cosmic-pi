import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { test } from "vitest";
import { indexOfFrom } from "pi-cosmic-core/text-scan";
import { wrapPlainText } from "../../src/shared/text-wrap";

const withoutSpaces = (text: string) => Str.replaceAll(" ", "")(text);

test("a long path wraps after its separators and keeps every character", () => {
  const path = ".pi/generated-images/openai-image-2026-09-27T10-00-00-000Z-ig_0a1b2c3d.png";
  const text = `Saved to ${path} just now`;
  for (const width of [57, 40, 24, 12]) {
    const rows = wrapPlainText(text, width);
    assert.ok(
      Arr.every(rows, (row) => visibleWidth(row) <= width),
      `fits ${width}`,
    );
    assert.equal(withoutSpaces(Arr.join(rows, "")), withoutSpaces(text));
    let offset = 0;
    for (const row of rows.slice(0, -1)) {
      offset = indexOfFrom(text, row, offset) + row.length;
      const atBoundary = /[/\-_.]$/u.test(row) || text[offset] === " ";
      assert.ok(atBoundary, `"${row}" ends between words or after a separator at ${width}`);
    }
  }
});

test("a part without separators breaks mid-word only when nothing else fits", () => {
  const rows = wrapPlainText("short abcdefghijklmnopqrstuvwxyz", 10);
  assert.ok(Arr.every(rows, (row) => visibleWidth(row) <= 10));
  assert.equal(rows[0], "short");
  assert.equal(Arr.join(rows, ""), "shortabcdefghijklmnopqrstuvwxyz");
});

test("a wrapped row never starts with the separator between facts", () => {
  const text = "openai-codex/gpt-5.6-sol:low · 22k tokens · $0.08 · 5m";
  for (const width of [50, 49, 44, 30, 20]) {
    const rows = wrapPlainText(text, width);
    assert.ok(Arr.every(rows, (row) => visibleWidth(row) <= width));
    assert.ok(
      Arr.every(rows.slice(1), (row) => !Fn.pipe(row, Str.startsWith("·"))),
      `no leading · at ${width}`,
    );
    assert.equal(withoutSpaces(Arr.join(rows, "")), withoutSpaces(text));
  }
});
