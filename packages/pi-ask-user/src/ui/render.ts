import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripTerminalControls } from "pi-cosmic-core";

export const safeText = (value: string): string => stripTerminalControls(value);

export function appendWrapped(lines: string[], prefix: string, value: string, width: number): void {
  const safeWidth = Math.max(1, width);
  const safePrefix = truncateToWidth(prefix, safeWidth, "");
  const prefixWidth = visibleWidth(safePrefix);
  const available = Math.max(1, safeWidth - prefixWidth);
  const wrapped = wrapTextWithAnsi(value, available);
  const continuation = " ".repeat(prefixWidth);
  for (let index = 0; index < wrapped.length; index++) {
    lines.push(
      truncateToWidth(`${index === 0 ? safePrefix : continuation}${wrapped[index]}`, safeWidth, ""),
    );
  }
}

export function padLine(value: string, width: number): string {
  const truncated = truncateToWidth(value, Math.max(0, width), "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

export const borderLine = (width: number, theme: Theme): string =>
  theme.fg("accent", "─".repeat(Math.max(1, width)));

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
