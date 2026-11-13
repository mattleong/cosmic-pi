import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerNoticeColor,
  managerNoticeGlyph,
  SUITE_STATUS_GLYPHS,
  withoutStatusGlyphWords,
  type ManagerActivityKind,
  type StatusGlyphMeaning,
} from "pi-cosmic-ui/manager";
import { escapeControlChars } from "../shared/terminal-text";
import {
  compactStatus,
  type CompactPhase,
  type CompactStatus,
  type CompactSummary,
} from "../tools/compact-summary";
import {
  elideSubject,
  FACT_CUT_SLACK,
  layoutCompactHeader,
  promotedFact,
  SUBJECT_MINIMUM,
} from "./compact-header";
import { wrapPreviewHeading } from "./heading-wrap";
import { layoutTaggedHeading, type TaggableHeading } from "./heading-tag";
import { TIMING_VISIBLE_MS } from "./tool-timing";

/** Whether a summary's collapsed subject is its whole subject rather than a shorter form. */
export const showsWholeSubject = ({
  compactSubject,
  subject,
}: Pick<CompactSummary, "compactSubject" | "subject">): boolean =>
  compactSubject === undefined || compactSubject === subject;

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
  /** The tag that collapsed row draws, which leaves its counter less room. */
  collapsedExpandLabel?: string | undefined;
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

