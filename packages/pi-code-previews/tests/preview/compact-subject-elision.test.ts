import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { elideSubject } from "../../src/preview/compact-header";

const prose = "Summarize the open review comments on the authentication refactor";
const path = "packages/pi-code-previews/src/preview/compact-header.ts";

test("a prose subject is cut at the end, keeping only whole words", () => {
  const words = new Set(Str.split(prose, " "));
  for (const width of [12, 20, 31, 44, 60]) {
    const shown = elideSubject(prose, width, "prose");
    assert.ok(visibleWidth(shown) <= width);
    assert.ok(Fn.pipe(shown, Str.endsWith("…")));
    assert.ok(Fn.pipe(prose, Str.startsWith(Fn.pipe(shown, Str.slice(0, -1)))));
    const kept = Str.split(Fn.pipe(shown, Str.slice(0, -1)), " ");
    assert.ok(
      Arr.every(kept, (word) => words.has(word)),
      `${shown} keeps whole words`,
    );
  }
  assert.equal(elideSubject(prose, prose.length, "prose"), prose);
});

test("a single word wider than the room is still cut to fit", () => {
  const shown = elideSubject("authentication", 8, "prose");
  assert.ok(visibleWidth(shown) <= 8);
  assert.ok(Fn.pipe(shown, Str.endsWith("…")));
});

test("a path subject loses its middle and keeps its file name", () => {
  for (const width of [24, 32, 48]) {
    const shown = elideSubject(path, width, "path");
    assert.ok(visibleWidth(shown) <= width);
    assert.ok(Fn.pipe(shown, Str.includes("…")));
    assert.ok(Fn.pipe(shown, Str.endsWith("header.ts")));
  }
});
