import { visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "pi-cosmic-core";
import type { CosmicFooterTextContribution, CosmicFooterTheme } from "../protocol/protocol.ts";
import {
  alignSides,
  ranked,
  rawContributionLine,
  renderContributionLine,
} from "./contributions.ts";
import { contextConsumptionTone, progressBar } from "./meter.ts";
import { clipToWidth } from "../manager/chrome.ts";

function contextUsageCandidates(
  usage: { contextWindow?: number; tokens?: number | null; percent?: number | null } | undefined,
  theme: CosmicFooterTheme,
  compact: boolean,
): string[] {
  const contextWindow = usage?.contextWindow ?? 0;
  const percent = usage?.percent;
  const label = theme.fg("accent", "▤");
  if (percent === null || percent === undefined)
    return [`${label} ${theme.fg("text", `?/${formatTokens(contextWindow)}`)}`];

  const cells = compact ? 6 : 10;
  const tokens = usage?.tokens ?? Math.round((percent / 100) * contextWindow);
  const color = contextConsumptionTone(percent);
  const meter = progressBar(percent, cells, theme, color);
  const percentage = theme.fg(color, `${Math.round(percent)}%`);
  const counts = theme.fg("syntaxNumber", `${formatTokens(tokens)}/${formatTokens(contextWindow)}`);
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
    clipToWidth(candidates.at(-1) ?? "", width, "");
  const contextWidth = visibleWidth(context);
  const leftBudget = Math.max(0, width - contextWidth - (leftRaw ? 2 : 0));
  const left = modelIdentity.length
    ? renderContributionLine(modelIdentity, leftBudget, theme, compact)
    : "";
  return alignSides(left, context, width);
}
