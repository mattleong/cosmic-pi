import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
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

export const renderToolHeader = (header: ToolHeader, theme: Pick<Theme, "bold" | "fg">): string => {
  const title = theme.fg("toolTitle", theme.bold(sanitizeTerminalLine(header.title)));
  if (!header.subtitle) return title;
  const clipped = clipToWidth(sanitizeTerminalLine(header.subtitle), 160, "… [truncated]");
  return `${title} ${theme.fg("dim", clipped)}`;
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

const isExpandKey = Schema.is(Schema.String.check(Schema.isMaxLength(32)));

export const toolExpandHint = (): string => {
  const keys = invokeHostCallback((): ReadonlyArray<string> => {
    const configured: unknown = getKeybindings().getKeys("app.tools.expand");
    return Arr.isArray(configured) ? Arr.filter(configured.slice(0, 4), isExpandKey) : [];
  }, []);
  return keys.length > 0
    ? `${Arr.join(Arr.map(keys, sanitizeTerminalLine), "/")} to expand`
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
