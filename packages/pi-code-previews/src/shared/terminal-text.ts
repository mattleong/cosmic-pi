import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export { stripAnsi } from "pi-cosmic-core";

const ESCAPE_CODE = 0x1b;
const CARRIAGE_RETURN_CODE = 0x0d;

/** C0/C1 control code units rendered as the replacement symbol (tab and newline stay). */
function isReplacedControlCode(code: number): boolean {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  );
}

export function escapeControlChars(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === ESCAPE_CODE) out += "␛";
    else if (code === CARRIAGE_RETURN_CODE) out += "␍";
    else if (isReplacedControlCode(code)) out += "�";
    else out += text[index];
  }
  return out;
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

/** Replaces every strict SGR sequence via `replace(sequence, parameters)`. */
export function replaceSgrSequences(
  text: string,
  replace: (sequence: string, parameters: string) => string,
): string {
  let out = "";
  for (let index = 0; index < text.length; ) {
    const sequence = matchSgrSequence(text, index);
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
      out +=
        active && options.reopenAfterSgr?.(sgr.sequence)
          ? `${sgr.sequence}${options.open}`
          : sgr.sequence;
      i += sgr.sequence.length - 1;
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
      row += ansi.sequence;
      state = updateAnsiState(state, ansi.sequence);
      index += ansi.sequence.length;
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
          const clipped = truncateToWidth(segment, width, "");
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
  return truncateToWidth(row, width, "");
}

function truncateLastRow(rows: string[], width: number): string[] {
  const last = rows.at(-1) ?? "";
  if (visibleWidth(last) >= width && width > 1)
    rows[rows.length - 1] = truncateToWidth(last, width - 1, "") + "›";
  return rows;
}

function extractSgr(text: string, index: number): { sequence: string } | undefined {
  if (text[index] !== "\x1b" || text[index + 1] !== "[") return undefined;
  let end = index + 2;
  while (end < text.length && text[end] !== "m") end++;
  if (end >= text.length) return undefined;
  return { sequence: text.slice(index, end + 1) };
}

function isExtendedOrDefaultParameters(parameters: string, prefix: string): boolean {
  return (
    parameters === `${prefix.charAt(0)}9` ||
    (parameters.startsWith(prefix) && parameters.length > prefix.length)
  );
}

function updateAnsiState(current: string, sequence: string): string {
  const parameters = sequence.slice(2, -1);
  if (parameters === "0") return "";
  if (isExtendedOrDefaultParameters(parameters, "38;"))
    return (
      dropAnsiState(current, (p) => isExtendedOrDefaultParameters(p, "38;")) +
      (parameters === "39" ? "" : sequence)
    );
  if (isExtendedOrDefaultParameters(parameters, "48;"))
    return (
      dropAnsiState(current, (p) => isExtendedOrDefaultParameters(p, "48;")) +
      (parameters === "49" ? "" : sequence)
    );
  if (parameters === "22") return dropAnsiState(current, (p) => p === "1" || p === "2");
  if (parameters === "1") return dropAnsiState(current, (p) => p === "1") + sequence;
  if (parameters === "2") return dropAnsiState(current, (p) => p === "2") + sequence;
  if (parameters === "3" || parameters === "23")
    return (
      dropAnsiState(current, (p) => p === "3" || p === "23") + (parameters === "23" ? "" : sequence)
    );
  if (parameters === "4" || parameters === "24")
    return (
      dropAnsiState(current, (p) => p === "4" || p === "24") + (parameters === "24" ? "" : sequence)
    );
  return current + sequence;
}

/** Removes state sequences whose parameters match, preserving everything else. */
function dropAnsiState(current: string, drop: (parameters: string) => boolean): string {
  let out = "";
  for (let index = 0; index < current.length; ) {
    const sgr = extractSgr(current, index);
    if (sgr) {
      if (!drop(sgr.sequence.slice(2, -1))) out += sgr.sequence;
      index += sgr.sequence.length;
    } else {
      out += current[index];
      index++;
    }
  }
  return out;
}
