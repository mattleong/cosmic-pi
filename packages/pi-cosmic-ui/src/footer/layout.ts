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

const USAGE_WINDOW_COLOR = "accent";

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

function progressTone(percent: number, remaining: boolean, healthyColor: string): string {
  if (remaining) {
    if (percent <= 10) return "error";
    if (percent <= 30) return "warning";
    return healthyColor;
  }
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return healthyColor;
}

function progressBar(
  percent: number,
  cells: number,
  theme: CosmicFooterTheme,
  remaining = false,
  healthyColor = "accent",
): string {
  const value = clampPercent(percent);
  const filled = Math.round((value / 100) * cells);
  const color = progressTone(value, remaining, healthyColor);
  return theme.fg(color, `${"█".repeat(filled)}${"░".repeat(cells - filled)}`);
}

function alignSides(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, width, "");
  if (!left) return truncateToWidth(right, width, "");
  const rightWidth = Math.min(visibleWidth(right), Math.floor(width * 0.48));
  const clippedRight = truncateToWidth(right, rightWidth, "");
  const leftWidth = Math.max(0, width - visibleWidth(clippedRight) - 2);
  const clippedLeft = truncateToWidth(left, leftWidth, "…");
  const padding = " ".repeat(
    Math.max(1, width - visibleWidth(clippedLeft) - visibleWidth(clippedRight)),
  );
  return truncateToWidth(`${clippedLeft}${padding}${clippedRight}`, width, "");
}

export function renderContextLine(
  usage: { contextWindow?: number; tokens?: number | null; percent?: number | null } | undefined,
  sessionInfo: CosmicFooterTextContribution[],
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string {
  const contextWindow = usage?.contextWindow ?? 0;
  const percent = usage?.percent;
  let left: string;
  if (percent === null || percent === undefined) {
    left =
      theme.fg("mdHeading", compact ? "Ctx " : "Context ") +
      theme.fg("syntaxNumber", `?/${formatTokens(contextWindow)}`);
  } else {
    const cells = compact ? (width < 48 ? 6 : 8) : 12;
    const tokens = usage?.tokens ?? Math.round((percent / 100) * contextWindow);
    left = [
      theme.fg("mdHeading", compact ? "Ctx " : "Context "),
      progressBar(percent, cells, theme, false, "accent"),
      theme.fg(
        progressTone(percent, false, "syntaxNumber"),
        ` ${Math.round(percent)}% · ${formatTokens(tokens)}/${formatTokens(contextWindow)}`,
      ),
    ].join("");
  }
  const right =
    width >= 48 && sessionInfo.length
      ? renderContributionLine(sessionInfo, Math.floor(width * 0.48), theme, compact)
      : "";
  return alignSides(left, right, width);
}

export function renderOpenAIUsageLine(
  text: string,
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string {
  const body = text.replace(/^Usage:\s*/i, "");
  const pattern = /(5h|7d):\s*(\d+(?:\.\d+)?)%/gi;
  const cells = compact ? 6 : 10;
  const pieces = [theme.fg("mdHeading", "OpenAI  ")];
  let cursor = 0;
  let matched = false;
  for (const match of body.matchAll(pattern)) {
    matched = true;
    const index = match.index ?? 0;
    if (index > cursor) pieces.push(theme.fg("syntaxOperator", body.slice(cursor, index)));
    const percent = Number(match[2]);
    const fiveHour = match[1]?.toLowerCase() === "5h";
    const labelColor = USAGE_WINDOW_COLOR;
    const barColor = fiveHour ? "accent" : "mdLink";
    const color = progressTone(percent, true, barColor);
    pieces.push(theme.fg(labelColor, `${match[1]?.toLowerCase()} `));
    pieces.push(progressBar(percent, cells, theme, true, barColor));
    pieces.push(theme.fg(color, ` ${Math.round(percent)}%`));
    cursor = index + match[0].length;
  }
  if (!matched) return truncateToWidth(theme.fg("mdLink", `OpenAI  ${body}`), width, "");
  if (cursor < body.length) pieces.push(theme.fg("syntaxOperator", body.slice(cursor)));
  return truncateToWidth(pieces.join(""), width, "");
}

function contributionColor(contribution: CosmicFooterTextContribution): string {
  if (contribution.tone === "warning" || contribution.tone === "error") return contribution.tone;
  switch (contribution.id) {
    case "model":
      return "mdLink";
    case "effort":
      return "syntaxOperator";
    case "location":
      return "accent";
    case "openai.fast":
      return "syntaxFunction";
    case "branch":
      return "syntaxType";
    case "git":
      return "syntaxOperator";
    case "session":
      return "customMessageLabel";
    case "metrics.input":
      return "syntaxVariable";
    case "metrics.output":
      return "syntaxFunction";
    case "metrics.cacheRead":
      return "syntaxType";
    case "metrics.cacheWrite":
      return "syntaxKeyword";
    case "metrics.cost":
      return "syntaxNumber";
    case "extensions":
      return "mdLink";
    default:
      return "accent";
  }
}

function tone(
  theme: CosmicFooterTheme,
  contribution: CosmicFooterTextContribution,
  text: string,
): string {
  if (contribution.id === "git.lines") {
    return text
      .split(" ")
      .filter(Boolean)
      .map((value) => {
        const color = value.startsWith("+")
          ? "success"
          : value.startsWith("-")
            ? "error"
            : "syntaxNumber";
        return theme.fg(color, value);
      })
      .join(" ");
  }
  return theme.fg(contributionColor(contribution), text);
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
  if (clipped !== raw) return theme.fg("accent", clipped);
  return entries
    .filter((entry) => Boolean(contributionText(entry, compact)))
    .map((entry) => tone(theme, entry, contributionText(entry, compact)))
    .join(theme.fg("syntaxPunctuation", " • "));
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
