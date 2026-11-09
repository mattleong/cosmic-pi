import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { EditorTheme } from "@earendil-works/pi-tui";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { padListDetailRow } from "pi-cosmic-ui/manager/list-detail";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { wrapKeyHints } from "pi-cosmic-ui/manager/key-labels";
import { stripTerminalControls } from "pi-cosmic-core/security";

// Titles only label tabs, review rows, and headings; the schema admits longer ones than fit there.
const MAX_TITLE_LABEL_WIDTH = 24;

// Plain text, since a heading subject escapes the styling a clipped label would carry.
export const titleLabel = (title: string): string =>
  stripTerminalControls(clipToWidth(stripTerminalControls(title), MAX_TITLE_LABEL_WIDTH));

/**
 * Wraps `value` after `prefix`. Continuation lines hang `hang` columns further in, under the text
 * that follows a list number or label; every line wraps at the narrower width so they align.
 */
export function appendWrapped(
  lines: string[],
  prefix: string,
  value: string,
  width: number,
  hang = 0,
): void {
  const safeWidth = Math.max(1, width);
  const safePrefix = clipToWidth(prefix, safeWidth, "");
  const prefixWidth = visibleWidth(safePrefix);
  const indent = Math.max(0, Math.min(hang, safeWidth - prefixWidth - 8));
  const available = Math.max(1, safeWidth - prefixWidth - indent);
  const wrapped = wrapTextWithAnsi(value, available);
  const continuation = Fn.pipe(" ", Str.repeat(prefixWidth + indent));
  for (const [index, line] of wrapped.entries()) {
    lines.push(clipToWidth(`${index === 0 ? safePrefix : continuation}${line}`, safeWidth, ""));
  }
}

/**
 * Wraps a hint bar between `Key Verb` pairs, so a key never lands on a different line than its
 * verb and every hint survives at narrow widths.
 */
export function appendHintBar(
  lines: string[],
  hints: string,
  width: number,
  style: (text: string) => string,
): void {
  for (const entry of wrapKeyHints(hints, Math.max(1, width - 1)))
    appendWrapped(lines, " ", style(entry), width);
}

interface PackedRows {
  readonly separator: string;
  /** Styles each row's text; parts may also arrive pre-styled. */
  readonly style?: (text: string) => string;
  /** Leads the first row. */
  readonly prefix?: string;
  /** Leads each later row; by default it hangs two columns past `prefix`. */
  readonly continuation?: string;
}

/**
 * Packs parts into rows joined by `separator`, breaking only between parts so a tab, ID, or fact
 * never splits across lines. A part wider than the row is clipped with `…`.
 */
export function appendPacked(
  lines: string[],
  parts: readonly string[],
  width: number,
  { separator, style = Fn.identity, prefix = "", continuation = `${prefix}  ` }: PackedRows,
): void {
  const safeWidth = Math.max(1, width);
  let lead = prefix;
  let row = "";
  const flush = () => {
    lines.push(clipToWidth(`${lead}${style(row)}`, safeWidth));
    lead = continuation;
  };
  for (const part of parts) {
    const candidate = row === "" ? part : `${row}${separator}${part}`;
    if (row === "" || visibleWidth(lead) + visibleWidth(candidate) <= safeWidth) row = candidate;
    else {
      flush();
      row = part;
    }
  }
  if (row !== "") flush();
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
