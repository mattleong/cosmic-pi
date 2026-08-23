import type { Theme } from "@earendil-works/pi-coding-agent";
import { codePreviewSettings } from "../config/state";

export type DiffLineKind = "add" | "remove";
export type DiffBackgroundResolver = (kind: DiffLineKind) => string | undefined;

export function createDiffBackgroundResolver(theme?: Theme): DiffBackgroundResolver {
  const intensity = codePreviewSettings.diffIntensity;
  if (intensity === "off") return () => undefined;
  const cache: Partial<Record<DiffLineKind, string>> = {};
  return (kind) =>
    (cache[kind] ??=
      deriveDiffBg(kind, theme, intensity === "medium" ? 0.24 : 0.14) ??
      fallbackDiffBg(kind, intensity));
}

export function diffLineBg(
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

function deriveDiffBg(
  kind: DiffLineKind,
  theme: Theme | undefined,
  intensity: number,
): string | undefined {
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  const themed = theme as
    | (Theme & { getFgAnsi?: (key: string) => string; getBgAnsi?: (key: string) => string })
    | undefined;
  const fg = themed?.getFgAnsi?.(kind === "add" ? "toolDiffAdded" : "toolDiffRemoved");
  const fgRgb = parseAnsiRgb(fg ?? "");
  if (!fgRgb) return undefined;
  const base = parseAnsiRgb(
    themed?.getBgAnsi?.(kind === "add" ? "toolSuccessBg" : "toolErrorBg") ?? "",
  ) ??
    parseAnsiRgb(themed?.getBgAnsi?.("toolSuccessBg") ?? "") ?? { r: 0, g: 0, b: 0 };
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
