import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { codeUnitAt, indexOfFrom, lastIndexOfFrom } from "pi-cosmic-core/text-scan";
import { utf8ByteLength, utf8Prefix, utf8Suffix } from "pi-cosmic-core/text";
import { BACKGROUND_LOG_BOUNDS as LOG_BOUNDS } from "../task/bounds.ts";
import type { BackgroundLogEvent, BackgroundLogSlice, BackgroundLogStream } from "../task/model.ts";
import { plainTerminalText } from "../task/terminal-text.ts";

const STDERR_LABEL = "[stderr] ";
const NEWLINE = 0x0a;

// Bound once: Pi's loader routes each call through an imported binding via an interop proxy,
// which dominates the per-line scans below.
const indexAt = indexOfFrom;
const lastIndexAt = lastIndexOfFrom;

interface LineState {
  stream: BackgroundLogStream | undefined;
  lineStart: boolean;
}

const newlineCount = (text: string): number => {
  let count = 0;
  for (let index = indexAt(text, "\n", 0); index >= 0; index = indexAt(text, "\n", index + 1))
    count += 1;
  return count;
};

const renderEvent = (event: BackgroundLogEvent, state: LineState): string => {
  const text = plainTerminalText(event.text);
  if (!text) return "";
  // A stream switch mid-line starts a new line, so the streams never share one.
  const separator = state.stream !== undefined && state.stream !== event.stream && !state.lineStart;
  state.stream = event.stream;
  if (separator) state.lineStart = true;
  const prefix = separator ? "\n" : "";
  if (event.stream === "stdout") {
    state.lineStart = Fn.pipe(text, Str.endsWith("\n"));
    return `${prefix}${text}`;
  }
  let rendered = prefix;
  for (let start = 0; start < text.length; ) {
    const newline = indexAt(text, "\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    if (state.lineStart) rendered += STDERR_LABEL;
    rendered += Fn.pipe(text, Str.slice(start, end));
    state.lineStart = newline >= 0;
    start = end;
  }
  return rendered;
};

/**
 * The text readers see for a run of events: plain output in order, every stderr line labeled
 * `[stderr] `, and a line break where the stream switches mid-line.
 */
export const combinedLogOutput = (events: ReadonlyArray<BackgroundLogEvent>): string => {
  const state: LineState = { stream: undefined, lineStart: true };
  return Arr.join(
    Arr.map(events, (event) => renderEvent(event, state)),
    "",
  );
};

// What one event can add to combined output, whatever precedes it.
const renderedCost = (event: BackgroundLogEvent) => {
  const text = plainTerminalText(event.text);
  if (!text) return { bytes: 0, lines: 0 };
  const breaks = newlineCount(text);
  const labels = event.stream === "stderr" ? (breaks + 1) * STDERR_LABEL.length : 0;
  return { bytes: utf8ByteLength(text) + labels + 1, lines: breaks + 1 };
};

const firstLines = (text: string, lines: number): string => {
  let end = -1;
  for (let count = 0; count < lines; count += 1) {
    end = indexAt(text, "\n", end + 1);
    if (end < 0) return text;
  }
  return Fn.pipe(text, Str.slice(0, end + 1));
};

const lastLines = (text: string, lines: number): string => {
  let start = Fn.pipe(text, Str.endsWith("\n")) ? text.length - 1 : text.length;
  for (let count = 0; count < lines; count += 1) {
    // A search from before the start would find a leading line break again.
    if (start <= 0) return text;
    start = lastIndexAt(text, "\n", start - 1);
    if (start < 0) return text;
  }
  return Fn.pipe(text, Str.slice(start + 1));
};

/**
 * The end of `text` within `maxBytes`, starting at a line start unless the last line alone is too
 * large, when its end is kept instead.
 */
const lineAlignedSuffix = (text: string, maxBytes: number): string => {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const suffix = utf8Suffix(text, maxBytes);
  const cut = text.length - suffix.length;
  if (cut === 0 || codeUnitAt(text, cut - 1) === NEWLINE) return suffix;
  const newline = indexAt(suffix, "\n", 0);
  return newline < 0 || newline === suffix.length - 1
    ? suffix
    : Fn.pipe(suffix, Str.slice(newline + 1));
};

export interface LogPageBudget {
  readonly maxBytes: number;
  readonly maxLines: number;
}

export interface LogPage {
  readonly output: string;
  /** The afterCursor that continues after this output. */
  readonly nextCursor: number;
  /** Stored bytes of the events this page includes. */
  readonly includedBytes: number;
  /** Events in the slice were left out to fit; paging with cursors recovers them. */
  readonly clipped: boolean;
  /** Stored bytes of slice events after this page, for reads that page forward. */
  readonly laterBytes: number;
  /** A single event larger than the whole budget; this part of it cannot be shown. */
  readonly cut?: { readonly cursor: number; readonly bytes: number };
}

const fits = (text: string, budget: LogPageBudget) =>
  utf8ByteLength(text) <= budget.maxBytes && newlineCount(text) < budget.maxLines;

/**
 * Selects whole events that fit `budget`. Forward reads keep the oldest events and continue at
 * the last one included; tail reads keep the newest. Only an event that alone exceeds the budget
 * is shortened, and the page reports what was cut.
 */
export function pageLogSlice(
  slice: BackgroundLogSlice,
  direction: "forward" | "tail",
  budget: LogPageBudget,
): LogPage {
  const ordered = direction === "forward" ? slice.events : Arr.reverse(slice.events);
  let bytes = 0;
  let lines = 1;
  let count = 0;
  for (const event of ordered) {
    const cost = renderedCost(event);
    if (count > 0 && (bytes + cost.bytes > budget.maxBytes || lines + cost.lines > budget.maxLines))
      break;
    bytes += cost.bytes;
    lines += cost.lines;
    count += 1;
  }
  const included =
    direction === "forward"
      ? slice.events.slice(0, count)
      : slice.events.slice(slice.events.length - count);
  const last = included.at(-1);
  const clipped = count < slice.events.length;
  const whole = combinedLogOutput(included);
  const single = included.length === 1 ? included[0] : undefined;
  const output =
    single && !fits(whole, budget)
      ? direction === "forward"
        ? utf8Prefix(firstLines(whole, Math.max(0, budget.maxLines - 1)), budget.maxBytes)
        : utf8Suffix(lastLines(whole, Math.max(0, budget.maxLines - 1)), budget.maxBytes)
      : whole;
  return {
    output,
    nextCursor: direction === "forward" && clipped && last ? last.cursor : slice.nextCursor,
    includedBytes: Arr.reduce(included, 0, (sum, event) => sum + event.bytes),
    clipped,
    laterBytes:
      direction === "forward"
        ? Arr.reduce(slice.events.slice(count), 0, (sum, event) => sum + event.bytes)
        : 0,
    ...(single &&
      output !== whole && {
        cut: { cursor: single.cursor, bytes: utf8ByteLength(whole) - utf8ByteLength(output) },
      }),
  };
}

/**
 * The newest output of a tail slice as readers see it, within the lines and bytes a wait result or
 * an exit notice repeats. Unlike a page, it keeps whole lines rather than whole events, so one large
 * event never crowds out the lines around it.
 */
export const recentOutput = (slice: BackgroundLogSlice): string =>
  lineAlignedSuffix(
    lastLines(combinedLogOutput(slice.events), LOG_BOUNDS.recentOutputLines),
    LOG_BOUNDS.recentOutputBytes,
  );

/** Retained output a page leaves out, and the afterCursor that reads it. */
export interface LogPageOmission {
  readonly omitted: "earlier" | "later";
  readonly omittedBytes: number;
  readonly resumeAfterCursor: number;
  /** Part of one event too large for the whole page; no cursor reads it. */
  readonly cutBytes?: number;
}

/**
 * The retained output a page leaves out. A forward page leaves out later events that did not
 * fit; a tail page leaves out all retained output before it, whether its line limit or its size
 * bound excluded that output. Text and structured results report it the same way.
 */
export function pageOmission(
  slice: BackgroundLogSlice,
  direction: "forward" | "tail",
  page: LogPage,
): LogPageOmission | undefined {
  const cut = page.cut && { cutBytes: page.cut.bytes };
  if (direction === "forward")
    return page.clipped || cut
      ? {
          omitted: "later",
          omittedBytes: page.laterBytes,
          resumeAfterCursor: page.nextCursor,
          ...cut,
        }
      : undefined;
  const earlier = Math.max(0, slice.retainedBytes - page.includedBytes);
  return earlier > 0 || cut
    ? {
        omitted: "earlier",
        omittedBytes: earlier,
        resumeAfterCursor: slice.earliestAvailableCursor,
        ...cut,
      }
    : undefined;
}
