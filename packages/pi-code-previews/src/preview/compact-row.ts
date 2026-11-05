import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerNoticeColor,
  managerNoticeGlyph,
  SUITE_STATUS_GLYPHS,
  type ManagerActivityKind,
} from "pi-cosmic-ui/manager";
import { escapeControlChars } from "../shared/terminal-text";
import {
  compactStatus,
  type CompactPhase,
  type CompactStatus,
  type CompactSummary,
} from "../tools/compact-summary";
import { elideSubject, layoutCompactHeader } from "./compact-header";
import { wrapPreviewHeading } from "./heading-wrap";
import { TIMING_VISIBLE_MS } from "./tool-timing";

export function compactSingleLine(value: string): string {
  return Fn.pipe(value, escapeControlChars, Str.replace(/\s+/gu, " "), Str.trim);
}

export type CompactRowInput = {
  name: string;
  phase: CompactPhase;
  summary: CompactSummary;
  status?: CompactStatus;
  returnedCheckmark?: true | undefined;
  issueLabel?: string | undefined;
  duration?: string | undefined;
  elapsedMs?: number | undefined;
  timingEnabled?: boolean;
  animationFrame?: number | undefined;
  expanded?: boolean;
  /**
   * The width of the collapsed row this expanded heading replaces. The heading keeps the counter
   * alternative that row shows there, though its frame leaves it fewer columns.
   */
  collapsedWidth?: number | undefined;
};

// Which way a delivered message went; failures and attention keep their own icons.
const MESSAGE_GLYPHS = { sent: "→", received: "←" } as const;
// An outcome that couldn't be confirmed; `?` belongs to questions awaiting a reply.
const UNCERTAIN_GLYPH = "≈";

const ACTIVITY_KINDS = {
  pending: "pending",
  running: "running",
  success: "done",
  error: "failed",
  cancelled: "stopped",
} as const satisfies Record<string, ManagerActivityKind>;

/** What an open call waits on, which replaces its spinner: a reply wins over a queue. */
export const compactHold = (
  summary: Pick<CompactSummary, "waiting" | "queued"> | undefined,
): "waiting" | "queued" | undefined =>
  summary?.waiting ? "waiting" : summary?.queued ? "queued" : undefined;

export function compactStatusIcon(
  status: CompactStatus,
  theme: Theme,
  animationFrame = 0,
  returnedCheckmark = false,
  messageIcon?: CompactSummary["messageIcon"],
  hold?: "waiting" | "queued",
): string {
  if (hold && (status === "pending" || status === "running"))
    return hold === "waiting"
      ? theme.fg(managerActivityColor("waiting"), managerActivityGlyph("waiting"))
      : theme.fg("muted", SUITE_STATUS_GLYPHS.queued);
  if (messageIcon && (status === "success" || status === "returned"))
    return theme.fg(status === "success" ? "success" : "muted", MESSAGE_GLYPHS[messageIcon]);
  if (status === "returned")
    return theme.fg("muted", returnedCheckmark ? managerActivityGlyph("done") : "•");
  if (status === "uncertain") return theme.fg("warning", UNCERTAIN_GLYPH);
  if (status === "queued") return theme.fg("muted", SUITE_STATUS_GLYPHS.queued);
  if (status === "paused")
    return theme.fg(managerActivityColor("paused"), managerActivityGlyph("paused"));
  if (status === "warning" || status === "attention")
    return theme.fg(managerNoticeColor(status), managerNoticeGlyph(status));
  const kind = ACTIVITY_KINDS[status];
  return theme.fg(managerActivityColor(kind), managerActivityGlyph(kind, animationFrame));
}

export function renderCompactRow(input: CompactRowInput, theme: Theme, width: number): string {
  return layoutCompactRow(input, theme, width).row;
}

function compactRowDuration(input: CompactRowInput): string | undefined {
  const { elapsedMs } = input;
  const visible =
    input.timingEnabled !== false &&
    input.phase !== "pending" &&
    elapsedMs !== undefined &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 0 &&
    (input.summary.showShortTiming === true || elapsedMs >= TIMING_VISIBLE_MS);
  return visible ? compactSingleLine(input.duration ?? "") : undefined;
}

function compactRowPrefix(input: CompactRowInput, theme: Theme): string {
  const status = input.status ?? compactStatus(input.phase, input.summary);
  const icon = compactStatusIcon(
    status,
    theme,
    input.animationFrame,
    input.returnedCheckmark,
    input.summary.messageIcon,
    compactHold(input.summary),
  );
  const action = compactSingleLine(input.summary.action ?? "");
  return `${icon} ${theme.fg("accent", compactSingleLine(input.name))}${action ? ` ${action}` : ""}`;
}

function compactRowSubject({ expanded, summary }: CompactRowInput): string {
  return compactSingleLine(
    !expanded ? (summary.compactSubject ?? summary.subject) : summary.subject,
  );
}

