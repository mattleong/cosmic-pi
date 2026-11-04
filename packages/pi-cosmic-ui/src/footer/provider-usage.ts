import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import type { CosmicFooterTheme } from "../protocol/protocol.ts";
import { alignSides } from "./contributions.ts";
import { progressBar, remainingCapacityTone } from "./meter.ts";
import { clipToWidth } from "../manager/chrome.ts";

const WINDOW_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_-]*):\s*(?:(\d+(?:\.\d+)?)%|--)$/u;
const RESET_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_-]*)\s+↺(?:\s+(.*))?$/u;

/** One way to show a reset: a muted label followed by the time it names. */
interface ResetVariant {
  readonly label: string;
  readonly value: string;
}

interface WindowEntry {
  kind: "window";
  label: string;
  percent: number | null;
  raw: string;
  resets?: ReadonlyArray<ResetVariant>;
}
type ProviderEntry = WindowEntry | { kind: "text"; text: string };

/**
 * Producers send `<window> ↺ <countdown> - <local time>`. The footer always labels the reset so
 * it cannot read as a clock: `resets 10:59 PM`, then `↺ 10:59 PM`, then `↺ 2h 3m` when narrow.
 */
function resetVariants(segment: string, body: string | undefined): ReadonlyArray<ResetVariant> {
  const reset = body === undefined ? "" : Str.trim(body);
  if (!reset) return [{ label: "", value: segment }];
  const [countdown, absolute] = Option.match(Fn.pipe(reset, Str.indexOf(" - ")), {
    onNone: () => ["", reset] as const,
    onSome: (at) =>
      [
        Str.trim(Fn.pipe(reset, Str.slice(0, at))),
        Str.trim(Fn.pipe(reset, Str.slice(at + 3))),
      ] as const,
  });
  return [
    { label: "resets ", value: absolute || countdown },
    { label: "↺ ", value: absolute || countdown },
    ...(countdown && absolute ? [{ label: "↺ ", value: countdown }] : []),
  ];
}

const resetText = (variant: ResetVariant, theme: CosmicFooterTheme): string =>
  `${variant.label ? theme.fg("dim", variant.label) : ""}${theme.fg("mdLink", variant.value)}`;

function providerEntries(body: string): ProviderEntry[] {
  const entries: ProviderEntry[] = [];
  const byLabel = new Map<string, WindowEntry>();
  const windowFor = (label: string): WindowEntry => {
    const key = Str.toLowerCase(label);
    const existing = byLabel.get(key);
    if (existing) return existing;
    const entry: WindowEntry = { kind: "window", label, percent: null, raw: "" };
    byLabel.set(key, entry);
    entries.push(entry);
    return entry;
  };
  for (const segment of Arr.filter(Str.split(body, /\s*\|\s*/u), Str.isNonEmpty)) {
    const window = WINDOW_PATTERN.exec(segment);
    if (window) {
      const entry = windowFor(window[1] ?? segment);
      entry.raw = segment;
      entry.percent = window[2] === undefined ? null : Number(window[2]);
      continue;
    }
    const reset = RESET_PATTERN.exec(segment);
    if (reset) windowFor(reset[1] ?? segment).resets = resetVariants(segment, reset[2]);
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
  const label = Str.toLowerCase(entry.label);
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
  reset: ResetVariant | undefined,
): string | undefined {
  const fullLeft = `${prefix}${entryText(entry, theme, compact, withMeter)}`;
  const right = reset ? resetText(reset, theme) : undefined;
  if (visibleWidth(fullLeft) + (right ? visibleWidth(right) + 2 : 0) > width) return undefined;
  return right ? alignSides(fullLeft, right, width) : clipToWidth(fullLeft, width, "");
}

function fittedEntry(
  entry: ProviderEntry,
  prefix: string,
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string | undefined {
  const resets: ReadonlyArray<ResetVariant | undefined> =
    entry.kind === "window" && entry.resets ? entry.resets : [undefined];
  for (const withMeter of [true, false])
    for (const reset of resets) {
      const line = simpleEntry(entry, prefix, width, theme, compact, withMeter, reset);
      if (line) return line;
    }
  return undefined;
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
  const lines = Arr.map(wrappedLeft, (part, index) =>
    clipToWidth(`${index === 0 ? prefix : continuation}${part}`, width, ""),
  );
  const shortest = entry.kind === "window" ? entry.resets?.at(-1) : undefined;
  if (shortest) {
    const resetWidth = Math.max(1, width - visibleWidth(continuation));
    for (const part of wrapTextWithAnsi(resetText(shortest, theme), resetWidth))
      lines.push(alignSides(continuation, part, width));
  }
  return lines;
}

export function renderProviderUsageLines(
  providerName: string,
  text: string,
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string[] {
  if (width <= 0) return [];
  const body = Fn.pipe(sanitizeTerminalLine(text), Str.replace(/^Usage:\s*/iu, ""));
  const entries = providerEntries(body);
  if (entries.length === 0) return [];

  const provider = sanitizeTerminalLine(providerName);
  const fullPrefix = theme.fg("mdLink", `${provider} `);
  const prefixWidth = Math.min(visibleWidth(fullPrefix), Math.max(0, width - 1));
  const firstPrefix = clipToWidth(fullPrefix, prefixWidth, "");
  const continuation = Fn.pipe(" ", Str.repeat(prefixWidth));
  return Arr.flatMap(entries, (entry, index) => {
    const prefix = index === 0 ? firstPrefix : continuation;
    const simple = fittedEntry(entry, prefix, width, theme, compact);
    return simple ? [simple] : wrappedEntry(entry, prefix, continuation, width, theme, compact);
  });
}
