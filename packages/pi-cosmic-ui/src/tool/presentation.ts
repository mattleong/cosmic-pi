import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, sanitizeTerminalStyledText } from "pi-cosmic-core";
import {
  managerActivityColor,
  managerActivityGlyph,
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
  readonly maxSubtitleWidth?: number | undefined;
}

/** Pi-native tool title and optional bounded subtitle. */
export const renderToolHeader = (header: ToolHeader, theme: Pick<Theme, "bold" | "fg">): string => {
  const title = theme.fg("toolTitle", theme.bold(sanitizeTerminalLine(header.title)));
  if (!header.subtitle) return title;
  const subtitle = sanitizeTerminalLine(header.subtitle);
  const maximum = Math.max(1, header.maxSubtitleWidth ?? 160);
  const clipped = truncateToWidth(subtitle, maximum, "… [truncated]");
  return `${title} ${theme.fg("dim", clipped)}`;
};

export type ToolStatusKind = ManagerActivityKind | ManagerNoticeKind;

const noticeColor = (kind: ManagerNoticeKind): ThemeColor =>
  kind === "info" ? "accent" : kind === "success" ? "success" : kind;

/** Shared glyph/color status row for tool activity and notices. */
export const toolStatusLine = (
  theme: Pick<Theme, "fg">,
  kind: ToolStatusKind,
  text: string,
  frame = 0,
): string => {
  const activity =
    kind === "pending" ||
    kind === "running" ||
    kind === "done" ||
    kind === "failed" ||
    kind === "stopped" ||
    kind === "stopping";
  const glyph = activity ? managerActivityGlyph(kind, frame) : managerNoticeGlyph(kind);
  const color = activity ? managerActivityColor(kind) : noticeColor(kind);
  return theme.fg(color, `${glyph} ${sanitizeTerminalLine(text)}`);
};

export const expandKeyHint = (keys: ReadonlyArray<string>, fallback = "ctrl+o to expand"): string =>
  keys.length > 0 ? `${keys.map(sanitizeTerminalLine).join("/")} to expand` : fallback;

export const renderExpansionAffordance = (
  label: string,
  expanded: boolean,
  theme: Pick<Theme, "fg">,
  hint = "ctrl+o to expand",
): string => {
  const suffix = expanded || !hint ? "" : ` · ${sanitizeTerminalLine(hint)}`;
  return `${theme.fg("accent", expanded ? "▾" : "▸")} ${theme.fg("muted", `${sanitizeTerminalLine(label)}${suffix}`)}`;
};

export interface ToolSection {
  readonly heading?: string | undefined;
  readonly lines: ReadonlyArray<string>;
  readonly tone?: "output" | "error" | "muted" | "dim" | undefined;
}

const sectionColor = (tone: ToolSection["tone"]): ThemeColor => {
  if (tone === "error") return "error";
  if (tone === "muted" || tone === "dim") return tone;
  return "toolOutput";
};

/** Bounded semantic sections only; preview line windows remain owned by pi-code-previews. */
export const renderToolSections = (
  sections: ReadonlyArray<ToolSection>,
  theme: Pick<Theme, "fg">,
  width: number,
): string[] => {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return [];
  const rows: string[] = [];
  for (const section of sections) {
    if (section.heading)
      rows.push(
        truncateToWidth(theme.fg("muted", sanitizeTerminalLine(section.heading)), safeWidth, ""),
      );
    for (const line of section.lines) {
      const safe = sanitizeTerminalStyledText(line);
      rows.push(truncateToWidth(theme.fg(sectionColor(section.tone), safe), safeWidth, ""));
    }
  }
  return rows.filter((row) => visibleWidth(row) <= safeWidth);
};
