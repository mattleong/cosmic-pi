import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import { codeUnitAt, indexOfFrom, lastIndexOfFrom } from "pi-cosmic-core/text-scan";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clipToWidth, wrapWords } from "pi-cosmic-ui/manager";

// Bound once: Pi's loader routes each imported-helper call through an interop proxy.
const codeAt = codeUnitAt;
const indexFrom = indexOfFrom;
const lastIndexFrom = lastIndexOfFrom;

const ESCAPE_CODE = 0x1b;

export function escapeControlChars(text: string): string {
  // @effect-diagnostics-next-line preferEffectString:off -- Str.replace accepts only a string replacement.
  return text.replace(/\p{Cc}/gu, (char) =>
    char === "\t" || char === "\n" ? char : char === "\x1b" ? "␛" : char === "\r" ? "␍" : "�",
  );
}

export function escapeLineControlChars(line: string): string {
  return escapeControlChars(
    Fn.pipe(line, Str.endsWith("\r")) ? Fn.pipe(line, Str.slice(0, -1)) : line,
  );
}

/**
 * A plain line without line breaks, wrapped to `width` between words; a word wider than a row,
 * such as a long path, breaks after `/`, then after `-`, `_`, or `.`, then anywhere. Its indent
 * stays on the first row when the row's first words fit beside it.
 */
export function wrapIndentedLine(line: string, width: number): string[] {
  const rest = Str.trimStart(line);
  const indent = Fn.pipe(line, Str.slice(0, line.length - rest.length));
  const lead = visibleWidth(indent);
  const [first = "", ...more] = wrapWords(rest, Math.max(1, width - lead), width);
  return [visibleWidth(first) + lead <= width ? `${indent}${first}` : first, ...more];
}

const PRINTABLE_ASCII_RE = /^[ -~]*$/;

export function matchSgrSequence(text: string, index: number): string | undefined {
  if (codeAt(text, index) !== ESCAPE_CODE || text[index + 1] !== "[") return undefined;
  for (let end = index + 2; end < text.length; end++) {
    const code = codeAt(text, end);
    if ((code >= 0x30 && code <= 0x39) || code === 0x3b) continue;
    return text[end] === "m" ? Fn.pipe(text, Str.slice(index, end + 1)) : undefined;
  }
  return undefined;
}

export function replaceSgrSequences(
  text: string,
  replace: (sequence: string, parameters: string) => string,
): string {
  let out = "";
  for (let index = 0; index < text.length; ) {
    const sequence = matchSgrSequence(text, index);
    if (sequence) {
      out += replace(sequence, Fn.pipe(sequence, Str.slice(2, -1)));
      index += sequence.length;
    } else {
      out += text[index] ?? "";
      index++;
    }
  }
  return out;
}

