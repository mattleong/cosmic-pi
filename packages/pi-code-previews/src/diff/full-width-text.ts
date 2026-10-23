import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { indexOfFrom } from "pi-cosmic-core/text-scan";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { codePreviewPerformanceConfig, codePreviewSettings } from "../config/state";
import type { CodePreviewSettings } from "../config/schema";
import { wrapAnsiToWidth } from "../shared/terminal-text";
import { DIFF_ADD_MARKER, DIFF_REMOVE_MARKER } from "./parse";

type DiffLineKind = "add" | "remove";
type DiffBackgroundResolver = (kind: DiffLineKind) => string | undefined;
type MarkedDiffLine = { kind?: DiffLineKind; line: string };

export class FullWidthDiffText implements Component {
  private cachedWidth: number | undefined;
  private cachedRows: string[] | undefined;
  private readonly text: string;
  private readonly theme: Theme | undefined;
  private readonly intensity: CodePreviewSettings["diffIntensity"];
  private readonly maxRows = codePreviewPerformanceConfig.diffWrapRows;

  constructor(text: string, theme?: Theme, intensity = codePreviewSettings.diffIntensity) {
    this.text = text;
    this.theme = theme;
    this.intensity = intensity;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedRows) return this.cachedRows;
    const diffBackground = createDiffBackgroundResolver(this.intensity, this.theme);
    const rows: string[] = [];
    for (const rawLine of Str.split(this.text, "\n")) {
      const { kind, line } = parseMarkedDiffLine(rawLine);
      const continuation = continuationPrefix(line);
      const wrappedRows = wrapAnsiToWidth(
        line,
        width,
        this.maxRows,
        visibleWidth(continuation) < width ? continuation : "",
      );
      if (!kind) {
        rows.push(...wrappedRows);
        continue;
      }
      for (const row of wrappedRows) {
        const padding = Fn.pipe(" ", Str.repeat(Math.max(0, width - visibleWidth(row))));
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
  if (Fn.pipe(rawLine, Str.startsWith(DIFF_ADD_MARKER)))
    return { kind: "add", line: Fn.pipe(rawLine, Str.slice(DIFF_ADD_MARKER.length)) };
  if (Fn.pipe(rawLine, Str.startsWith(DIFF_REMOVE_MARKER)))
    return { kind: "remove", line: Fn.pipe(rawLine, Str.slice(DIFF_REMOVE_MARKER.length)) };
  return { line: rawLine };
}

function continuationPrefix(line: string): string {
  const pipe = Fn.pipe(line, Str.indexOf("│ "));
  if (Option.isNone(pipe)) return "";
  return Fn.pipe(" ", Str.repeat(visibleWidth(Fn.pipe(line, Str.slice(0, pipe.value + 2)))));
}

function createDiffBackgroundResolver(
  intensity: CodePreviewSettings["diffIntensity"],
  theme?: Theme,
): DiffBackgroundResolver {
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
  const coloredLine = Fn.pipe(
    line,
    Str.replaceAll("\x1b[0m", `\x1b[0m${bg}`),
    Str.replaceAll("\x1b[39m", `\x1b[39m${bg}`),
    Str.replaceAll("\x1b[49m", `\x1b[49m${bg}`),
  );
  return `${bg}${coloredLine}`;
}

function fallbackDiffBg(kind: DiffLineKind, intensity: "subtle" | "medium"): string {
  if (kind === "add") return intensity === "medium" ? "\x1b[48;2;22;68;40m" : "\x1b[48;2;10;42;26m";
  return intensity === "medium" ? "\x1b[48;2;78;36;40m" : "\x1b[48;2;50;24;30m";
}

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
  for (
    let index = indexOfFrom(ansi, "\x1b[", 0);
    index >= 0;
    index = indexOfFrom(ansi, "\x1b[", index + 1)
  ) {
    const kind = Fn.pipe(ansi, Str.slice(index + 2, index + 7));
    if (kind !== "38;2;" && kind !== "48;2;") continue;
    const end = indexOfFrom(ansi, "m", index + 7);
    if (end < 0) continue;
    const channels = Str.split(Fn.pipe(ansi, Str.slice(index + 7, end)), ";");
    if (
      channels.length !== 3 ||
      !Arr.every(channels, (channel) => DECIMAL_CHANNEL_RE.test(channel))
    )
      continue;
    return { r: Number(channels[0]), g: Number(channels[1]), b: Number(channels[2]) };
  }
  return undefined;
}
