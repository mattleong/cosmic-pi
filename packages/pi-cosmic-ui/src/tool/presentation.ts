import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
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
