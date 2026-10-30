import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { renderCompactToolCall } from "../../src/preview/compact-tool-call";
import { plainTheme as theme, stripAnsi } from "../support/render";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";

test("compact subjects are single-line, inert and width bounded without losing tool identity", () => {
  for (const width of [1, 4, 16, 40, 100]) {
    const rows = renderCompactToolCall(
      {
        name: "read",
        phase: "running",
        summary: {
          subject: Fn.pipe("src/日本語/👩‍💻.ts\nnext\tpart\u001b[2J\r", Str.repeat(20)),
          metadata: ["optional"],
        },
        duration: "1.2s",
      },
      theme,
      width,
    );
    assert.ok(Arr.every(rows, (row) => visibleWidth(row) <= width));
    assert.doesNotMatch(stripAnsi(Arr.join(rows, "")), /[\n\r\t]/u);
    assert.equal(Fn.pipe(Arr.join(rows, ""), Str.includes("\u001b[2J")), false);
    if (width >= 16) assert.match(rows[0]!, /read/u);
  }
});

const renderQuoted = (quote: string, width = 80) =>
  renderCompactToolCall(
    {
      name: "agent_send",
      phase: "settled",
      summary: { subject: "x", outcome: "success", quote },
    },
    theme,
    width,
  );

test("quoted words show beneath a collapsed row with their line breaks, bounded and inert", () => {
  const lines = Arr.map(Arr.range(1, 30), (line) => `line ${line} of the message`);
  const short = Arr.map(renderQuoted("first line\nsecond line"), stripAnsi);
  assert.ok(Arr.some(short, (row) => Str.includes("first line")(row)));
  assert.ok(Arr.some(short, (row) => Str.includes("second line")(row)));
  const long = Arr.map(renderQuoted(Arr.join(lines, "\n")), stripAnsi);
  assert.ok(Arr.some(long, (row) => Str.includes("line 1 of")(row)));
  const lastShown = Arr.some(long, (row) => Str.includes("line 30 of")(row));
  assert.equal(lastShown, false);
  assert.ok(long.length < lines.length);
  const hostile = renderQuoted("safe\u001b[2Jtext", 20);
  assert.ok(Arr.every(hostile, (row) => visibleWidth(row) <= 20));
  assert.equal(Fn.pipe(Arr.join(hostile, ""), Str.includes("\u001b[2J")), false);
});
