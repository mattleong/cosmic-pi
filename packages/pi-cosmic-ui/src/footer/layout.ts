import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  clampPercent,
  formatTokens,
  sanitizeTerminalLine,
  sanitizeTerminalStyledText,
} from "pi-cosmic-core";
import type {
  CosmicFooterColor,
  CosmicFooterPlacement,
  CosmicFooterTextContribution,
  CosmicFooterTheme,
} from "../protocol/protocol.ts";

type ProgressTone = "success" | "warning" | "error";

function remainingCapacityTone(percent: number): ProgressTone {
  if (percent >= 75) return "success";
  if (percent >= 25) return "warning";
  return "error";
}

function contextConsumptionTone(percent: number): ProgressTone {
  if (percent > 75) return "error";
  if (percent > 50) return "warning";
  return "success";
}

function progressBar(
  percent: number,
  cells: number,
  theme: CosmicFooterTheme,
  tone: ProgressTone,
): string {
  const value = clampPercent(percent);
  if (value >= 100) return theme.fg(tone, "━".repeat(cells));
  const filled = Math.floor((value / 100) * cells);
  return theme.fg(tone, `${"━".repeat(filled)}╸${"─".repeat(cells - filled - 1)}`);
}

const FOOTER_LABEL_WIDTH = 8;

function footerLabel(label: string, theme: CosmicFooterTheme): string {
  return theme.fg("mdLink", sanitizeTerminalLine(label).padEnd(FOOTER_LABEL_WIDTH));
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
    left = footerLabel("Ctx", theme) + theme.fg("syntaxNumber", `?/${formatTokens(contextWindow)}`);
  } else {
    const cells = compact ? 6 : 10;
    const tokens = usage?.tokens ?? Math.round((percent / 100) * contextWindow);
    const color = contextConsumptionTone(percent);
    left = [
      footerLabel("Ctx", theme),
      progressBar(percent, cells, theme, color),
      theme.fg(
        color,
        ` ${Math.round(percent)}% used · ${formatTokens(tokens)}/${formatTokens(contextWindow)}`,
      ),
    ].join("");
  }
  const right =
    width >= 48 && sessionInfo.length
      ? renderContributionLine(sessionInfo, Math.floor(width * 0.48), theme, compact)
      : "";
  return alignSides(left, right, width);
}

/** Match window labels used by provider usage status lines (OpenAI 5h/7d, xAI 7d/mo). */
const PROVIDER_USAGE_WINDOW_PATTERN = /([A-Za-z0-9]+):\s*(\d+(?:\.\d+)?)%/g;

export function renderProviderUsageLine(
  providerLabel: string,
  text: string,
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string {
  const body = sanitizeTerminalLine(text).replace(/^Usage:\s*/i, "");
  const cells = compact ? 6 : 10;
  const pieces = [footerLabel(providerLabel, theme)];
  let cursor = 0;
  let matched = false;
  for (const match of body.matchAll(PROVIDER_USAGE_WINDOW_PATTERN)) {
    matched = true;
    const index = match.index ?? 0;
    if (index > cursor) pieces.push(theme.fg("syntaxOperator", body.slice(cursor, index)));
    const percent = Number(match[2]);
    const color = remainingCapacityTone(percent);
    pieces.push(theme.fg(color, `${match[1]?.toLowerCase()} `));
    pieces.push(progressBar(percent, cells, theme, color));
    pieces.push(theme.fg(color, ` ${Math.round(percent)}% left`));
    cursor = index + match[0].length;
  }
  if (!matched) {
    return truncateToWidth(
      theme.fg("mdLink", `${providerLabel.padEnd(FOOTER_LABEL_WIDTH)}${body}`),
      width,
      "",
    );
  }
  if (cursor < body.length) pieces.push(theme.fg("syntaxOperator", body.slice(cursor)));
  return truncateToWidth(pieces.join(""), width, "");
}

const CONTRIBUTION_COLORS: ReadonlyMap<string, CosmicFooterColor> = new Map([
  ["model", "mdLink"],
  ["effort", "syntaxOperator"],
  ["location", "accent"],
  ["branch", "syntaxType"],
  ["pullRequest", "mdLink"],
  ["git", "syntaxOperator"],
  ["session", "customMessageLabel"],
  ["metrics.input", "syntaxVariable"],
  ["metrics.output", "syntaxFunction"],
  ["metrics.cacheRead", "syntaxType"],
  ["metrics.cacheWrite", "syntaxKeyword"],
  ["metrics.cost", "syntaxNumber"],
  ["extensions", "mdLink"],
]);

const TONE_COLORS = {
  normal: "text",
  accent: "accent",
  dim: "dim",
  success: "success",
  warning: "warning",
  error: "error",
} as const satisfies Record<NonNullable<CosmicFooterTextContribution["tone"]>, CosmicFooterColor>;

function contributionColor(contribution: CosmicFooterTextContribution): CosmicFooterColor {
  if (contribution.tone === "warning" || contribution.tone === "error") return contribution.tone;
  if (contribution.color) return contribution.color;
  const semanticColor = CONTRIBUTION_COLORS.get(contribution.id);
  if (semanticColor) return semanticColor;
  if (contribution.tone) return TONE_COLORS[contribution.tone];
  return "accent";
}

function tone(
  theme: CosmicFooterTheme,
  contribution: CosmicFooterTextContribution,
  text: string,
): string {
  if (contribution.id === "model") {
    const separator = " / ";
    const separatorIndex = text.indexOf(separator);
    if (separatorIndex !== -1)
      return [
        theme.fg("syntaxType", text.slice(0, separatorIndex)),
        theme.fg("syntaxPunctuation", separator),
        theme.fg("mdLink", text.slice(separatorIndex + separator.length)),
      ].join("");
  }
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
  return sanitizeTerminalLine(compact && entry.compactText ? entry.compactText : entry.text);
}

function fitContributions(
  entries: CosmicFooterTextContribution[],
  available: number,
  compact: boolean,
): CosmicFooterTextContribution[] {
  const kept = [...entries];
  while (kept.length > 1) {
    const value = rawContributionLine(kept, compact);
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

export function renderLabeledContributionLine(
  label: string,
  contributions: CosmicFooterTextContribution[],
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string {
  if (width <= 0) return "";
  if (width <= FOOTER_LABEL_WIDTH)
    return truncateToWidth(theme.fg("mdLink", sanitizeTerminalLine(label)), width, "");
  return truncateToWidth(
    `${footerLabel(label, theme)}${renderContributionLine(
      contributions,
      width - FOOTER_LABEL_WIDTH,
      theme,
      compact,
    )}`,
    width,
    "",
  );
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
