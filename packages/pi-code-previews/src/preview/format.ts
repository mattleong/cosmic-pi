import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { forEachPreviewTextLine } from "./line-counts";
import { countLabel } from "pi-cosmic-core";

export type PreviewLineEntry<T> =
  | { kind: "line"; line: T; index: number }
  | { kind: "hidden"; hidden: number };

const PREVIEW_SPLIT_MIN_LIMIT = 8;

function previewSplit(limit: number) {
  if (limit < PREVIEW_SPLIT_MIN_LIMIT) return undefined;
  const head = Math.ceil(limit * 0.65);
  return { head, tail: Math.max(1, limit - head - 1) };
}

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

function windowEntries<T>(first: readonly T[], last: readonly T[], hidden: number, total: number) {
  const entries = Arr.map(first, (line, index) => lineEntry(line, index));
  if (last.length === 0) return entries;
  const start = total - last.length;
  return entries.concat(
    { kind: "hidden", hidden },
    Arr.map(last, (line, offset) => lineEntry(line, start + offset)),
  );
}

export function selectPreviewLines<T>(lines: readonly T[], limit: number) {
  const total = lines.length;
  const { head, tail, hidden } = previewWindow(total, limit);
  const entries = windowEntries(lines.slice(0, head), lines.slice(total - tail), hidden, total);
  return { entries, shown: head + tail, hidden };
}

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
  const oldest = tail && (total - head) % tail;
  const last = tail ? ring.slice(oldest).concat(ring.slice(0, oldest)) : [];
  const entries = windowEntries(first.slice(0, head), last, hidden, total);
  return { entries, shown: head + tail, hidden, total };
}

export function hiddenLinesMarker(theme: Theme, hidden: number): string {
  return theme.fg("muted", `      --- ${countLabel(hidden, "line")} hidden ---`);
}

export function trimSingleTrailingNewline(text: string): string {
  if (Fn.pipe(text, Str.endsWith("\r\n"))) return Fn.pipe(text, Str.slice(0, -2));
  if (Fn.pipe(text, Str.endsWith("\n"))) return Fn.pipe(text, Str.slice(0, -1));
  return text;
}

export function metadata(theme: Theme, parts: Array<string | undefined>): string {
  const present = Arr.filter(
    parts,
    (part): part is string => Predicate.isString(part) && Str.isNonEmpty(part),
  );
  return present.length ? theme.fg("dim", ` · ${Arr.join(present, " · ")}`) : "";
}

export function showingFooter(theme: Theme, shown: number, total: number, label: string): string {
  return `\n${renderExpansionAffordance(`Showing ${shown} of ${total} ${label}`, false, theme)}`;
}

export function previewFooter(theme: Theme, text: string): string {
  return `\n${theme.fg("muted", `╰─ ${text}`)}`;
}
