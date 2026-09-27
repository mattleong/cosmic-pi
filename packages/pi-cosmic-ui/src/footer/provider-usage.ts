import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import type { CosmicFooterTheme } from "../protocol/protocol.ts";
import { alignSides } from "./contributions.ts";
import { progressBar, remainingCapacityTone } from "./meter.ts";
import { clipToWidth } from "../manager/chrome.ts";

const WINDOW_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_-]*):\s*(?:(\d+(?:\.\d+)?)%|--)$/u;
const RESET_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_-]*)\s+↺(?:\s+(.*))?$/u;

interface WindowEntry {
  kind: "window";
  label: string;
  percent: number | null;
  raw: string;
  resetText?: string;
}
type ProviderEntry = WindowEntry | { kind: "text"; text: string };

function resetDisplay(segment: string, body: string | undefined): string {
  const reset = body?.trim();
  if (!reset) return segment;
  return reset.replace(/^[^-]+-\s+(.+)$/u, "$1").trim();
}

function providerEntries(body: string): ProviderEntry[] {
  const entries: ProviderEntry[] = [];
  const byLabel = new Map<string, WindowEntry>();
  // Windows and resets merge by case-insensitive label, keeping the first-seen label and order.
  const windowFor = (label: string): WindowEntry => {
    const key = label.toLowerCase();
    const existing = byLabel.get(key);
    if (existing) return existing;
    const entry: WindowEntry = { kind: "window", label, percent: null, raw: "" };
    byLabel.set(key, entry);
    entries.push(entry);
    return entry;
  };
  for (const segment of body.split(/\s*\|\s*/u).filter(Boolean)) {
    const window = WINDOW_PATTERN.exec(segment);
    if (window) {
      const entry = windowFor(window[1] ?? segment);
      entry.raw = segment;
      entry.percent = window[2] === undefined ? null : Number(window[2]);
      continue;
    }
    const reset = RESET_PATTERN.exec(segment);
    if (reset) windowFor(reset[1] ?? segment).resetText = resetDisplay(segment, reset[2]);
    else entries.push({ kind: "text", text: segment });
  }
  return entries;
}

function entryText(
  entry: ProviderEntry,
  theme: CosmicFooterTheme,
  compact: boolean,
  withMeter: boolean,
): string {
  if (entry.kind === "text") return theme.fg("text", entry.text);
  if (entry.percent === null) return theme.fg("text", entry.raw || entry.label);
  const label = entry.label.toLowerCase();
  const color = remainingCapacityTone(entry.percent);
  const meter = withMeter ? `${progressBar(entry.percent, compact ? 6 : 10, theme, color)} ` : "";
  return `${theme.fg(color, label)} ${meter}${theme.fg(color, `${Math.round(entry.percent)}% left`)}`;
}

function simpleEntry(
  entry: ProviderEntry,
  prefix: string,
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
  withMeter: boolean,
): string | undefined {
  const fullLeft = `${prefix}${entryText(entry, theme, compact, withMeter)}`;
  const right = entry.kind === "window" ? entry.resetText : undefined;
  if (right && visibleWidth(fullLeft) + visibleWidth(right) + 2 > width) return undefined;
  if (!right && visibleWidth(fullLeft) > width) return undefined;
  return right
    ? alignSides(fullLeft, theme.fg("mdLink", right), width)
    : clipToWidth(fullLeft, width, "");
}

function wrappedEntry(
  entry: ProviderEntry,
  prefix: string,
  continuation: string,
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string[] {
  const available = Math.max(1, width - visibleWidth(prefix));
  const wrappedLeft = wrapTextWithAnsi(entryText(entry, theme, compact, false), available);
  const lines = wrappedLeft.map((part, index) =>
    clipToWidth(`${index === 0 ? prefix : continuation}${part}`, width, ""),
  );
  const right = entry.kind === "window" ? entry.resetText : undefined;
  if (right) {
    const resetWidth = Math.max(1, width - visibleWidth(continuation));
    for (const part of wrapTextWithAnsi(theme.fg("mdLink", right), resetWidth))
      lines.push(alignSides(continuation, part, width));
  }
  return lines;
}

/** Render provider windows as paired, independently wrapped rows. */
export function renderProviderUsageLines(
  providerName: string,
  text: string,
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string[] {
  if (width <= 0) return [];
  const body = sanitizeTerminalLine(text).replace(/^Usage:\s*/iu, "");
  const entries = providerEntries(body);
  if (entries.length === 0) return [];

  const provider = sanitizeTerminalLine(providerName);
  const fullPrefix = theme.fg("mdLink", `${provider} `);
  const prefixWidth = Math.min(visibleWidth(fullPrefix), Math.max(0, width - 1));
  const firstPrefix = clipToWidth(fullPrefix, prefixWidth, "");
  const continuation = " ".repeat(prefixWidth);
  const lines: string[] = [];
  let first = true;
  for (const entry of entries) {
    const prefix = first ? firstPrefix : continuation;
    const full = simpleEntry(entry, prefix, width, theme, compact, true);
    const noMeter = full ?? simpleEntry(entry, prefix, width, theme, compact, false);
    lines.push(
      ...(noMeter ? [noMeter] : wrappedEntry(entry, prefix, continuation, width, theme, compact)),
    );
    first = false;
  }
  return lines;
}
