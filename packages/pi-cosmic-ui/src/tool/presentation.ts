import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { invokeHostCallback, sanitizeTerminalLine } from "pi-cosmic-core";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerNoticeColor,
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
}

/** Pi-native tool title and optional subtitle, bounded to 160 columns. */
export const renderToolHeader = (header: ToolHeader, theme: Pick<Theme, "bold" | "fg">): string => {
  const title = theme.fg("toolTitle", theme.bold(sanitizeTerminalLine(header.title)));
  if (!header.subtitle) return title;
  const clipped = clipToWidth(sanitizeTerminalLine(header.subtitle), 160, "… [truncated]");
  return `${title} ${theme.fg("dim", clipped)}`;
};

type ToolStatusKind = ManagerActivityKind | ManagerNoticeKind;

const isNotice = (kind: ToolStatusKind): kind is ManagerNoticeKind =>
  kind === "info" || kind === "success" || kind === "warning" || kind === "error";

/** Shared glyph/color status row for tool activity and notices. */
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

/** The one line every tool shows while it runs and has nothing else to show yet. */
export const toolRunningLine = (theme: Pick<Theme, "fg">, frame = 0): string =>
  toolStatusLine(theme, "running", "Running…", frame);

/** The configured tool-expansion keys, as Pi's own tools show them: "ctrl+o to expand". */
export const toolExpandHint = (): string => {
  const keys = invokeHostCallback((): ReadonlyArray<string> => {
    const configured: unknown = getKeybindings().getKeys("app.tools.expand");
    return Array.isArray(configured)
      ? configured
          .slice(0, 4)
          .filter((key): key is string => Predicate.isString(key) && key.length <= 32)
      : [];
  }, []);
  return keys.length > 0
    ? `${keys.map(sanitizeTerminalLine).join("/")} to expand`
    : "ctrl+o to expand";
};

export const renderExpansionAffordance = (
  label: string,
  expanded: boolean,
  theme: Pick<Theme, "fg">,
): string => {
  const hint = toolExpandHint();
  const suffix = expanded || !hint ? "" : ` · ${sanitizeTerminalLine(hint)}`;
  return `${theme.fg("accent", expanded ? "▾" : "▸")} ${theme.fg("muted", `${sanitizeTerminalLine(label)}${suffix}`)}`;
};
