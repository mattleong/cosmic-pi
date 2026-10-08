import { visibleWidth } from "@earendil-works/pi-tui";
import { clipToWidth } from "pi-cosmic-ui/manager";

const ESCAPE_CODE = 0x1b;

/** C0/C1 controls render as symbols: ESC and CR keep distinct ones; tab and newline stay. */
export function escapeControlChars(text: string): string {
  return text.replace(/\p{Cc}/gu, (char) =>
    char === "\t" || char === "\n" ? char : char === "\x1b" ? "␛" : char === "\r" ? "␍" : "�",
  );
}

/**
 * One line of file text for plain display. A CRLF ending's carriage return is dropped, as Shiki
 * and Pi drop it, so plain and highlighted previews match; a carriage return elsewhere is shown.
 */
export function escapeLineControlChars(line: string): string {
  return escapeControlChars(line.endsWith("\r") ? line.slice(0, -1) : line);
}

const PRINTABLE_ASCII_RE = /^[ -~]*$/;

/**
 * Matches one strict SGR sequence (`ESC [` digits/semicolons `m`) starting at
 * `index`, returning the full sequence text or undefined.
 */
export function matchSgrSequence(text: string, index: number): string | undefined {
  if (text.charCodeAt(index) !== ESCAPE_CODE || text[index + 1] !== "[") return undefined;
  for (let end = index + 2; end < text.length; end++) {
    const code = text.charCodeAt(end);
    if ((code >= 0x30 && code <= 0x39) || code === 0x3b) continue;
    return text[end] === "m" ? text.slice(index, end + 1) : undefined;
  }
  return undefined;
}

/** Replaces every SGR sequence found by `match` (strict by default) via `replace(sequence, parameters)`. */
export function replaceSgrSequences(
  text: string,
  replace: (sequence: string, parameters: string) => string,
  match: (text: string, index: number) => string | undefined = matchSgrSequence,
): string {
  let out = "";
  for (let index = 0; index < text.length; ) {
    const sequence = match(text, index);
    if (sequence) {
      out += replace(sequence, sequence.slice(2, -1));
      index += sequence.length;
    } else {
      out += text[index];
      index++;
    }
  }
  return out;
}

/** True when the row is printable ASCII, tabs, and strict SGR sequences only. */
function isTruncationSafe(row: string): boolean {
  for (let index = 0; index < row.length; ) {
    const code = row.charCodeAt(index);
    if ((code >= 0x20 && code <= 0x7e) || code === 0x09) {
      index++;
      continue;
    }
    const sequence = matchSgrSequence(row, index);
    if (!sequence) return false;
    index += sequence.length;
  }
  return true;
}
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function injectVisibleRanges(
  ansi: string,
  ranges: Array<[number, number]>,
  options: {
    open: string;
    close: string;
    reopenAfterSgr?: (sequence: string) => boolean;
  },
): string {
  let visible = 0;
  let out = "";
  let active = false;
  let rangeIndex = 0;
  const sorted = ranges.filter(([start, end]) => end > start).toSorted((a, b) => a[0] - b[0]);
  for (let i = 0; i < ansi.length; i++) {
    const sgr = extractSgr(ansi, i);
    if (sgr) {
      out += active && options.reopenAfterSgr?.(sgr) ? `${sgr}${options.open}` : sgr;
      i += sgr.length - 1;
      continue;
    }
    while (rangeIndex < sorted.length && visible >= (sorted[rangeIndex]?.[1] ?? Infinity)) {
      if (active) {
        out += options.close;
        active = false;
      }
      rangeIndex++;
    }
    const range = sorted[rangeIndex];
    if (!active && range && visible >= range[0] && visible < range[1]) {
      out += options.open;
      active = true;
    }
    out += ansi[i];
    visible++;
  }
  if (active) out += options.close;
  return out;
}

