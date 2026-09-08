import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens, sanitizeTerminalStyledText } from "pi-cosmic-core";
import type {
  CosmicFooterPlacement,
  CosmicFooterTextContribution,
  CosmicFooterTheme,
} from "../protocol/protocol.ts";
import {
  alignSides,
  ranked,
  rawContributionLine,
  renderContributionLine,
} from "./contributions.ts";
import { contextConsumptionTone, progressBar } from "./meter.ts";

export { renderContributionLine, renderLabeledContributionLine } from "./contributions.ts";

function contextUsageCandidates(
  usage: { contextWindow?: number; tokens?: number | null; percent?: number | null } | undefined,
  theme: CosmicFooterTheme,
  compact: boolean,
): string[] {
  const contextWindow = usage?.contextWindow ?? 0;
  const percent = usage?.percent;
  const label = theme.fg("text", "▤");
  if (percent === null || percent === undefined)
    return [`${label} ${theme.fg("text", `?/${formatTokens(contextWindow)}`)}`];

  const cells = compact ? 6 : 10;
  const tokens = usage?.tokens ?? Math.round((percent / 100) * contextWindow);
  const color = contextConsumptionTone(percent);
  const meter = progressBar(percent, cells, theme, color);
  const percentage = theme.fg(color, `${Math.round(percent)}%`);
  const counts = theme.fg("text", `${formatTokens(tokens)}/${formatTokens(contextWindow)}`);
  // Counts are the first responsive detail to drop, followed by the meter. This keeps the
  // percentage useful on narrow terminals while preserving the healthy/warning tone.
  return [
    `${label} ${meter} ${percentage} ${counts}`,
    `${label} ${meter} ${percentage}`,
    `${label} ${percentage}`,
  ];
}

