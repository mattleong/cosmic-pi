import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { codePreviewPerformanceConfig, codePreviewSettings } from "../config/state";
import { wrapAnsiToWidth } from "../shared/terminal-text";
import { DIFF_ADD_MARKER, DIFF_REMOVE_MARKER } from "./parse";

type DiffLineKind = "add" | "remove";
type DiffBackgroundResolver = (kind: DiffLineKind) => string | undefined;
type MarkedDiffLine = { kind?: DiffLineKind; line: string };

/** Paints marked add/remove rows across the full width, wrapping long rows under the gutter. */
export class FullWidthDiffText implements Component {
  private cachedWidth: number | undefined;
  private cachedRows: string[] | undefined;
  private readonly text: string;
  private readonly theme: Theme | undefined;

  constructor(text: string, theme?: Theme) {
    this.text = text;
    this.theme = theme;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedRows) return this.cachedRows;
    const diffBackground = createDiffBackgroundResolver(this.theme);
    const rows: string[] = [];
    for (const rawLine of this.text.split("\n")) {
      const { kind, line } = parseMarkedDiffLine(rawLine);
      const continuation = continuationPrefix(line);
      const wrappedRows = wrapAnsiToWidth(
        line,
        width,
        codePreviewPerformanceConfig.diffWrapRows,
        visibleWidth(continuation) < width ? continuation : "",
      );
      if (!kind) {
        rows.push(...wrappedRows);
        continue;
      }
      for (const row of wrappedRows) {
        const padding = " ".repeat(Math.max(0, width - visibleWidth(row)));
        rows.push(diffLineBg(kind, row + padding, diffBackground));
      }
    }
    this.cachedWidth = width;
    this.cachedRows = rows;
    return rows;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
  }
}

function parseMarkedDiffLine(rawLine: string): MarkedDiffLine {
  if (rawLine.startsWith(DIFF_ADD_MARKER))
    return { kind: "add", line: rawLine.slice(DIFF_ADD_MARKER.length) };
  if (rawLine.startsWith(DIFF_REMOVE_MARKER))
    return { kind: "remove", line: rawLine.slice(DIFF_REMOVE_MARKER.length) };
  return { line: rawLine };
}

function continuationPrefix(line: string): string {
  const pipe = line.indexOf("│ ");
  if (pipe < 0) return "";
  return " ".repeat(visibleWidth(line.slice(0, pipe + 2)));
}

function createDiffBackgroundResolver(theme?: Theme): DiffBackgroundResolver {
  const intensity = codePreviewSettings.diffIntensity;
  if (intensity === "off") return () => undefined;
  const cache: Partial<Record<DiffLineKind, string>> = {};
  return (kind) =>
    (cache[kind] ??=
      deriveDiffBg(kind, theme, intensity === "medium" ? 0.24 : 0.14) ??
      fallbackDiffBg(kind, intensity));
}

function diffLineBg(
  kind: DiffLineKind,
  line: string,
  diffBackground: DiffBackgroundResolver,
): string {
  const bg = diffBackground(kind);
  if (!bg) return line;
  const coloredLine = line
    .replaceAll("\x1b[0m", `\x1b[0m${bg}`)
    .replaceAll("\x1b[39m", `\x1b[39m${bg}`)
    .replaceAll("\x1b[49m", `\x1b[49m${bg}`);
  return `${bg}${coloredLine}`;
}

function fallbackDiffBg(kind: DiffLineKind, intensity: "subtle" | "medium"): string {
  if (kind === "add") return intensity === "medium" ? "\x1b[48;2;22;68;40m" : "\x1b[48;2;10;42;26m";
  return intensity === "medium" ? "\x1b[48;2;78;36;40m" : "\x1b[48;2;50;24;30m";
}

/** Tints the theme's success/error background toward its diff foreground; test themes may lack ANSI getters. */
function deriveDiffBg(
  kind: DiffLineKind,
  theme: Theme | undefined,
  intensity: number,
): string | undefined {
  const fgRgb = parseAnsiRgb(
    theme?.getFgAnsi?.(kind === "add" ? "toolDiffAdded" : "toolDiffRemoved") ?? "",
  );
  if (!fgRgb) return undefined;
  const base = parseAnsiRgb(
    theme?.getBgAnsi?.(kind === "add" ? "toolSuccessBg" : "toolErrorBg") ?? "",
  ) ??
    parseAnsiRgb(theme?.getBgAnsi?.("toolSuccessBg") ?? "") ?? { r: 0, g: 0, b: 0 };
  return `\x1b[48;2;${Math.round(base.r + (fgRgb.r - base.r) * intensity)};${Math.round(base.g + (fgRgb.g - base.g) * intensity)};${Math.round(base.b + (fgRgb.b - base.b) * intensity)}m`;
}

const DECIMAL_CHANNEL_RE = /^\d+$/;

function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | undefined {
  for (let index = ansi.indexOf("\x1b["); index >= 0; index = ansi.indexOf("\x1b[", index + 1)) {
    const kind = ansi.slice(index + 2, index + 7);
    if (kind !== "38;2;" && kind !== "48;2;") continue;
    const end = ansi.indexOf("m", index + 7);
    if (end < 0) continue;
    const channels = ansi.slice(index + 7, end).split(";");
    if (channels.length !== 3 || !channels.every((channel) => DECIMAL_CHANNEL_RE.test(channel)))
      continue;
    return { r: Number(channels[0]), g: Number(channels[1]), b: Number(channels[2]) };
  }
  return undefined;
}
