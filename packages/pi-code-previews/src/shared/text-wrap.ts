import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { visibleWidth } from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// A word wider than a row breaks after a path separator first, then inside a name.
const BREAK_AFTER = [/(?<=[/\\])/u, /(?<=[-_.])/u] as const;

// Words split after spaces, except after a lone `·` or `→`, which leads the fact after it.
const WORDS = /(?<= )(?<!(?:^| )[·→] )(?=[^ ])/u;

function hardSplit(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const { segment } of graphemes.segment(text)) {
    if (row !== "" && visibleWidth(row + segment) > width) {
      rows.push(row);
      row = "";
    }
    row += segment;
  }
  return row === "" ? rows : [...rows, row];
}

/**
 * Plain text without line breaks, wrapped to `width` between words. A word wider than a row, such
 * as a long path, breaks after `/`, then after `-`, `_`, or `.`, and mid-word only when a part has
 * none. A `·` or `→` between facts leads the fact after it, so no row ends with one.
 */
export function wrapPlainText(text: string, width: number): string[] {
  if (width <= 0 || visibleWidth(text) <= width) return [text];
  const rows: string[] = [];
  let current = "";
  const flush = () => {
    const row = Str.trimEnd(current);
    if (row !== "") rows.push(row);
    current = "";
  };
  // Appends a part that fits the row, else starts a row with it; true when it fits no row.
  const place = (part: string) => {
    if (visibleWidth(Str.trimEnd(current + part)) <= width) {
      current += part;
      return false;
    }
    if (visibleWidth(Str.trimEnd(part)) > width) return true;
    flush();
    current = Str.trimStart(part) === "" ? "" : part;
    return false;
  };
  const breakWord = (word: string, level: number): void => {
    const separator = BREAK_AFTER[level];
    if (separator === undefined) {
      flush();
      const pieces = hardSplit(word, width);
      Arr.forEach(pieces.slice(0, -1), (piece) => rows.push(piece));
      current = pieces.at(-1) ?? "";
      return;
    }
    for (const part of Str.split(word, separator)) if (place(part)) breakWord(part, level + 1);
  };
  // Each word keeps the spaces after it, so wrapped rows lose only the spaces at their ends.
  for (const word of Str.split(text, WORDS)) if (place(word)) breakWord(word, 0);
  flush();
  return rows.length === 0 ? [""] : rows;
}