/** Renders the model identity at left and the context meter at right without a fixed right budget. */
export function renderModelContextLine(
  modelIdentity: CosmicFooterTextContribution[],
  usage: { contextWindow?: number; tokens?: number | null; percent?: number | null } | undefined,
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string {
  if (width <= 0) return "";
  const leftRaw = rawContributionLine(ranked(modelIdentity), compact);
  const leftWidth = visibleWidth(leftRaw);
  const contextBudget = leftRaw ? Math.max(1, width - leftWidth - 2) : width;
  const candidates = contextUsageCandidates(usage, theme, compact);
  // Prefer the fullest context projection that fits beside model identity. If identity is too
  // wide, retain the percentage before clipping identity; counts and then the meter are dropped.
  const context =
    candidates.find((candidate) => visibleWidth(candidate) <= contextBudget) ??
    (visibleWidth(candidates.at(-1) ?? "") <= width
      ? (candidates.at(-1) ?? "")
      : truncateToWidth(candidates.at(-1) ?? "", width, ""));
  const contextWidth = visibleWidth(context);
  const leftBudget = Math.max(0, width - contextWidth - (leftRaw ? 2 : 0));
  const left = modelIdentity.length
    ? renderContributionLine(modelIdentity, leftBudget, theme, compact)
    : "";
  return alignSides(left, context, width);
}

/**
 * Compatibility wrapper for callers that used the old context/session arrangement. New footer
 * rows place model contributions on the left and call renderModelContextLine directly.
 */
export function renderContextLine(
  usage: { contextWindow?: number; tokens?: number | null; percent?: number | null } | undefined,
  sessionInfo: CosmicFooterTextContribution[],
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string {
  return renderModelContextLine(sessionInfo, usage, width, theme, compact);
}

function spaces(width: number): string {
  return " ".repeat(Math.max(0, width));
}

function padTextToWidth(value: string, width: number): string {
  return value + spaces(width - visibleWidth(value));
}

const KITTY_IMAGE_LINE_PATTERN = new RegExp(
  String.raw`^(?:\u001B_Ga=T(?:,[A-Za-z]=[A-Za-z0-9]+)*;[A-Za-z0-9+/]*(?:={0,2})\u001B\\)(?:\u001B_Gm=[01];[A-Za-z0-9+/]*(?:={0,2})\u001B\\)*$`,
  "u",
);
const ITERM_IMAGE_LINE_PATTERN = new RegExp(
  String.raw`^(?:\u001B\[\d+A)?\u001B\]1337;File=[A-Za-z][A-Za-z0-9]*=[A-Za-z0-9+/%=._-]+(?:;[A-Za-z][A-Za-z0-9]*=[A-Za-z0-9+/%=._-]+)*:[A-Za-z0-9+/]*(?:={0,2})\u0007$`,
  "u",
);

/** Recognizes only complete, line-anchored image sequences emitted by pi-tui. */
export function isTerminalImageLine(line: string): boolean {
  return KITTY_IMAGE_LINE_PATTERN.test(line) || ITERM_IMAGE_LINE_PATTERN.test(line);
}

const SAFE_SGR_PATTERN = new RegExp(String.raw`\u001B\[[0-9;]*m`, "u");

const sanitizeSurfaceLine = (line: string): string => {
  if (isTerminalImageLine(line)) return line;
  const sanitized = sanitizeTerminalStyledText(line).replace(/\n+/gu, " ");
  // A surface array element is exactly one terminal line. Close any retained visual style so it
  // cannot bleed into adjacent inline footer text or the next rendered row.
  return SAFE_SGR_PATTERN.test(sanitized) ? `${sanitized}\x1b[0m` : sanitized;
};

function surfaceLineCell(line: string, width: number): string {
  if (!line) return spaces(width);
  if (isTerminalImageLine(line)) return `\x1b[0m${line}`;
  return padTextToWidth(truncateToWidth(line, width, ""), width);
}

function stripLeadingCursorUp(line: string): string {
  if (!line.startsWith("\x1b[")) return line;
  const end = line.indexOf("A", 2);
  if (end === -1) return line;
  return /^\d+$/.test(line.slice(2, end)) ? line.slice(end + 1) : line;
}

function terminalImageInlineLeftSequence(line: string, totalRows: number): string {
  const moveUp = totalRows > 1 ? `\x1b[${totalRows - 1}A` : "";
  const moveDown = totalRows > 1 ? `\x1b[${totalRows - 1}B` : "";
  const balancedLine = stripLeadingCursorUp(line);
  return `\x1b[0m\r${moveUp}${balancedLine}${moveDown}`;
}

export function combineSurface(
  surfaceLines: string[],
  textLines: string[],
  width: number,
  placement: CosmicFooterPlacement,
  requestedSurfaceWidth: number,
): string[] {
  if (surfaceLines.length === 0) return textLines.map((line) => truncateToWidth(line, width, ""));
  const sanitizedSurfaceLines = surfaceLines.map(sanitizeSurfaceLine);
  if (placement === "stacked" || placement === "habitat") {
    const divider = placement === "habitat" ? ["─".repeat(width)] : [];
    return [...divider, ...sanitizedSurfaceLines, ...textLines].map((line) =>
      isTerminalImageLine(line) ? line : truncateToWidth(line, width, ""),
    );
  }

  const gap = 2;
  const surfaceWidth = Math.min(requestedSurfaceWidth, Math.max(1, width - 1));
  const textWidth = Math.max(1, width - surfaceWidth - gap);
  const totalRows = Math.max(sanitizedSurfaceLines.length, textLines.length);
  const leftImageLine =
    placement === "inline-left" ? sanitizedSurfaceLines.find(isTerminalImageLine) : undefined;
  const renderSurfaceOnRight = placement === "inline-right" || placement === "badge";
  const lines: string[] = [];

  for (let row = 0; row < totalRows; row++) {
    const surfaceLine = sanitizedSurfaceLines[row] ?? "";
    const textLine = textLines[row] ?? "";
    const textPart = truncateToWidth(textLine, textWidth, "");
    const surfacePart = leftImageLine
      ? spaces(surfaceWidth)
      : surfaceLineCell(surfaceLine, surfaceWidth);
    lines.push(
      renderSurfaceOnRight
        ? `${padTextToWidth(textPart, textWidth)}${spaces(gap)}${surfacePart}`
        : `${surfacePart}${spaces(gap)}${textPart}`,
    );
  }

  if (leftImageLine && lines.length > 0) {
    lines[lines.length - 1] += terminalImageInlineLeftSequence(leftImageLine, totalRows);
  }
  return lines;
}
