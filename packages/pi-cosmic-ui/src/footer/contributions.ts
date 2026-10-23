import { visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import type {
  CosmicFooterColor,
  CosmicFooterTextContribution,
  CosmicFooterTheme,
} from "../protocol/protocol.ts";
import { clipToWidth } from "../manager/chrome.ts";
import { webHyperlink } from "./hyperlink.ts";

export function alignSides(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (!right) return clipToWidth(left, width, "");
  const rightWidth = Math.min(visibleWidth(right), width);
  const clippedRight = clipToWidth(right, rightWidth, "");
  if (!left)
    return `${Fn.pipe(" ", Str.repeat(Math.max(0, width - visibleWidth(clippedRight))))}${clippedRight}`;

  const leftWidth = Math.max(0, width - visibleWidth(clippedRight) - 2);
  const clippedLeft = clipToWidth(left, leftWidth, "…");
  const padding = Fn.pipe(
    " ",
    Str.repeat(Math.max(1, width - visibleWidth(clippedLeft) - visibleWidth(clippedRight))),
  );
  return clipToWidth(`${clippedLeft}${padding}${clippedRight}`, width, "");
}

const CONTRIBUTION_COLORS: ReadonlyMap<string, CosmicFooterColor> = new Map([
  ["model", "accent"],
  ["pullRequest", "mdLink"],
  ["git", "syntaxOperator"],
  ["session", "customMessageLabel"],
  ["metrics.input", "syntaxVariable"],
  ["metrics.output", "thinkingHigh"],
  ["metrics.cacheRead", "syntaxType"],
  ["metrics.cacheWrite", "syntaxType"],
  ["metrics.cost", "syntaxNumber"],
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
  if (contribution.id === "effort" && Fn.pipe(text, Str.startsWith("⚡"))) {
    const effort = Fn.pipe(text, Str.slice(1));
    return `${theme.fg("warning", "⚡")}${effort ? theme.fg(contributionColor(contribution), effort) : ""}`;
  }
  if (contribution.id === "git.lines") {
    return Arr.join(
      Arr.map(Arr.filter(Str.split(text, " "), Str.isNonEmpty), (value) => {
        const color = Fn.pipe(value, Str.startsWith("+"))
          ? "success"
          : Fn.pipe(value, Str.startsWith("-"))
            ? "error"
            : "syntaxNumber";
        return theme.fg(color, value);
      }),
      theme.fg("dim", " "),
    );
  }
  return theme.fg(contributionColor(contribution), text);
}

export const DEFAULT_CONTRIBUTION_ORDER = 500;

export function ranked(
  contributions: readonly CosmicFooterTextContribution[],
): CosmicFooterTextContribution[] {
  return Arr.sort(
    contributions,
    Order.combine(
      Order.mapInput(
        Order.Number,
        (entry: CosmicFooterTextContribution) => entry.order ?? DEFAULT_CONTRIBUTION_ORDER,
      ),
      Order.mapInput(
        Order.flip(Order.Number),
        (entry: CosmicFooterTextContribution) => entry.priority ?? 50,
      ),
    ),
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
  return Arr.join(
    Arr.flatMap(entries, (entry) => {
      const text = contributionText(entry, compact);
      return text ? [text] : [];
    }),
    " • ",
  );
}

export function styledContributionLine(
  entries: readonly CosmicFooterTextContribution[],
  compact: boolean,
  clipped: string,
  raw: string,
  theme: CosmicFooterTheme,
  pullRequestUrl?: string,
): string {
  // Link only complete, fitted text so clipping cannot leave an open hyperlink.
  if (clipped !== raw) return theme.fg("text", clipped);
  return Arr.join(
    Arr.flatMap(entries, (entry) => {
      const text = contributionText(entry, compact);
      if (!text) return [];
      const styled = tone(theme, entry, text);
      return [entry.id === "pullRequest" ? webHyperlink(styled, pullRequestUrl) : styled];
    }),
    theme.fg("dim", " • "),
  );
}

export function renderContributionLine(
  contributions: CosmicFooterTextContribution[],
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
  pullRequestUrl?: string,
): string {
  if (width <= 0) return "";
  const visible = ranked(contributions);
  const left = Arr.filter(visible, (entry) => entry.align !== "right");
  const right = Arr.filter(visible, (entry) => entry.align === "right");

  const fittedRight = fitContributions(right, width, compact);
  const rightRaw = rawContributionLine(fittedRight, compact);
  const clippedRight = clipToWidth(rightRaw, width, "");
  const rightWidth = visibleWidth(clippedRight);

  const reservedGap = left.length > 0 && rightWidth > 0 ? 2 : 0;
  const leftAvailable = Math.max(0, width - rightWidth - reservedGap);
  const fittedLeft = fitContributions(left, leftAvailable, compact);
  const leftRaw = rawContributionLine(fittedLeft, compact);
  const clippedLeft = clipToWidth(leftRaw, leftAvailable, "…");
  const leftWidth = visibleWidth(clippedLeft);

  const styledLeft = styledContributionLine(
    fittedLeft,
    compact,
    clippedLeft,
    leftRaw,
    theme,
    pullRequestUrl,
  );
  const styledRight = styledContributionLine(
    fittedRight,
    compact,
    clippedRight,
    rightRaw,
    theme,
    pullRequestUrl,
  );
  if (!clippedRight) return clipToWidth(styledLeft, width, "");
  if (!clippedLeft) return clipToWidth(styledRight, width, "");

  const padding = Fn.pipe(" ", Str.repeat(Math.max(1, width - leftWidth - rightWidth)));
  return clipToWidth(`${styledLeft}${padding}${styledRight}`, width, "");
}
