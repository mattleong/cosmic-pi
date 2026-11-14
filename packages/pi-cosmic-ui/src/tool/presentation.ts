import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerNoticeColor,
  managerNoticeGlyph,
  type ManagerActivityKind,
  type ManagerNoticeKind,
} from "../manager/chrome.ts";

export const composeToolComponent = (render: (width: number) => string[]): Component => ({
  render,
  invalidate: () => undefined,
});

/**
 * A component whose rows are drawn once per width and reused until it is invalidated. A width that
 * is not finite or below one column draws nothing.
 */
export const cachedComponent = (draw: (width: number) => string[]): Component => {
  let cached: { readonly width: number; readonly lines: string[] } | undefined;
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      if (cached?.width === width) return cached.lines;
      const lines = draw(width);
      cached = { width, lines };
      return lines;
    },
    invalidate() {
      cached = undefined;
    },
  };
};

const plainMarkdown = (text: string) => text;

/** Pi's markdown colors, drawn with the given theme rather than the host's global one. */
export const markdownTheme = (theme: Pick<Theme, "fg" | "bold">): MarkdownTheme => ({
  heading: (text) => theme.fg("mdHeading", theme.bold(text)),
  link: (text) => theme.fg("mdLink", text),
  linkUrl: (text) => theme.fg("mdLinkUrl", text),
  code: (text) => theme.fg("mdCode", text),
  codeBlock: (text) => theme.fg("mdCodeBlock", text),
  codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
  quote: (text) => theme.fg("mdQuote", text),
  quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
  hr: (text) => theme.fg("mdHr", text),
  listBullet: (text) => theme.fg("mdListBullet", text),
  bold: (text) => theme.bold(text),
  italic: plainMarkdown,
  strikethrough: plainMarkdown,
  underline: plainMarkdown,
});

export interface ToolHeader {
  readonly title: string;
  readonly subtitle?: string | undefined;
}

// `+4 −2`: a count summary, with the Unicode minus. A lone `+1` or an ASCII `-` is not one.
const LINE_COUNT_PAIR = /(?<![\p{L}\p{N}_])\+(\d+) −(\d+)/gu;
const ZERO_COUNT = /^0+$/u;
// A whole fact between separators that counts work needing someone: `1 failed`, `1 of 3 needs
// your input`. The same words inside a subject or a longer fact are not one.
const PROBLEM_COUNT =
  /(?<=^\s*(?:· )?| · )[1-9]\d*(?: of \d+)? (failed|needs? your input)(?=\s*$| · )/gu;
const FAST_MODE = /⚡/gu;

interface FactMark {
  readonly start: number;
  readonly end: number;
  readonly color: ThemeColor;
}

const lineCountMarks = (text: string): FactMark[] =>
  Arr.flatMap([...Fn.pipe(text, Str.matchAll(LINE_COUNT_PAIR))], (match) => {
    const [, added = "", removed = ""] = match;
    const start = match.index ?? 0;
    const removedStart = start + added.length + 2;
    return [
      ...(ZERO_COUNT.test(added)
        ? []
        : [{ start, end: start + added.length + 1, color: "toolDiffAdded" as const }]),
      ...(ZERO_COUNT.test(removed)
        ? []
        : [
            {
              start: removedStart,
              end: removedStart + removed.length + 1,
              color: "toolDiffRemoved" as const,
            },
          ]),
    ];
  });

const factMarks = (text: string): FactMark[] =>
  Arr.sortWith(
    [
      ...lineCountMarks(text),
      ...Arr.map([...Fn.pipe(text, Str.matchAll(PROBLEM_COUNT))], (match) => ({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        color:
          match[1] === "failed" ? managerActivityColor("failed") : managerNoticeColor("attention"),
      })),
      ...Arr.map([...Fn.pipe(text, Str.matchAll(FAST_MODE))], (match) => ({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        color: "warning" as const,
      })),
    ],
    (mark) => mark.start,
    Order.Number,
  );

/**
 * A fact, or a `·`-joined line of facts, painted in `base`, except for what the suite colours
 * wherever it appears as a fact:
 * - a count summary, `+4 −2` with the Unicode minus: a nonzero added count takes the diff's added
 *   colour (`toolDiffAdded`) and a nonzero removed count its removed colour (`toolDiffRemoved`),
 *   signs included. A zero count keeps `base`, and a lone `+1` is not a line count.
 * - a problem count that is a whole fact: `1 failed` takes the failed colour and `1 needs your
 *   input` the attention colour. Other state counts keep `base`.
 * - the fast-mode mark `⚡`, in the warning colour.
 *
 * Text with none of these comes back exactly as `theme.fg(base, text)`. Pass plain text: each
 * segment is painted with its own `fg`. Don't pass authored prose or output.
 */
export const paintFacts = (theme: Pick<Theme, "fg">, text: string, base: ThemeColor): string => {
  const marks = factMarks(text);
  if (marks.length === 0) return theme.fg(base, text);
  let painted = "";
  let at = 0;
  for (const mark of marks) {
    if (mark.start < at) continue;
    if (mark.start > at) painted += theme.fg(base, Fn.pipe(text, Str.slice(at, mark.start)));
    painted += theme.fg(mark.color, Fn.pipe(text, Str.slice(mark.start, mark.end)));
    at = mark.end;
  }
  return at < text.length ? `${painted}${theme.fg(base, Fn.pipe(text, Str.slice(at)))}` : painted;
};

/**
 * A tool's heading on one logical line, never cut: the caller lays it out for the row, wrapping an
 * expanded heading and shortening a collapsed subject before its facts, so the heading it measures
 * is the heading it draws. Producers bound their own subjects. Facts in the subtitle take their
 * colours (`paintFacts`).
 */
export const renderToolHeader = (header: ToolHeader, theme: Pick<Theme, "bold" | "fg">): string => {
  const title = theme.fg("toolTitle", theme.bold(sanitizeTerminalLine(header.title)));
  if (!header.subtitle) return title;
  return `${title} ${paintFacts(theme, sanitizeTerminalLine(header.subtitle), "dim")}`;
};

type ToolStatusKind = ManagerActivityKind | ManagerNoticeKind;

const isNotice = Schema.is(Schema.Literals(["info", "success", "warning", "error", "attention"]));

export const toolStatusLine = (
  theme: Pick<Theme, "fg">,
  kind: ToolStatusKind,
  text: string,
  frame = 0,
): string => {
  const [glyph, color]: readonly [string, ThemeColor] = isNotice(kind)
    ? [managerNoticeGlyph(kind), managerNoticeColor(kind)]
    : [managerActivityGlyph(kind, frame), managerActivityColor(kind)];
  return theme.fg(color, `${glyph} ${sanitizeTerminalLine(text)}`);
};

export const toolRunningLine = (theme: Pick<Theme, "fg">, frame = 0): string =>
  toolStatusLine(theme, "running", "Running…", frame);

/**
 * `▸ label`, naming what expanding a collapsed row reveals, or `▾ label` once expanded. Rows never
 * name the key: Pi's own header teaches `ctrl+o`.
 */
export const renderExpansionAffordance = (
  label: string,
  expanded: boolean,
  theme: Pick<Theme, "fg">,
): string =>
  `${theme.fg("accent", expanded ? "▾" : "▸")} ${theme.fg("muted", sanitizeTerminalLine(label))}`;
