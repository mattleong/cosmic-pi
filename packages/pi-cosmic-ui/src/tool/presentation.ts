import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import * as Schema from "effect/Schema";
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

/**
 * A tool's heading on one logical line, never cut: the caller lays it out for the row, wrapping an
 * expanded heading and shortening a collapsed subject before its facts, so the heading it measures
 * is the heading it draws. Producers bound their own subjects.
 */
export const renderToolHeader = (header: ToolHeader, theme: Pick<Theme, "bold" | "fg">): string => {
  const title = theme.fg("toolTitle", theme.bold(sanitizeTerminalLine(header.title)));
  if (!header.subtitle) return title;
  return `${title} ${theme.fg("dim", sanitizeTerminalLine(header.subtitle))}`;
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