export function wrapAnsiToWidth(
  text: string,
  width: number,
  maxRows = 3,
  continuationPrefix = "",
): string[] {
  if (width <= 0) return [""];
  const rows: string[] = [];
  let row = "";
  let rowWidth = 0;
  let index = 0;
  let state = "";
  const continuationWidth = visibleWidth(continuationPrefix);

  function pushRow(): boolean {
    rows.push(truncateWrappedRow(row, rowWidth, width));
    if (rows.length >= maxRows) {
      truncateLastRow(rows, width);
      return false;
    }
    row = continuationPrefix ? state + continuationPrefix : state;
    rowWidth = continuationWidth;
    return true;
  }

  while (index < text.length) {
    const ansi = extractSgr(text, index);
    if (ansi) {
      row += ansi;
      state = updateAnsiState(state, ansi);
      index += ansi.length;
      continue;
    }

    const nextAnsi = text.indexOf("\x1b", index);
    const plainEnd = nextAnsi >= 0 ? nextAnsi : text.length;
    const plain = text.slice(index, plainEnd);
    const remainingWidth = width - rowWidth;
    if (plain.length <= remainingWidth && PRINTABLE_ASCII_RE.test(plain)) {
      row += plain;
      rowWidth += plain.length;
    } else {
      for (const { segment } of segmenter.segment(plain)) {
        const segmentWidth = visibleWidth(segment);
        if (rowWidth > 0 && rowWidth + segmentWidth > width && !pushRow()) return rows;
        // A continuation prefix can leave fewer cells than the next grapheme needs.
        // Drop the prefix for that row rather than truncating the grapheme away.
        if (rowWidth > 0 && rowWidth + segmentWidth > width) {
          row = state;
          rowWidth = 0;
        }
        if (segmentWidth > width && rowWidth === 0) {
          const clipped = clipToWidth(segment, width, "");
          if (clipped) {
            row += clipped;
            rowWidth += visibleWidth(clipped);
          }
          if (!pushRow()) return rows;
          continue;
        }
        row += segment;
        rowWidth += segmentWidth;
      }
    }
    index = plainEnd;
  }

  rows.push(truncateWrappedRow(row, rowWidth, width));
  if (rows.length > maxRows) return truncateLastRow(rows.slice(0, maxRows), width);
  return rows;
}

function truncateWrappedRow(row: string, rowWidth: number, width: number): string {
  if (rowWidth <= width && isTruncationSafe(row)) return row;
  return clipToWidth(row, width, "");
}

function truncateLastRow(rows: string[], width: number): string[] {
  const last = rows.at(-1) ?? "";
  if (visibleWidth(last) >= width && width > 1)
    rows[rows.length - 1] = clipToWidth(last, width - 1, "") + "›";
  return rows;
}

function extractSgr(text: string, index: number): string | undefined {
  if (text[index] !== "\x1b" || text[index + 1] !== "[") return undefined;
  let end = index + 2;
  while (end < text.length && text[end] !== "m") end++;
  if (end >= text.length) return undefined;
  return text.slice(index, end + 1);
}

/** Attribute groups the wrap state tracks: a set-code predicate and the code that resets it. */
const ANSI_STATE_GROUPS: Array<{ isSet: (parameters: string) => boolean; reset: string }> = [
  { isSet: (parameters) => parameters.startsWith("38;") && parameters.length > 3, reset: "39" },
  { isSet: (parameters) => parameters.startsWith("48;") && parameters.length > 3, reset: "49" },
  { isSet: (parameters) => parameters === "1", reset: "22" },
  { isSet: (parameters) => parameters === "2", reset: "22" },
  { isSet: (parameters) => parameters === "3", reset: "23" },
  { isSet: (parameters) => parameters === "4", reset: "24" },
];

/** Replaces the matched groups' set-codes; reset codes are never kept, so only set-codes are dropped. */
function updateAnsiState(current: string, sequence: string): string {
  const parameters = sequence.slice(2, -1);
  if (parameters === "0") return "";
  const groups = ANSI_STATE_GROUPS.filter(
    (group) => group.isSet(parameters) || group.reset === parameters,
  );
  if (groups.length === 0) return current + sequence;
  const kept = replaceSgrSequences(
    current,
    (existing, existingParameters) =>
      groups.some((group) => group.isSet(existingParameters)) ? "" : existing,
    extractSgr,
  );
  return groups.some((group) => group.reset === parameters) ? kept : kept + sequence;
}
