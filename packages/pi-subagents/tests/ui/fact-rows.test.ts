import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { describe, expect, it } from "vitest";
import { factRowLines, type FactSpan } from "../../src/ui/agent-text.ts";
import * as Fn from "effect/Function";

// Marks each colored part so the test can tell which span every visible character came from.
const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
};

const spans: ReadonlyArray<FactSpan> = [
  ["researcher", "accent"],
  [" · ", "dim"],
  ["openai-codex/gpt-6.1-sol high", "muted"],
  [" · ", "dim"],
  ["a very long task description that wraps across several rows", "toolOutput"],
  [" · ", "dim"],
  ["3m", "success"],
];

const COLORED = /<(\w+)>(.*?)<\/\1>/gu;

const textByColor = (rows: ReadonlyArray<string>) => {
  const colored = new Map<string, string>();
  for (const row of rows)
    for (const [, color = "", text = ""] of Fn.pipe(row, Str.matchAll(COLORED)))
      colored.set(color, `${colored.get(color) ?? ""}${text}`);
  const uncolored = Arr.join(Arr.map(rows, Str.replace(COLORED, "")), "");
  return { colored, uncolored };
};

const withoutSpaces = Str.replace(/\s/gu, "");

describe("wrapped fact rows", () => {
  it.each([24, 30, 57])("keep every fact and separator in its color at %i columns", (width) => {
    const rows = factRowLines(spans, width, theme, true, { indent: 2 });
    expect(rows.length).toBeGreaterThan(1);
    const { colored, uncolored } = textByColor(rows);
    // Only indentation and the space after a leading `·` are left unstyled.
    expect(withoutSpaces(uncolored)).toBe("");
    const expected = new Map<string, string>();
    for (const [text, color = ""] of spans)
      expected.set(color, `${expected.get(color) ?? ""}${text}`);
    for (const [color, text] of expected)
      expect(withoutSpaces(colored.get(color) ?? "")).toBe(withoutSpaces(text));
    expect(Arr.every(rows, (row) => !Fn.pipe(row, Str.endsWith("·</dim>")))).toBe(true);
  });
});

describe("collapsed fact rows", () => {
  const peer: ReadonlyArray<FactSpan> = [
    ["db-migration", "accent"],
    [" · shared checkout writer · running · Implement the 0007 migration for orders", "muted"],
  ];
  const plain = (row: string) => Fn.pipe(row, Str.replace(COLORED, "$2"));

  it.each([60, 70, 80])("cut a trailing task at a word boundary at %i columns", (width) => {
    const [row = ""] = factRowLines(peer, width, theme, false);
    const shown = plain(row);
    expect(shown.length).toBeLessThanOrEqual(width);
    expect(shown).toMatch(/…$/u);
    const kept = Fn.pipe(shown, Str.slice(0, -1));
    // The cut never lands inside a word of the task.
    expect(`${Fn.pipe(kept, Str.replace(/\s+$/u, ""))} `).toSatisfy((text: string) =>
      Fn.pipe(
        "db-migration · shared checkout writer · running · Implement the 0007 migration for orders ",
        Str.includes(text),
      ),
    );
  });

  it("ends with `· …` when only a sliver of the task would fit", () => {
    const [row = ""] = factRowLines(peer, 52, theme, false);
    expect(plain(row)).toBe("db-migration · shared checkout writer · running · …");
  });
});