/** Which of `STATUS_GLYPH_WORDS` the glyph {@link compactStatusIcon} draws for the same input says. */
function compactGlyphMeaning(
  status: CompactStatus,
  returnedCheckmark: boolean,
  messageIcon: CompactSummary["messageIcon"],
  hold: "waiting" | "queued" | undefined,
): StatusGlyphMeaning | undefined {
  if (hold && (status === "pending" || status === "running"))
    return hold === "queued" ? "queued" : undefined;
  if (messageIcon && (status === "success" || status === "returned")) return undefined;
  return Match.value(status).pipe(
    Match.when("returned", () => (returnedCheckmark ? "done" : undefined)),
    Match.whenOr("pending", "running", () => "running" as const),
    Match.when("success", () => "done" as const),
    Match.when("error", () => "failed" as const),
    Match.when("cancelled", () => "stopped" as const),
    Match.whenOr("queued", "paused", "uncertain", (state) => state),
    Match.orElse(() => undefined),
  );
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

const compactRowStatus = (input: CompactRowInput): CompactStatus =>
  input.status ?? compactStatus(input.phase, input.summary);

function compactRowPrefix(input: CompactRowInput, theme: Theme): string {
  const status = compactRowStatus(input);
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
export interface CompactRowLayout extends TaggableHeading {
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

const FACT_SEPARATOR = " · ";

/**
 * `values` without what only restates the row's status glyph: a fact that is only the glyph's word
 * goes, and one that measures the glyph's state keeps its duration (`finished in 1m 33s` beside `✓`
 * reads `1m 33s`). A combined counter such as `finished · ready to apply` keeps its other facts; an
 * alternative left with none is dropped. Facts that describe the subject's state (`subjectState`)
 * are not the glyph's and all stay.
 */
function withoutGlyphWords(
  values: readonly string[] | undefined,
  input: CompactRowInput,
): readonly string[] | undefined {
  if (values === undefined || input.summary.subjectState === true) return values;
  const meaning = compactGlyphMeaning(
    compactRowStatus(input),
    input.returnedCheckmark === true,
    input.summary.messageIcon,
    compactHold(input.summary),
  );
  if (meaning === undefined) return values;
  const own = (fact: string): string[] => {
    const kept = withoutStatusGlyphWords(compactSingleLine(fact), meaning);
    return kept === undefined ? [] : [kept];
  };
  const reduced = (value: string) =>
    Arr.join(Arr.flatMap(Str.split(value, FACT_SEPARATOR), own), FACT_SEPARATOR);
  return Arr.dedupe(
    Arr.filter(Arr.map(values, reduced), (value) => Str.isNonEmpty(Str.trim(value))),
  );
}

/**
 * The row's parts beside its subject: counter alternatives, widest first, then metadata. A fact
 * that only restates the row's status glyph is left out, whichever producer supplied it.
 */
function compactRowParts(input: CompactRowInput, theme: Theme) {
  const { summary } = input;
  const duration = compactRowDuration(input);
  const timing = duration ? theme.fg("dim", duration) : undefined;
  const own = (values: readonly string[] | undefined) => withoutGlyphWords(values, input);
  return {
    counters: input.issueLabel ? [input.issueLabel] : mutedParts(theme, own(summary.counters)),
    optional: [
      ...mutedParts(theme, own(summary.metadata)),
      summary.showTiming ? undefined : timing,
    ],
    timing: summary.showTiming ? timing : undefined,
  };
}

export function layoutCompactRow(
  input: CompactRowInput,
  theme: Theme,
  width: number,
  subjectMinimum = SUBJECT_MINIMUM,
): CompactRowLayout {
  if (width <= 0)
    return {
      row: "",
      issueShown: false,
      subjectComplete: false,
      fact: undefined,
      identityComplete: false,
    };
  const { counters, optional, timing } = compactRowParts(input, theme);
  const { row, counter, fact, subjectComplete, identityComplete } = layoutCompactHeader(
    compactRowPrefix(input, theme),
    compactRowSubject(input),
    counters,
    optional,
    width,
    COMPACT_SEPARATOR(theme),
    timing,
    input.summary.pathSubject ? "path" : "prose",
    subjectMinimum,
    input.expanded ? [] : Arr.map(input.summary.subjectAlternatives ?? [], compactSingleLine),
  );
  return {
    row,
    issueShown: input.issueLabel !== undefined && counter === input.issueLabel,
    // A collapsed row's short subject is never the whole one, as a preview heading's isn't.
    subjectComplete:
      subjectComplete && (input.expanded === true || showsWholeSubject(input.summary)),
    counter,
    fact,
    identityComplete,
  };
}

/**
 * A collapsed compact row with its expansion tag flush right, `▸ label` or a bare `▸`, laid out so
 * the subject is shortened for the tag rather than overlapped by it. Undefined `label` draws no tag,
 * nor does a label that reveals only a subject the row shows whole (`expandsSubjectOnly`).
 */
export function layoutTaggedCompactRow(
  input: CompactRowInput,
  theme: Theme,
  width: number,
  label: string | undefined,
): CompactRowLayout {
  if (input.summary.expandsSubjectOnly === true && showsWholeSubject(input.summary)) {
    const untagged = layoutCompactRow(input, theme, width);
    if (untagged.subjectComplete) return untagged;
  }
  return layoutTaggedHeading(label, theme, width, (room, subjectMinimum) =>
    layoutCompactRow(input, theme, room, subjectMinimum),
  );
}

/** An expanded compact heading's rows, whether they show the whole subject, and its counter. */
export interface ExpandedCompactHeading {
  readonly rows: string[];
  readonly subjectComplete: boolean;
  readonly counter?: string | undefined;
}

/**
 * An expanded compact heading: the whole subject, then the counter alternative its collapsed row
 * shows at `collapsedWidth` beside its `collapsedExpandLabel` tag (the widest without one), else
 * the first metadata, then the timing the
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
      : layoutTaggedCompactRow(
          { ...input, expanded: false, collapsedWidth: undefined },
          theme,
          input.collapsedWidth,
          input.collapsedExpandLabel,
        ).counter;
  const extra = promotedFact(counters, optional);
  const subject = compactSingleLine(input.summary.subject);
  const prefix = compactRowPrefix(input, theme);
  const parts = Arr.filter(
    [counter, extra, !counters.length || counter !== undefined ? timing : undefined],
    (part): part is string => Predicate.isString(part) && Str.isNonEmpty(part),
  );
  const wrap = (shown: string) =>
    wrapPreviewHeading(
      Arr.join([`${prefix}${shown ? ` ${shown}` : ""}`, ...parts], COMPACT_SEPARATOR(theme)),
      width,
    );
  const whole = wrap(subject);
  if (whole.length <= EXPANDED_HEADING_ROWS) return { rows: whole, subjectComplete: true, counter };
  // A subject longer than the rows allow is shortened at a word boundary, or a path in its
  // middle, never inside a word; the body then shows it whole.
  const kind = input.summary.pathSubject ? "path" : "prose";
  const cut = (room: number) => elideSubject(subject, room, kind, FACT_CUT_SLACK);
  let fits = 1;
  let over = visibleWidth(subject);
  while (over - fits > 1) {
    const room = Math.floor((fits + over) / 2);
    if (wrap(cut(room)).length <= EXPANDED_HEADING_ROWS) fits = room;
    else over = room;
  }
  return { rows: wrap(cut(fits)), subjectComplete: false, counter };
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
