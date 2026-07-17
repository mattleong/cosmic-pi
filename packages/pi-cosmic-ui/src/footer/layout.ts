import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
  CosmicFooterPlacement,
  CosmicFooterTextContribution,
  CosmicFooterTheme,
} from "../protocol.ts";

export function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

function tone(
  theme: CosmicFooterTheme,
  contribution: CosmicFooterTextContribution,
  text: string,
): string {
  return contribution.tone && contribution.tone !== "normal"
    ? theme.fg(contribution.tone, text)
    : theme.fg("dim", text);
}

function ranked(contributions: CosmicFooterTextContribution[]): CosmicFooterTextContribution[] {
  return [...contributions].sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100) || (b.priority ?? 50) - (a.priority ?? 50),
  );
}

function contributionText(entry: CosmicFooterTextContribution, compact: boolean): string {
  return compact && entry.compactText ? entry.compactText : entry.text;
}

function fitContributions(
  entries: CosmicFooterTextContribution[],
  available: number,
  compact: boolean,
): CosmicFooterTextContribution[] {
  const kept = [...entries];
  while (kept.length > 1) {
    const value = kept
      .map((entry) => contributionText(entry, compact))
      .filter(Boolean)
      .join(" • ");
    if (visibleWidth(value) <= available) break;
    let lowest = 0;
    for (let index = 1; index < kept.length; index++) {
      if ((kept[index]?.priority ?? 50) < (kept[lowest]?.priority ?? 50)) lowest = index;
    }
    kept.splice(lowest, 1);
  }
  return kept;
}

function rawContributionLine(entries: CosmicFooterTextContribution[], compact: boolean): string {
  return entries
    .map((entry) => contributionText(entry, compact))
    .filter(Boolean)
    .join(" • ");
}

function styledContributionLine(
  entries: CosmicFooterTextContribution[],
  compact: boolean,
  clipped: string,
  raw: string,
  theme: CosmicFooterTheme,
): string {
  if (clipped !== raw) return theme.fg("dim", clipped);
  return entries
    .filter((entry) => Boolean(contributionText(entry, compact)))
    .map((entry) => tone(theme, entry, contributionText(entry, compact)))
    .join(theme.fg("dim", " • "));
}

export function renderContributionLine(
  contributions: CosmicFooterTextContribution[],
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string {
  if (width <= 0) return "";
  const visible = ranked(contributions);
  const left = visible.filter((entry) => entry.align !== "right");
  const right = visible.filter((entry) => entry.align === "right");

  const rightBudget = left.length > 0 ? Math.floor(width * 0.55) : width;
  const fittedRight = fitContributions(right, rightBudget, compact);
  const rightRaw = rawContributionLine(fittedRight, compact);
  const clippedRight = truncateToWidth(rightRaw, rightBudget, "");
  const rightWidth = visibleWidth(clippedRight);

  const reservedGap = left.length > 0 && rightWidth > 0 ? 2 : 0;
  const leftAvailable = Math.max(0, width - rightWidth - reservedGap);
  const fittedLeft = fitContributions(left, leftAvailable, compact);
  const leftRaw = rawContributionLine(fittedLeft, compact);
  const clippedLeft = truncateToWidth(leftRaw, leftAvailable, "…");
  const leftWidth = visibleWidth(clippedLeft);

  const styledLeft = styledContributionLine(fittedLeft, compact, clippedLeft, leftRaw, theme);
  const styledRight = styledContributionLine(fittedRight, compact, clippedRight, rightRaw, theme);
  if (!clippedRight) return truncateToWidth(styledLeft, width, "");
  if (!clippedLeft) return truncateToWidth(styledRight, width, "");

  const padding = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
  return truncateToWidth(`${styledLeft}${padding}${styledRight}`, width, "");
}

function spaces(width: number): string {
  return " ".repeat(Math.max(0, width));
}

function padTextToWidth(value: string, width: number): string {
  return value + spaces(width - visibleWidth(value));
}

export function isTerminalImageLine(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

function surfaceLineCell(line: string, width: number): string {
  if (!line) return spaces(width);
  if (isTerminalImageLine(line)) return `\x1b[0m${line}`;
  const clipped = truncateToWidth(line, width, "");
  return clipped + spaces(width - visibleWidth(clipped));
}

function stripLeadingCursorUp(line: string): string {
  if (!line.startsWith("\x1b[")) return line;
  const end = line.indexOf("A", 2);
  if (end === -1) return line;
  return /^\d+$/.test(line.slice(2, end)) ? line.slice(end + 1) : line;
}

function stripTrailingCursorDown(line: string): string {
  if (!line.endsWith("B")) return line;
  const start = line.lastIndexOf("\x1b[");
  if (start === -1) return line;
  return /^\d+$/.test(line.slice(start + 2, -1)) ? line.slice(0, start) : line;
}

function terminalImageInlineLeftSequence(line: string, totalRows: number): string {
  const moveUp = totalRows > 1 ? `\x1b[${totalRows - 1}A` : "";
  const moveDown = totalRows > 1 ? `\x1b[${totalRows - 1}B` : "";
  const balancedLine = stripTrailingCursorDown(stripLeadingCursorUp(line));
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
  if (placement === "stacked" || placement === "habitat") {
    const divider = placement === "habitat" ? ["─".repeat(width)] : [];
    return [...divider, ...surfaceLines, ...textLines].map((line) =>
      isTerminalImageLine(line) ? line : truncateToWidth(line, width, ""),
    );
  }

  const gap = 2;
  const surfaceWidth = Math.min(requestedSurfaceWidth, Math.max(1, width - 1));
  const textWidth = Math.max(1, width - surfaceWidth - gap);
  const totalRows = Math.max(surfaceLines.length, textLines.length);
  const hasTerminalImage = surfaceLines.some(isTerminalImageLine);
  const leftImageLine =
    placement === "inline-left" ? surfaceLines.find(isTerminalImageLine) : undefined;
  const renderSurfaceOnRight =
    placement === "inline-right" ||
    placement === "badge" ||
    (placement !== "inline-left" && hasTerminalImage);
  const lines: string[] = [];

  for (let row = 0; row < totalRows; row++) {
    const surfaceLine = surfaceLines[row] ?? "";
    const textLine = textLines[row] ?? "";
    const textPart = truncateToWidth(textLine, textWidth, "");
    const surfacePart = leftImageLine
      ? spaces(surfaceWidth)
      : surfaceLineCell(surfaceLine, surfaceWidth);
    if (renderSurfaceOnRight) {
      lines.push(`${padTextToWidth(textPart, textWidth)}${spaces(gap)}${surfacePart}`);
    } else {
      lines.push(`${surfacePart}${spaces(gap)}${textPart}`);
    }
  }

  if (leftImageLine && lines.length > 0) {
    lines[lines.length - 1] += terminalImageInlineLeftSequence(leftImageLine, totalRows);
  }
  return lines;
}