/** A laid-out compact row and the counter alternative it shows, if any. */
export interface CompactRowLayout {
  readonly row: string;
  readonly issueShown: boolean;
  readonly subjectComplete: boolean;
  readonly counter?: string | undefined;
}

const COMPACT_SEPARATOR = (theme: Theme) => theme.fg("dim", " · ");

const mutedParts = (theme: Theme, values: readonly string[] | undefined): string[] =>
  values
    ? Arr.map(Arr.filter(Arr.map(values, compactSingleLine), Str.isNonEmpty), (text) =>
        theme.fg("muted", text),
      )
    : [];

/** The row's parts beside its subject: counter alternatives, widest first, then metadata. */
function compactRowParts(input: CompactRowInput, theme: Theme) {
  const { summary } = input;
  const duration = compactRowDuration(input);
  const timing = duration ? theme.fg("dim", duration) : undefined;
  return {
    counters: input.issueLabel ? [input.issueLabel] : mutedParts(theme, summary.counters),
    optional: [...mutedParts(theme, summary.metadata), summary.showTiming ? undefined : timing],
    timing: summary.showTiming ? timing : undefined,
  };
}

export function layoutCompactRow(
  input: CompactRowInput,
  theme: Theme,
  width: number,
): CompactRowLayout {
  if (width <= 0) return { row: "", issueShown: false, subjectComplete: false };
  const { counters, optional, timing } = compactRowParts(input, theme);
  const { row, counter, subjectComplete } = layoutCompactHeader(
    compactRowPrefix(input, theme),
    compactRowSubject(input),
    counters,
    optional,
    width,
    COMPACT_SEPARATOR(theme),
    timing,
    input.summary.pathSubject ? "path" : "prose",
  );
  return {
    row,
    issueShown: input.issueLabel !== undefined && counter === input.issueLabel,
    subjectComplete,
    counter,
  };
}

/** An expanded compact heading's rows, whether they show the whole subject, and its counter. */
export interface ExpandedCompactHeading {
  readonly rows: string[];
  readonly subjectComplete: boolean;
  readonly counter?: string | undefined;
}

/**
 * An expanded compact heading: the whole subject, then the counter alternative its collapsed row
 * shows at `collapsedWidth` (the widest without one), else the first metadata, then the timing the
 * collapsed row shows. A heading wider than the row wraps as a preview heading does, so the subject
 * is never cut mid-word and a counter that doesn't fit moves to a hanging continuation row; only a
 * subject too long for three rows is shortened, at a word boundary or in a path's middle.
 */
export function layoutExpandedCompactHeading(
  input: CompactRowInput,
  theme: Theme,
  width: number,
): ExpandedCompactHeading {
  if (width <= 0) return { rows: [], subjectComplete: false };
  const { counters, optional, timing } = compactRowParts(input, theme);
  const counter =
    input.collapsedWidth === undefined
      ? counters[0]
      : layoutCompactRow(
          { ...input, expanded: false, collapsedWidth: undefined },
          theme,
          input.collapsedWidth,
        ).counter;
  const extra = counters.length
    ? undefined
    : Option.getOrUndefined(
        Arr.findFirst(optional, (value) => value !== undefined && Str.isNonEmpty(Str.trim(value))),
      );
  const subject = compactSingleLine(input.summary.subject);
  const prefix = compactRowPrefix(input, theme);
  const parts = Arr.filter(
    Arr.filter(
      [counter, extra, !counters.length || counter !== undefined ? timing : undefined],
      Predicate.isNotUndefined,
    ),
    Str.isNonEmpty,
  );
  const wrap = (shown: string) =>
    wrapPreviewHeading(
      Arr.join([`${prefix}${shown ? ` ${shown}` : ""}`, ...parts], COMPACT_SEPARATOR(theme)),
      width,
    );
  const whole = wrap(subject);
  if (whole.length <= EXPANDED_HEADING_ROWS) return { rows: whole, subjectComplete: true, counter };
  // A subject longer than the rows allow is shortened as the collapsed row shortens it; the
  // body then shows it whole.
  const kind = input.summary.pathSubject ? "path" : "prose";
  let fits = 1;
  let over = visibleWidth(subject);
  while (over - fits > 1) {
    const room = Math.floor((fits + over) / 2);
    if (wrap(elideSubject(subject, room, kind)).length <= EXPANDED_HEADING_ROWS) fits = room;
    else over = room;
  }
  return { rows: wrap(elideSubject(subject, fits, kind)), subjectComplete: false, counter };
}

// An expanded compact heading wraps onto at most this many rows before its subject is shortened.
const EXPANDED_HEADING_ROWS = 3;

export function compactPlainText(text: string): string {
  return Fn.pipe(
    text,
    Str.replaceAll("\r\n", "\n"),
    escapeControlChars,
    Str.replaceAll("\t", "  "),
  );
}
