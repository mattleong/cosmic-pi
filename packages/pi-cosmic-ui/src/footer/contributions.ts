import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import type {
  CosmicFooterColor,
  CosmicFooterTextContribution,
  CosmicFooterTheme,
} from "../protocol/protocol.ts";

export const FOOTER_LABEL_WIDTH = 8;

export function footerLabel(label: string, theme: CosmicFooterTheme): string {
  return theme.fg("mdLink", sanitizeTerminalLine(label).padEnd(FOOTER_LABEL_WIDTH));
}

export function alignSides(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (!right) return truncateToWidth(left, width, "");
  const rightWidth = Math.min(visibleWidth(right), width);
  const clippedRight = truncateToWidth(right, rightWidth, "");
  if (!left) return `${" ".repeat(Math.max(0, width - visibleWidth(clippedRight)))}${clippedRight}`;

  const leftWidth = Math.max(0, width - visibleWidth(clippedRight) - 2);
  const clippedLeft = truncateToWidth(left, leftWidth, "…");
  const padding = " ".repeat(
    Math.max(1, width - visibleWidth(clippedLeft) - visibleWidth(clippedRight)),
  );
  return truncateToWidth(`${clippedLeft}${padding}${clippedRight}`, width, "");
}

const CONTRIBUTION_COLORS: ReadonlyMap<string, CosmicFooterColor> = new Map([
  ["model", "accent"],
  ["effort", "thinkingText"],
  ["location", "accent"],
  ["branch", "syntaxType"],
  ["pullRequest", "mdLink"],
  ["git", "syntaxOperator"],
  ["session", "customMessageLabel"],
  ["metrics.input", "syntaxVariable"],
  ["metrics.output", "thinkingHigh"],
  ["metrics.cacheRead", "syntaxType"],
  ["metrics.cacheWrite", "syntaxType"],
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

export function tone(
  theme: CosmicFooterTheme,
  contribution: CosmicFooterTextContribution,
  text: string,
): string {
  if (contribution.id === "effort" && text.startsWith("⚡")) {
    const effort = text.slice(1);
    return `${theme.fg("warning", "⚡")}${effort ? theme.fg(contributionColor(contribution), effort) : ""}`;
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
      .join(theme.fg("dim", " "));
  }
  return theme.fg(contributionColor(contribution), text);
}

export function ranked(
  contributions: readonly CosmicFooterTextContribution[],
): CosmicFooterTextContribution[] {
  return [...contributions].sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100) || (b.priority ?? 50) - (a.priority ?? 50),
  );
}

export function contributionText(entry: CosmicFooterTextContribution, compact: boolean): string {
  return sanitizeTerminalLine(
    compact && entry.compactText !== undefined ? entry.compactText : entry.text,
  );
}

export function fitContributions(
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

export function rawContributionLine(
  entries: readonly CosmicFooterTextContribution[],
  compact: boolean,
): string {
  return entries
    .map((entry) => contributionText(entry, compact))
    .filter(Boolean)
    .join(" • ");
}

export function styledContributionLine(
  entries: readonly CosmicFooterTextContribution[],
  compact: boolean,
  clipped: string,
  raw: string,
  theme: CosmicFooterTheme,
): string {
  if (clipped !== raw) return theme.fg("text", clipped);
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

  const rightBudget = width;
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
