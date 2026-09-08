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

function lowercaseCacheLabel(text: string): string {
  return text.replace(/^[RW](?=\S)/u, (label) => label.toLowerCase());
}

function cacheText(
  entry: CosmicFooterTextContribution | undefined,
  compact: boolean,
): string | undefined {
  if (!entry) return undefined;
  const text = contributionText(entry, compact);
  return text ? lowercaseCacheLabel(text) : undefined;
}

function metricCacheGroup(
  cacheRead: CosmicFooterTextContribution | undefined,
  cacheWrite: CosmicFooterTextContribution | undefined,
  compact: boolean,
  theme: CosmicFooterTheme,
): string {
  const values: string[] = [];
  const read = cacheText(cacheRead, compact);
  const write = cacheText(cacheWrite, compact);
  if (read) values.push(theme.fg("syntaxType", read));
  if (write) values.push(theme.fg("syntaxType", write));
  if (values.length === 0) return "";
  return `${theme.fg("syntaxType", "⇄")} ${values.join(theme.fg("dim", " / "))}`;
}

function metricParts(
  entries: readonly CosmicFooterTextContribution[],
  compact: boolean,
  theme: CosmicFooterTheme,
): MetricPart[] {
  const parts: MetricPart[] = [];
  let cacheAdded = false;
  const cacheRead = entries.find((entry) => entry.id === "metrics.cacheRead");
  const cacheWrite = entries.find((entry) => entry.id === "metrics.cacheWrite");
  for (const entry of ranked(entries)) {
    if (entry.id === "metrics.cost" || entry.align === "right") continue;
    if (entry.id === "metrics.cacheRead" || entry.id === "metrics.cacheWrite") {
      if (!cacheAdded) {
        const cache = metricCacheGroup(cacheRead, cacheWrite, compact, theme);
        if (cache) parts.push({ text: cache, kind: "cache" });
        cacheAdded = true;
      }
      continue;
    }
    const text = contributionText(entry, compact);
    if (!text) continue;
    parts.push({
      text: tone(theme, entry, text),
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
