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

const offers = (rows: readonly string[]) => Arr.some(rows, Str.includes("▸ prompt"));

test("an affordance that reveals only the subject shows only where the row cuts the subject", () => {
  const prompt = "A watercolor otter floating on a river at dawn";
  const render = (width: number, subjectOnly: boolean, compactSubject?: string) =>
    Arr.map(
      renderCompactToolCall(
        {
          name: "image",
          phase: "running",
          summary: {
            action: "generate",
            subject: prompt,
            ...(compactSubject !== undefined && { compactSubject }),
            ...(subjectOnly && { expandsSubjectOnly: true }),
          },
          expandLabel: "prompt",
        },
        theme,
        width,
      ),
      stripAnsi,
    );
  assert.equal(offers(render(100, true)), false);
  assert.equal(offers(render(100, false)), true);
  assert.equal(offers(render(30, true)), true);
  assert.equal(offers(render(100, true, "otter")), true);
});

test("a collapsed row whose subject is cut keeps its first metadata where the subject keeps room", () => {
  const subject =
    "pnpm vitest run --reporter=dot tests/task-service.test.ts tests/log-buffer.test.ts";
  for (const width of [57, 100]) {
    const [row = ""] = renderCompactToolCall(
      {
        name: "background_task",
        phase: "settled",
        summary: { subject, outcome: "success", metadata: ["finished in 1m 33s"] },
      },
      theme,
      width,
    );
    const plain = stripAnsi(row);
    assert.match(plain, /… · finished in 1m 33s$/u);
    const shown = /^✓ background_task (.*)…/u.exec(plain)?.[1] ?? "";
    assert.ok(Fn.pipe(subject, Str.startsWith(`${shown} `)));
    assert.ok(visibleWidth(row) <= width);
  }
  // Too narrow to leave the subject its room, the row keeps the subject instead.
  const [narrow = ""] = renderCompactToolCall(
    {
      name: "background_task",
      phase: "settled",
      summary: { subject, outcome: "success", metadata: ["finished in 1m 33s"] },
    },
    theme,
    40,
  );
  assert.doesNotMatch(stripAnsi(narrow), /finished/u);
});

test("metadata gives way to the subject when the subject could only be cut inside a word", () => {
  const subject = "https://example.test/docs/getting-started/installation";
  const [row = ""] = renderCompactToolCall(
    {
      name: "fetch_content",
      phase: "settled",
      summary: { subject, outcome: "success", metadata: ["outcome unknown"] },
    },
    theme,
    70,
  );
  const plain = stripAnsi(row);
  assert.doesNotMatch(plain, /outcome unknown/u);
  assert.ok(Fn.pipe(plain, Str.includes(subject)));
});
