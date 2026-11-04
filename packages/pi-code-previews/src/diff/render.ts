import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { countLabel } from "pi-cosmic-core/display";
import { codePreviewSettings } from "../config/state";
import type { DiffWordEmphasis } from "../config/schema";
import { expandPreviewTabs } from "../shared/helpers";
import { escapeControlChars, injectVisibleRanges } from "../shared/terminal-text";
import { splitLinesLimited } from "../shared/text-lines";
import { isLightShikiTheme, renderWithShiki } from "../syntax/render";
import {
  DIFF_ADD_MARKER,
  DIFF_REMOVE_MARKER,
  diffLineNumberWidth,
  diffLineRuns,
  formatDiffLineNumber,
  parseDiffLine,
  type ParsedDiffLine,
} from "./parse";
import { emphasizedChangedPairs } from "./word/change-block";
import type { TextRange } from "./word/types";

export function renderSyntaxHighlightedDiff(
  diff: string,
  lang: string | undefined,
  theme: Theme,
  limit: number,
  invalidate?: () => void,
  lineNumbers = true,
): string {
  return renderDiff(diff, {
    theme,
    limit,
    lang,
    invalidate,
    wordEmphasis: codePreviewSettings.wordEmphasis,
    lineNumbers,
  });
}

export function renderPlainDiff(
  diff: string,
  theme: Theme,
  limit: number,
  lineNumbers = true,
): string {
  return renderDiff(diff, { theme, limit, wordEmphasis: "off", lineNumbers });
}

type DiffRenderOptions = {
  lang?: string | undefined;
  theme: Theme;
  limit: number;
  invalidate?: (() => void) | undefined;
  wordEmphasis: DiffWordEmphasis;
  lineNumbers: boolean;
};

function renderDiff(diff: string, options: DiffRenderOptions): string {
  // One extra line tells a separator that ends the diff from one the limit cut off.
  const fetched = splitLinesLimited(diff, options.limit + 1);
  const truncated = fetched.length > options.limit;
  const lines = truncated ? fetched.slice(0, options.limit) : fetched;
  const parsedLines = Arr.map(lines, parseDiffLine);
  const lineNumberWidth = options.lineNumbers ? diffLineNumberWidth(parsedLines) : 0;
  const highlighted = options.lang
    ? highlightDiffLineRuns(parsedLines, options.lang, options.invalidate)
    : [];
  const emphasis = new Map<number, TextRange[]>();
  for (const pair of emphasizedChangedPairs(parsedLines, options.wordEmphasis))
    emphasis.set(pair.removedIndex, pair.ranges.removed).set(pair.addedIndex, pair.ranges.added);
  const rows: string[] = [];
  let shift = 0;
  Arr.forEach(lines, (line, index) => {
    const parsed = parsedLines[index];
    if (parsed) {
      if (parsed.kind !== " ") shift += parsed.kind === "+" ? 1 : -1;
      rows.push(
        renderDiffParsedLine(
          parsed,
          highlighted[index],
          options.theme,
          lineNumberWidth,
          emphasis.get(index),
        ),
      );
      return;
    }
    const gap = Str.trim(escapeControlChars(line)) === "...";
    // The file's length isn't in the diff, so a gap that ends it has nothing to count.
    if (gap && !truncated && index === lines.length - 1) return;
    const hidden = gap
      ? hiddenLineCount(
          index === 0 ? "start" : parsedLines[index - 1],
          parsedLines[index + 1],
          shift,
        )
      : undefined;
    rows.push(renderSeparator(line, options.theme, hidden, lineNumberWidth));
  });
  return Arr.join(rows, "\n");
}

const diffLineNumber = (line: ParsedDiffLine): number | undefined => {
  if (line.lineNumber === "") return undefined;
  const value = Number(Str.trim(line.lineNumber));
  return Number.isInteger(value) ? value : undefined;
};

/**
 * Context and added lines carry new-file numbers and removed lines old ones; the lines a gap hides
 * are unchanged, so `shift` (lines added minus removed so far) moves an old number to the new file.
 */
