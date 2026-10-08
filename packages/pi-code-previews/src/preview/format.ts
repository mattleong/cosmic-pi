import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { forEachPreviewTextLine } from "./line-counts";
import { countLabel } from "pi-cosmic-core";

export type PreviewLineEntry<T> =
  | { kind: "line"; line: T; index: number }
  | { kind: "hidden"; hidden: number };

const PREVIEW_SPLIT_MIN_LIMIT = 8;

/** From eight lines, about two thirds of the limit is head and the rest, less the marker, tail. */
function previewSplit(limit: number) {
  if (limit < PREVIEW_SPLIT_MIN_LIMIT) return undefined;
  const head = Math.ceil(limit * 0.65);
  return { head, tail: Math.max(1, limit - head - 1) };
}

/** Shown head and tail counts; a limit too small to split keeps only its head. */
function previewWindow(total: number, limit: number) {
  if (total <= limit || limit <= 0) return { head: total, tail: 0, hidden: 0 };
  const { head, tail } = previewSplit(limit) ?? { head: limit, tail: 0 };
  return { head, tail, hidden: total - head - tail };
}

const lineEntry = <T>(line: T, index: number): PreviewLineEntry<T> => ({
  kind: "line",
  line,
  index,
});

/** The first lines, then the hidden marker and the last lines when the window splits. */
function windowEntries<T>(first: readonly T[], last: readonly T[], hidden: number, total: number) {
  const entries = first.map((line, index) => lineEntry(line, index));
  if (last.length === 0) return entries;
  const start = total - last.length;
  return entries.concat(
    { kind: "hidden", hidden },
    last.map((line, offset) => lineEntry(line, start + offset)),
  );
}

export function selectPreviewLines<T>(lines: readonly T[], limit: number) {
  const total = lines.length;
  const { head, tail, hidden } = previewWindow(total, limit);
  const entries = windowEntries(lines.slice(0, head), lines.slice(total - tail), hidden, total);
  return { entries, shown: head + tail, hidden };
}

/** Streams the text, retaining at most the limit's head plus a ring of the latest tail lines. */
export function selectPreviewTextLines(text: string, limit: number) {
  const split = previewSplit(limit);
  const first: string[] = [];
  const ring: string[] = [];
  let total = 0;
  forEachPreviewTextLine(text, (line, index) => {
    total++;
    if (limit <= 0 || index < limit) first.push(line);
    if (split && index >= split.head) ring[(index - split.head) % split.tail] = line;
  });
  const { head, tail, hidden } = previewWindow(total, limit);
  // A split window hides at least one line, so its full ring holds the last `tail` lines, the
  // oldest where the next line would go.
  const oldest = tail && (total - head) % tail;
  const last = tail ? ring.slice(oldest).concat(ring.slice(0, oldest)) : [];
  const entries = windowEntries(first.slice(0, head), last, hidden, total);
  return { entries, shown: head + tail, hidden, total };
}

export function hiddenLinesMarker(theme: Theme, hidden: number): string {
  return theme.fg("muted", `      --- ${countLabel(hidden, "line")} hidden ---`);
}

export function trimSingleTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

export function metadata(theme: Theme, parts: Array<string | undefined>): string {
  const present = parts.filter((part): part is string => Boolean(part));
  return present.length ? theme.fg("dim", ` · ${present.join(" · ")}`) : "";
}

/** A clipped preview's count, with the configured expansion hint. */
export function showingFooter(theme: Theme, shown: number, total: number, label: string): string {
  return `\n${renderExpansionAffordance(`Showing ${shown} of ${total} ${label}`, false, theme)}`;
}

export function previewFooter(theme: Theme, text: string): string {
  return `\n${theme.fg("muted", `╰─ ${text}`)}`;
}
