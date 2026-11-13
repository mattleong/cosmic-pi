import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import type { CosmicFooterTextContribution, CosmicFooterTheme } from "../protocol/protocol.ts";
import {
  alignSides,
  contributionText,
  ranked,
  rawContributionLine,
  styledContributionLine,
  tone,
} from "./contributions.ts";
import { INLINE_SEPARATOR } from "../manager/chrome.ts";
import { findOrUndefined } from "pi-cosmic-core/array";

/** A rendered metric and the contribution it came from; the cache pair shares `metrics.cache`. */
type MetricPart = { readonly text: string; readonly id: string };

const CACHE_IDS: readonly string[] = ["metrics.cacheRead", "metrics.cacheWrite"];

function metricCacheGroup(
  entries: readonly CosmicFooterTextContribution[],
  compact: boolean,
  theme: CosmicFooterTheme,
): string {
  const values = Arr.flatMap(CACHE_IDS, (id) => {
    const entry = findOrUndefined(entries, (candidate) => candidate.id === id);
    return entry ? [theme.fg("syntaxType", contributionText(entry, compact))] : [];
  });
  return `${theme.fg("dim", "cache")} ${Arr.join(values, " ")}`;
}

function metricParts(
  entries: readonly CosmicFooterTextContribution[],
  compact: boolean,
  theme: CosmicFooterTheme,
): MetricPart[] {
  const parts: MetricPart[] = [];
  let cacheAdded = false;
  for (const entry of ranked(entries)) {
    if (CACHE_IDS.includes(entry.id)) {
      if (!cacheAdded)
        parts.push({ text: metricCacheGroup(entries, compact, theme), id: "metrics.cache" });
      cacheAdded = true;
      continue;
    }
    parts.push({ text: tone(theme, entry, contributionText(entry, compact)), id: entry.id });
  }
  return parts;
}

function metricSeparator(
  previous: MetricPart,
  current: MetricPart,
  theme: CosmicFooterTheme,
): string {
  if (previous.id === "metrics.input" && current.id === "metrics.output") return " ";
  return theme.fg("dim", INLINE_SEPARATOR);
}

function wrapMetricParts(
  parts: readonly MetricPart[],
  width: number,
  firstWidth: number,
  theme: CosmicFooterTheme,
): string[] {
  const rows: string[] = [];
  let current = "";
  let available = firstWidth;
  let previous: MetricPart | undefined;
  for (const part of parts) {
    const separator = current && previous ? metricSeparator(previous, part, theme) : "";
    const candidate = `${current}${separator}${part.text}`;
    if (visibleWidth(candidate) <= available) {
      current = candidate;
      previous = part;
      continue;
    }
    if (current || available < width) rows.push(current);
    available = width;
    const wrapped = wrapTextWithAnsi(part.text, width);
    rows.push(...wrapped.slice(0, -1));
    current = wrapped.at(-1) ?? "";
    previous = part;
  }
  if (current) rows.push(current);
  return rows;
}

export function renderMetricsLines(
  contributions: readonly CosmicFooterTextContribution[],
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string[] {
  if (width <= 0) return [];
  const visible = Arr.filter(ranked(contributions), (entry) =>
    Boolean(contributionText(entry, compact)),
  );
  const left = metricParts(
    Arr.filter(visible, (entry) => entry.align !== "right" && entry.id !== "metrics.cost"),
    compact,
    theme,
  );
  const right = Arr.filter(
    visible,
    (entry) => entry.align === "right" || entry.id === "metrics.cost",
  );
  const rightRaw = rawContributionLine(right, compact);
  const rightRendered = styledContributionLine(right, compact, rightRaw, rightRaw, theme);
  const rightRows = rightRendered ? wrapTextWithAnsi(rightRendered, Math.max(1, width)) : [];
  const firstRight = rightRows.shift();
  const firstWidth = firstRight ? Math.max(0, width - visibleWidth(firstRight) - 2) : width;
  const rows = wrapMetricParts(left, width, firstWidth, theme);
  if (firstRight) rows[0] = alignSides(rows[0] ?? "", firstRight, width);
  rows.push(...rightRows);
  return rows;
}
