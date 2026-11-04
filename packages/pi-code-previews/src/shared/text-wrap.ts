import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { visibleWidth } from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Paths, file names, and identifiers read best broken after a separator.
const BREAK_AFTER = /(?<=[/\\\-_.])/u;

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
 * as a long path, breaks after `/`, `-`, `_`, or `.`, and mid-word only when a part has none.
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
  const place = (part: string) => {
    if (visibleWidth(Str.trimEnd(current + part)) <= width) {
      current += part;
      return false;
    }
    flush();
    if (visibleWidth(Str.trimEnd(part)) <= width) {
      current = Str.trimStart(part) === "" ? "" : part;
      return false;
    }
    return true;
  };
  // Each word keeps the spaces after it, so wrapped rows lose only the spaces at their ends. A `·`
  // between facts stays with the fact before it, so no row starts with a separator.
  for (const word of Str.split(text, /(?<= )(?=[^ ·])/u)) {
    if (!place(word)) continue;
    for (const part of Str.split(word, BREAK_AFTER)) {
      if (!place(part)) continue;
      const pieces = hardSplit(part, width);
      Arr.forEach(pieces.slice(0, -1), (piece) => rows.push(piece));
      current = pieces.at(-1) ?? "";
    }
  }
  flush();
  return rows.length === 0 ? [""] : rows;
}
