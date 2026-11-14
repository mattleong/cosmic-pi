import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
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

/**
 * `text` painted in `base`, except that in each count summary, `+4 −2` with the Unicode minus, a
 * nonzero added count takes the diff's added colour (`toolDiffAdded`) and a nonzero removed count its
 * removed colour (`toolDiffRemoved`), signs included. A zero count keeps `base`, so a pure addition
 * shows one coloured number, and a lone `+1` is not a line count. Text without a pair comes back
 * exactly as `theme.fg(base, text)`. Pass plain text: each segment is painted with its own `fg`.
 */
export const paintLineCounts = (
  theme: Pick<Theme, "fg">,
  text: string,
  base: ThemeColor,
): string => {
  const segments: Array<readonly [ThemeColor, string]> = [];
  const push = (color: ThemeColor, part: string) => {
    const last = segments.at(-1);
    if (last?.[0] === color) segments[segments.length - 1] = [color, last[1] + part];
    else if (part !== "") segments.push([color, part]);
  };
  const count = (color: ThemeColor, sign: string, digits: string) =>
    push(ZERO_COUNT.test(digits) ? base : color, `${sign}${digits}`);
  let last = 0;
  for (const match of Fn.pipe(text, Str.matchAll(LINE_COUNT_PAIR))) {
    const start = match.index ?? last;
    push(base, Fn.pipe(text, Str.slice(last, start)));
    count("toolDiffAdded", "+", match[1] ?? "");
    push(base, " ");
    count("toolDiffRemoved", "−", match[2] ?? "");
    last = start + match[0].length;
  }
  if (last === 0) return theme.fg(base, text);
  push(base, Fn.pipe(text, Str.slice(last)));
  return Arr.join(
    Arr.map(segments, ([color, part]) => theme.fg(color, part)),
    "",
  );
};

/**
 * A tool's heading on one logical line, never cut: the caller lays it out for the row, wrapping an
 * expanded heading and shortening a collapsed subject before its facts, so the heading it measures
 * is the heading it draws. Producers bound their own subjects. A count summary in the subtitle takes
 * the diff's colours (`paintLineCounts`).
 */
export const renderToolHeader = (header: ToolHeader, theme: Pick<Theme, "bold" | "fg">): string => {
  const title = theme.fg("toolTitle", theme.bold(sanitizeTerminalLine(header.title)));
  if (!header.subtitle) return title;
  return `${title} ${paintLineCounts(theme, sanitizeTerminalLine(header.subtitle), "dim")}`;
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
