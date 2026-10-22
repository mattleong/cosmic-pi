import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "pi-cosmic-core";
import { LogBuffer } from "../src/task/log-buffer.ts";
import type { BackgroundLogEvent, BackgroundLogStream } from "../src/task/model.ts";
import { StyledLogRows } from "../src/ui/styled-log.ts";

const gutter = { stdout: "│ ", stderr: "! " };
const fresh = (events: ReadonlyArray<BackgroundLogEvent>, width: number) =>
  new StyledLogRows(gutter).rows("task", events, width);

const words = (text: string) => text.split(/\s+/u).filter(Boolean);

const WRITES: ReadonlyArray<readonly [BackgroundLogStream, string]> = [
  ["stdout", "\u001b[32mstart of a long green line that keeps "],
  ["stdout", "going\u001b[0m\nplain\n"],
  ["stderr", "\u001b[1mwarn: bold carries\nacross lines\u001b[22m\n"],
  ["stdout", "partial"],
  ["stderr", "err\n"],
  ["stdout", " rest\n"],
];

describe("task manager log rows", () => {
  it("renders each update, resize, and eviction exactly as a fresh render would", () => {
    const buffer = new LogBuffer();
    const view = new StyledLogRows(gutter);
    for (const [stream, text] of WRITES) {
      buffer.append(stream, text, 0, 1 << 20);
      expect(view.rows("task", buffer.events, 20)).toEqual(fresh(buffer.events, 20));
    }
    const rows = view.rows("task", buffer.events, 33);
    expect(rows).toEqual(fresh(buffer.events, 33));
    expect(view.rows("task", buffer.events, 33)).toBe(rows);
    // Rows fit the width and keep every word of the output, each under its stream's gutter.
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(33);
    const plainRows = rows.map(stripAnsi);
    expect(plainRows.flatMap((row) => words(row.slice(2)))).toEqual(
      words(WRITES.map(([, text]) => stripAnsi(text)).join(" ")),
    );
    for (const [index, row] of plainRows.entries()) {
      const stderr = /warn|across|err$/u.test(row);
      expect(row.startsWith(stderr ? gutter.stderr : gutter.stdout), row).toBe(true);
      // A style left open at a line break carries on to the next line.
      if (row.includes("across")) expect(rows[index]).not.toBe(row);
    }

    buffer.dropOldest().dropOldest();
    expect(view.rows("task", buffer.events, 33)).toEqual(fresh(buffer.events, 33));
    expect(view.rows("other", [], 33)).toEqual([]);
  });
});
