import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerNoticeGlyph,
  type ManagerActivityKind,
  type ManagerNoticeKind,
  clipToWidth,
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
  const clipped = clipToWidth(subtitle, maximum, "… [truncated]");
  return `${title} ${theme.fg("dim", clipped)}`;
};

export type ToolStatusKind = ManagerActivityKind | ManagerNoticeKind;

const noticeColor = (kind: ManagerNoticeKind): ThemeColor =>
  kind === "info" ? "muted" : kind === "success" ? "success" : kind;

/** Shared glyph/color status row for tool activity and notices. */
export const toolStatusLine = (
  theme: Pick<Theme, "fg">,
  kind: ToolStatusKind,
  text: string,
  frame = 0,
): string => {
  const activity = !(
    kind === "info" ||
    kind === "success" ||
    kind === "warning" ||
    kind === "error"
  );
  const glyph = activity ? managerActivityGlyph(kind, frame) : managerNoticeGlyph(kind);
  const color = activity ? managerActivityColor(kind) : noticeColor(kind);
  return theme.fg(color, `${glyph} ${sanitizeTerminalLine(text)}`);
};

/** The one line every tool shows while it runs and has nothing else to show yet. */
export const toolRunningLine = (theme: Pick<Theme, "fg">, frame = 0): string =>
  toolStatusLine(theme, "running", "Running…", frame);

export const expandKeyHint = (keys: ReadonlyArray<string>, fallback = "ctrl+o to expand"): string =>
  keys.length > 0 ? `${keys.map(sanitizeTerminalLine).join("/")} to expand` : fallback;

/** The configured tool-expansion keys, as Pi's own tools show them: "ctrl+o to expand". */
export const toolExpandHint = (): string => {
  let keys: ReadonlyArray<string> = [];
  try {
    const configured: unknown = getKeybindings().getKeys("app.tools.expand");
    if (Array.isArray(configured))
      keys = configured
        .slice(0, 4)
        .filter((key): key is string => Predicate.isString(key) && key.length <= 32);
  } catch {
    keys = [];
  }
  return expandKeyHint(keys);
};

export const renderExpansionAffordance = (
  label: string,
  expanded: boolean,
  theme: Pick<Theme, "fg">,
  hint = toolExpandHint(),
): string => {
  const suffix = expanded || !hint ? "" : ` · ${sanitizeTerminalLine(hint)}`;
  return `${theme.fg("accent", expanded ? "▾" : "▸")} ${theme.fg("muted", `${sanitizeTerminalLine(label)}${suffix}`)}`;
};
