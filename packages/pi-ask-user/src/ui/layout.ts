import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SelectListTheme } from "@earendil-works/pi-tui";
import { padListDetailRow } from "pi-cosmic-ui/manager/list-detail";
import { clipToWidth } from "pi-cosmic-ui/manager";

export function appendWrapped(lines: string[], prefix: string, value: string, width: number): void {
  const safeWidth = Math.max(1, width);
  const safePrefix = clipToWidth(prefix, safeWidth, "");
  const prefixWidth = visibleWidth(safePrefix);
  const available = Math.max(1, safeWidth - prefixWidth);
  const wrapped = wrapTextWithAnsi(value, available);
  const continuation = " ".repeat(prefixWidth);
  for (let index = 0; index < wrapped.length; index++) {
    lines.push(
      clipToWidth(`${index === 0 ? safePrefix : continuation}${wrapped[index]}`, safeWidth, ""),
    );
  }
}

export const padLine = padListDetailRow;

export const borderLine = (width: number, theme: Theme): string =>
  theme.fg("accent", "─".repeat(Math.max(1, width)));

export const selectListTheme = (theme: Theme, marker = ""): SelectListTheme => ({
  selectedPrefix: (text) => theme.fg("accent", text),
  selectedText: (text) => marker + theme.fg("accent", text),
  description: (text) => theme.fg("muted", text),
  scrollInfo: (text) => theme.fg("dim", text),
  noMatch: (text) => theme.fg("warning", text),
});

export function joinColumns(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
  leftWidth: number,
  rightWidth: number,
  gap = 2,
): string[] {
  const count = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    lines.push(
      `${padLine(left[index] ?? "", leftWidth)}${" ".repeat(gap)}${padLine(right[index] ?? "", rightWidth)}`,
    );
  }
  return lines;
}