function isTruncationSafe(row: string): boolean {
  for (let index = 0; index < row.length; ) {
    const code = codeAt(row, index);
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

interface RangeCursor {
  visible: number;
  out: string;
  active: boolean;
  rangeIndex: number;
}

function closePassedRanges(
  cursor: RangeCursor,
  sorted: ReadonlyArray<readonly [number, number]>,
  close: string,
): void {
  while (
    cursor.rangeIndex < sorted.length &&
    cursor.visible >= (sorted[cursor.rangeIndex]?.[1] ?? Infinity)
  ) {
    if (cursor.active) {
      cursor.out += close;
      cursor.active = false;
    }
    cursor.rangeIndex++;
  }
}

function openCurrentRange(
  cursor: RangeCursor,
  sorted: ReadonlyArray<readonly [number, number]>,
  open: string,
): void {
  const range = sorted[cursor.rangeIndex];
  if (!cursor.active && range && cursor.visible >= range[0] && cursor.visible < range[1]) {
    cursor.out += open;
    cursor.active = true;
  }
}

export function injectVisibleRanges(
  ansi: string,
  ranges: Array<[number, number]>,
  options: {
    open: string;
    close: string;
    reopenAfterSgr?: (sequence: string) => boolean;
  },
): string {
  const cursor: RangeCursor = { visible: 0, out: "", active: false, rangeIndex: 0 };
  const sorted = Arr.sortWith(
    Arr.filter(ranges, ([start, end]) => end > start),
    (range: [number, number]) => range[0],
    Order.Number,
  );
  for (let i = 0; i < ansi.length; i++) {
    const sgr = matchSgrSequence(ansi, i);
    if (sgr) {
      cursor.out += cursor.active && options.reopenAfterSgr?.(sgr) ? `${sgr}${options.open}` : sgr;
      i += sgr.length - 1;
      continue;
    }
    closePassedRanges(cursor, sorted, options.close);
    openCurrentRange(cursor, sorted, options.open);
    cursor.out += ansi[i] ?? "";
    cursor.visible++;
  }
  if (cursor.active) cursor.out += options.close;
  return cursor.out;
}

/** How far back from the edge a wrap may move to land on a word boundary instead of mid-word. */
const WORD_BREAK_WINDOW = 12;

const NON_SPACE_RE = /\S/u;

class AnsiWrapper {
  readonly rows: string[] = [];
  private row = "";
  private rowWidth = 0;
  private state = "";
  private readonly width: number;
  private readonly maxRows: number;
  private readonly continuationPrefix: string;
  private readonly continuationWidth: number;
  private readonly breakAtWords: boolean;
  // The latest space after the row's first word: where the row can wrap without splitting a word.
  private wordBreak: { index: number; width: number; state: string } | undefined;
  private rowHasWord = false;

  constructor(width: number, maxRows: number, continuationPrefix: string, breakAtWords: boolean) {
    this.width = width;
    this.maxRows = maxRows;
    this.continuationPrefix = continuationPrefix;
    this.continuationWidth = visibleWidth(continuationPrefix);
    this.breakAtWords = breakAtWords;
  }

  appendSgr(sequence: string): void {
    this.row += sequence;
    this.state = updateAnsiState(this.state, sequence);
  }

  appendPlain(plain: string): boolean {
    if (plain.length <= this.width - this.rowWidth && PRINTABLE_ASCII_RE.test(plain)) {
      if (this.breakAtWords) this.noteWordBreak(plain);
      this.row += plain;
      this.rowWidth += plain.length;
      return true;
    }
    for (const { segment } of segmenter.segment(plain))
      if (!this.appendSegment(segment)) return false;
    return true;
  }

  finish(): string[] {
    this.rows.push(truncateWrappedRow(this.row, this.rowWidth, this.width));
    if (this.rows.length > this.maxRows)
      return truncateLastRow(this.rows.slice(0, this.maxRows), this.width);
    return this.rows;
  }

  private overflows(segmentWidth: number): boolean {
    return this.rowWidth > 0 && this.rowWidth + segmentWidth > this.width;
  }

  private appendSegment(segment: string): boolean {
    const segmentWidth = visibleWidth(segment);
    if (this.overflows(segmentWidth)) {
      // A space at the edge is the boundary itself; it would only indent the next row.
      if (this.breakAtWords && segment === " " && this.rowHasWord) return this.pushRow();
      const moved = this.breakAtWords ? this.wrapAtWordBreak(segmentWidth) : undefined;
      if (moved === false || (moved === undefined && !this.pushRow())) return false;
    }
    if (this.overflows(segmentWidth)) {
      this.row = this.state;
      this.rowWidth = 0;
    }
    if (segmentWidth > this.width && this.rowWidth === 0) {
      const clipped = clipToWidth(segment, this.width, "");
      if (clipped) {
        this.row += clipped;
        this.rowWidth += visibleWidth(clipped);
      }
      return this.pushRow();
    }
    if (this.breakAtWords) this.noteWordBreak(segment);
    this.row += segment;
    this.rowWidth += segmentWidth;
    return true;
  }

  /** Records the last space in `plain`, about to be appended, as a wrap point once a word precedes it. */
  private noteWordBreak(plain: string): void {
    const space = lastIndexFrom(plain, " ", plain.length);
    if (space >= 0 && (this.rowHasWord || NON_SPACE_RE.test(Fn.pipe(plain, Str.slice(0, space)))))
      this.wordBreak = {
        index: this.row.length + space + 1,
        width: this.rowWidth + space + 1,
        state: this.state,
      };
    this.rowHasWord ||= NON_SPACE_RE.test(plain);
  }

  /**
   * Moves the word in progress to the next row when its start is near the edge. Returns undefined
   * when no boundary qualifies, so the caller breaks mid-word as before.
   */
  private wrapAtWordBreak(segmentWidth: number): boolean | undefined {
    const wordBreak = this.wordBreak;
    if (!wordBreak || this.rows.length + 1 >= this.maxRows) return undefined;
    const tailWidth = this.rowWidth - wordBreak.width;
    if (
      tailWidth > WORD_BREAK_WINDOW ||
      this.continuationWidth + tailWidth + segmentWidth > this.width
    )
      return undefined;
    const tail = Fn.pipe(this.row, Str.slice(wordBreak.index));
    this.row = Fn.pipe(this.row, Str.slice(0, wordBreak.index));
    this.rowWidth = wordBreak.width;
    if (!this.pushRow()) return false;
    this.row = wordBreak.state + this.continuationPrefix + tail;
    this.rowWidth = this.continuationWidth + tailWidth;
    this.rowHasWord = tailWidth > 0;
    return true;
  }

  private pushRow(): boolean {
    this.rows.push(truncateWrappedRow(this.row, this.rowWidth, this.width));
    this.wordBreak = undefined;
    this.rowHasWord = false;
    if (this.rows.length >= this.maxRows) {
      truncateLastRow(this.rows, this.width);
      return false;
    }
    this.row = this.continuationPrefix ? this.state + this.continuationPrefix : this.state;
    this.rowWidth = this.continuationWidth;
    return true;
  }
}

/**
 * Wraps ANSI text to `width`, starting each continuation row with `continuationPrefix`. With
 * `breakAtWords`, a row ends at the last space within a few columns of the edge rather than
 * splitting the word that crosses it.
 */
export function wrapAnsiToWidth(
  text: string,
  width: number,
  maxRows = 3,
  continuationPrefix = "",
  options: { readonly breakAtWords?: boolean } = {},
): string[] {
  if (width <= 0) return [""];
  const wrapper = new AnsiWrapper(
    width,
    maxRows,
    continuationPrefix,
    options.breakAtWords === true,
  );
  let index = 0;
  while (index < text.length) {
    const ansi = matchSgrSequence(text, index);
    if (ansi) {
      wrapper.appendSgr(ansi);
      index += ansi.length;
      continue;
    }
    const nextAnsi = indexFrom(text, "\x1b", index + 1);
    const plainEnd = nextAnsi >= 0 ? nextAnsi : text.length;
    if (!wrapper.appendPlain(escapeControlChars(Fn.pipe(text, Str.slice(index, plainEnd)))))
      return wrapper.rows;
    index = plainEnd;
  }
  return wrapper.finish();
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

const ANSI_STATE_GROUPS: Array<{ isSet: (parameters: string) => boolean; reset: string }> = [
  {
    isSet: (parameters) => Fn.pipe(parameters, Str.startsWith("38;")) && parameters.length > 3,
    reset: "39",
  },
  {
    isSet: (parameters) => Fn.pipe(parameters, Str.startsWith("48;")) && parameters.length > 3,
    reset: "49",
  },
  { isSet: (parameters) => parameters === "1", reset: "22" },
  { isSet: (parameters) => parameters === "2", reset: "22" },
  { isSet: (parameters) => parameters === "3", reset: "23" },
  { isSet: (parameters) => parameters === "4", reset: "24" },
];

function updateAnsiState(current: string, sequence: string): string {
  const parameters = Fn.pipe(sequence, Str.slice(2, -1));
  if (parameters === "0") return "";
  const groups = Arr.filter(
    ANSI_STATE_GROUPS,
    (group) => group.isSet(parameters) || group.reset === parameters,
  );
  if (groups.length === 0) return current + sequence;
  const kept = replaceSgrSequences(current, (existing, existingParameters) =>
    Arr.some(groups, (group) => group.isSet(existingParameters)) ? "" : existing,
  );
  return Arr.some(groups, (group) => group.reset === parameters) ? kept : kept + sequence;
}
