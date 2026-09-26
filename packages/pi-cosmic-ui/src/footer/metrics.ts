import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CosmicFooterTextContribution, CosmicFooterTheme } from "../protocol/protocol.ts";
import {
  alignSides,
  contributionText,
  ranked,
  rawContributionLine,
  styledContributionLine,
  tone,
} from "./contributions.ts";

type MetricPartKind = "input" | "output" | "cache" | "other";
type MetricPart = { readonly text: string; readonly kind: MetricPartKind };

const CACHE_IDS: readonly string[] = ["metrics.cacheRead", "metrics.cacheWrite"];

/** Groups cache read before write; the caller has already dropped entries with empty text. */
function metricCacheGroup(
  entries: readonly CosmicFooterTextContribution[],
  compact: boolean,
  theme: CosmicFooterTheme,
): string {
  const values = CACHE_IDS.flatMap((id) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) return [];
    const text = contributionText(entry, compact).replace(/^[RW](?=\S)/u, (label) =>
      label.toLowerCase(),
    );
    return [theme.fg("syntaxType", text)];
  });
  return `${theme.fg("syntaxType", "⇄")} ${values.join(theme.fg("dim", " / "))}`;
}

/** Expects the non-empty, left-aligned, non-cost entries that renderMetricsLines passes. */
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
        parts.push({ text: metricCacheGroup(entries, compact, theme), kind: "cache" });
      cacheAdded = true;
      continue;
    }
    parts.push({
      text: tone(theme, entry, contributionText(entry, compact)),
      kind:
        entry.id === "metrics.input" ? "input" : entry.id === "metrics.output" ? "output" : "other",
    });
  }
  return parts;
}

function metricSeparator(
  previous: MetricPart,
  current: MetricPart,
  theme: CosmicFooterTheme,
): string {
  if (previous.kind === "input" && current.kind === "output") return " ";
  if (previous.kind === "cache" || current.kind === "cache") return theme.fg("dim", " · ");
  return theme.fg("dim", " • ");
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
    // An empty first row can be reserved for cost. Move a complete counter to the next
    // full-width row rather than clipping it against that reservation.
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

/** Render metric contributions without dropping counters when the footer becomes narrow. */
export function renderMetricsLines(
  contributions: readonly CosmicFooterTextContribution[],
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string[] {
  if (width <= 0) return [];
  const visible = ranked(contributions).filter((entry) =>
    Boolean(contributionText(entry, compact)),
  );
  const left = metricParts(
    visible.filter((entry) => entry.align !== "right" && entry.id !== "metrics.cost"),
    compact,
    theme,
  );
  const right = visible.filter((entry) => entry.align === "right" || entry.id === "metrics.cost");
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
