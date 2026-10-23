import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { EditorTheme } from "@earendil-works/pi-tui";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { padListDetailRow } from "pi-cosmic-ui/manager/list-detail";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { stripTerminalControls } from "pi-cosmic-core";

// Titles only label tabs, review rows, and headings; the schema admits longer ones than fit there.
const MAX_TITLE_LABEL_WIDTH = 24;

export const titleLabel = (title: string): string =>
  clipToWidth(stripTerminalControls(title), MAX_TITLE_LABEL_WIDTH);

export function appendWrapped(lines: string[], prefix: string, value: string, width: number): void {
  const safeWidth = Math.max(1, width);
  const safePrefix = clipToWidth(prefix, safeWidth, "");
  const prefixWidth = visibleWidth(safePrefix);
  const available = Math.max(1, safeWidth - prefixWidth);
  const wrapped = wrapTextWithAnsi(value, available);
  const continuation = Fn.pipe(" ", Str.repeat(prefixWidth));
  for (const [index, line] of wrapped.entries()) {
    lines.push(clipToWidth(`${index === 0 ? safePrefix : continuation}${line}`, safeWidth, ""));
  }
}

export const borderLine = (width: number, theme: Theme): string =>
  theme.fg("accent", Fn.pipe("─", Str.repeat(Math.max(1, width))));

export const editorTheme = (theme: Theme): EditorTheme => ({
  borderColor: (text) => theme.fg("accent", text),
  selectList: {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  },
});

// Right rows must already be exactly `rightWidth` columns wide, as PreviewPane frames them;
// only rows past the end of the right column are filled.
export function joinColumns(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
  leftWidth: number,
  rightWidth: number,
): string[] {
  const count = Math.max(left.length, right.length);
  const blank = Fn.pipe(" ", Str.repeat(Math.max(0, rightWidth)));
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    lines.push(`${padListDetailRow(left[index] ?? "", leftWidth)}  ${right[index] ?? blank}`);
  }
  return lines;
}