function newFileLine(line: ParsedDiffLine, shift: number): number | undefined {
  const value = diffLineNumber(line);
  if (value === undefined) return undefined;
  return line.kind === "-" ? value + shift : value;
}

/**
 * How many unchanged lines a `...` separator stands for, from the numbered lines around it. A
 * leading separator hides everything before the first shown line.
 */
function hiddenLineCount(
  before: ParsedDiffLine | null | undefined | "start",
  after: ParsedDiffLine | null | undefined,
  shift: number,
): number | undefined {
  const previous = before === "start" ? 0 : before ? newFileLine(before, shift) : undefined;
  const next = after ? newFileLine(after, shift) : undefined;
  if (previous === undefined || next === undefined || next - previous < 2) return undefined;
  return next - previous - 1;
}

function renderSeparator(
  line: string,
  theme: Theme,
  count: number | undefined,
  lineNumberWidth: number,
): string {
  const safeLine = escapeControlChars(line);
  const trimmed = Str.trim(safeLine);
  if (trimmed === "...") {
    // The ellipsis sits in the gutter's `│` column.
    return theme.fg(
      "muted",
      `${Fn.pipe(" ", Str.repeat(lineNumberWidth + 2))}… ${count === undefined ? "unchanged lines" : countLabel(count, "unchanged line")}`,
    );
  }
  if (Fn.pipe(trimmed, Str.startsWith("@@"))) return theme.fg("accent", theme.bold(safeLine));
  if (/^(?:---|\+\+\+|diff |index )/u.test(trimmed)) return theme.fg("muted", safeLine);
  return theme.fg("toolDiffContext", safeLine);
}

function renderDiffParsedLine(
  parsed: ParsedDiffLine,
  highlighted: string | undefined,
  theme: Theme,
  lineNumberWidth: number,
  emphasis: TextRange[] | undefined,
): string {
  const content =
    highlighted ?? theme.fg("toolOutput", escapeControlChars(expandPreviewTabs(parsed.content)));
  const rendered = emphasis
    ? injectVisibleRanges(content, emphasis, {
        open: wordEmphasisBackground(parsed.kind === "+"),
        close: "\x1b[49m",
        reopenAfterSgr: (sequence) => sequence === "\x1b[39m" || sequence === "\x1b[22m",
      })
    : content;
  const lineNumber = formatDiffLineNumber(parsed.lineNumber, lineNumberWidth);
  if (parsed.kind === "+")
    return `${DIFF_ADD_MARKER}${theme.fg("toolDiffAdded", `+${lineNumber} │ `)}${rendered}`;
  if (parsed.kind === "-")
    return `${DIFF_REMOVE_MARKER}${theme.fg("toolDiffRemoved", `-${lineNumber} │ `)}${rendered}`;
  return dimAnsi(
    `${theme.fg("toolDiffContext", ` ${lineNumber} │ `)}${rendered || theme.fg("toolDiffContext", "")}`,
  );
}

function wordEmphasisBackground(added: boolean): string {
  if (isLightShikiTheme(codePreviewSettings.shikiTheme))
    return added ? "\x1b[48;2;194;209;194m" : "\x1b[48;2;216;182;182m";
  return added ? "\x1b[48;2;64;132;82m" : "\x1b[48;2;148;62;70m";
}

function dimAnsi(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

function highlightDiffLineRuns(
  lines: Array<ParsedDiffLine | null>,
  lang: string,
  invalidate?: () => void,
): Array<string | undefined> {
  const highlighted: Array<string | undefined> = [];
  for (const [start, end] of diffLineRuns(lines, (line) => line.kind)) {
    const source = Arr.join(
      Arr.map(lines.slice(start, end), (line) => expandPreviewTabs(line?.content ?? "")),
      "\n",
    );
    const rendered = renderWithShiki(source, lang, invalidate);
    if (rendered) {
      for (let index = start; index < end; index++) highlighted[index] = rendered[index - start];
    }
  }
  return highlighted;
}
