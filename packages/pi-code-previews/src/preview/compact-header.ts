import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import * as Fn from "effect/Function";
import { findOrUndefined } from "pi-cosmic-core/array";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clipToWidth } from "pi-cosmic-ui/manager";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function middleElide(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const parts = Array.from(graphemes.segment(text), ({ segment }) => ({
    text: segment,
    width: visibleWidth(segment),
  }));
  let remaining = width - 1;
  let left = 0;
  let right = parts.length;
  let head = "";
  let tail = "";
  let headWidth = 0;
  let tailWidth = 0;
  while (left < right) {
    const fromLeft = headWidth <= tailWidth;
    const part = parts[fromLeft ? left : right - 1];
    if (!part || part.width > remaining) break;
    remaining -= part.width;
    if (fromLeft) {
      head += part.text;
      headWidth += part.width;
      left++;
    } else {
      tail = part.text + tail;
      tailWidth += part.width;
      right--;
    }
  }
  return `${head}…${tail}`;
}

/** How a subject that doesn't fit is shortened. */
export type CompactSubjectKind = "prose" | "path";

// A word-boundary cut that would discard more than this share of the room cuts mid-word instead.
const WORD_CUT_SLACK = 0.4;
const TRAILING_BREAK = /[\s,;:._\-–—…]+$/u;
// Where a name too wide for the room may be cut, as a wrapped heading breaks one.
const NAME_BREAK = /^[-_.]$/u;

/**
 * Cuts prose at the end on a word boundary, ending in `…`, so every word that remains is whole.
 * Text whose last word boundary would discard more than `slack` of the room is cut inside the word
 * that reaches the edge, after its last `-`, `_`, or `.` that fits, so a long name keeps whole
 * segments (`billing-and-invoicing…`); only a segment that would also discard more is cut where it
 * reaches the edge.
 */
export function endElide(text: string, width: number, slack = WORD_CUT_SLACK): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  let head = "";
  let headWidth = 0;
  let lastBreak: string | undefined;
  let lastNameBreak: string | undefined;
  for (const { segment } of graphemes.segment(text)) {
    const segmentWidth = visibleWidth(segment);
    // A word or segment that ends exactly at the edge is whole.
    if (headWidth + segmentWidth > width - 1) {
      if (/\s/u.test(segment)) lastBreak = head;
      else if (NAME_BREAK.test(segment)) lastNameBreak = head;
      break;
    }
    if (/\s/u.test(segment)) {
      lastBreak = head;
      lastNameBreak = undefined;
    }
    head += segment;
    headWidth += segmentWidth;
    if (NAME_BREAK.test(segment)) lastNameBreak = head;
  }
  const enough = (cut: string) => visibleWidth(cut) >= (width - 1) * (1 - slack);
  const kept = Option.getOrElse(
    Arr.findFirst([lastBreak, lastNameBreak], (cut) => {
      if (cut === undefined) return Option.none();
      const trimmed = Fn.pipe(cut, Str.replace(TRAILING_BREAK, ""));
      return Str.isNonEmpty(trimmed) && enough(trimmed) ? Option.some(trimmed) : Option.none();
    }),
    () => Fn.pipe(head, Str.replace(TRAILING_BREAK, "")),
  );
  return `${kept || head}…`;
}

/** A cut that makes room for a fact keeps whole words, however much of the room it gives up. */
export const FACT_CUT_SLACK = 1;

export function elideSubject(
  text: string,
  width: number,
  kind: CompactSubjectKind,
  slack = WORD_CUT_SLACK,
): string {
  return kind === "path" ? middleElide(text, width) : endElide(text, width, slack);
}

// A prose cut is clean when the text it drops starts at a space, after any punctuation it trimmed.
const WORD_BREAK = /^[,;:.\-–—…]*\s/u;

/**
 * Whether `cut`, a shortening of `text`, keeps every word it shows whole, or for a path its whole
 * file name. Only such a cut gives way to a fact that is not a counter.
 */
export function cutsCleanly(text: string, cut: string, kind: CompactSubjectKind): boolean {
  if (cut === text) return true;
  if (kind === "path")
    return Fn.pipe(cut, Str.endsWith(Option.getOrElse(Arr.last(Str.split(text, "/")), () => text)));
  const head = Fn.pipe(cut, Str.endsWith("…")) ? Fn.pipe(cut, Str.slice(0, -1)) : cut;
  return (
    Fn.pipe(text, Str.startsWith(head)) && WORD_BREAK.test(Fn.pipe(text, Str.slice(head.length)))
  );
}

/** The columns a collapsed heading's subject keeps beside a fact, unless it is shorter. */
export const SUBJECT_MINIMUM = 12;

/** The subject, then its narrower whole forms (`subjectAlternatives`), widest first. */
export const subjectForms = (subject: string, alternatives: readonly string[] = []): string[] =>
  Arr.dedupe([subject, ...Arr.filter(alternatives, (form) => Str.isNonEmpty(Str.trim(form)))]);

/**
 * Lays out `identity subject · counter`, choosing the first counter alternative that leaves the
 * subject `subjectMinimum` columns; a subject cut beside it keeps whole words. Without counters the
 * first optional fact takes a counter's place when such a cut exists (or keeps a path's file name),
 * so a heading whose subject is cut still shows its outcome, such as `timed out after 30s`. A
 * subject that would be cut, or lose the row's fact, gives way to the first of its
 * `subjectAlternatives` that shows whole and keeps a fact wherever the subject kept one. `fact` is
 * the counter or outcome fact shown, `subjectComplete` whether the row shows the whole subject
 * (never an alternative), and `identityComplete` whether the identity shows whole.
 */
export function layoutCompactHeader(
  identity: string,
  subject: string,
  candidateCounters: readonly string[],
  optional: readonly (string | undefined)[],
  width: number,
  separator: string,
  timing: string | undefined,
  subjectKind: CompactSubjectKind,
  subjectMinimumColumns: number,
  subjectAlternatives: readonly string[],
) {
  const lay = (shown: string, counters: readonly string[]) =>
    layoutSubjectHeader(
      identity,
      shown,
      counters,
      optional,
      width,
      separator,
      timing,
      subjectKind,
      subjectMinimumColumns,
    );
  const base = lay(subject, candidateCounters);
  if (base.subjectComplete || !base.identityComplete) return base;
  // A narrower form takes the counter its own room allows, else the one the subject kept.
  const counterChoices = [
    candidateCounters,
    ...(base.counter === undefined ? [] : [[base.counter]]),
  ];
  for (const form of Arr.drop(subjectForms(subject, subjectAlternatives), 1))
    for (const counters of counterChoices) {
      const layout = lay(form, counters);
      if (layout.subjectComplete && (base.fact === undefined || layout.fact !== undefined))
        return { ...layout, subjectComplete: false };
    }
  return base;
}

/** The first non-blank optional fact, which takes a counter's place on a row without counters. */
export const promotedFact = (
  counters: readonly string[],
  optional: readonly (string | undefined)[],
): string | undefined =>
  counters.length > 0
    ? undefined
    : findOrUndefined(optional, (value) => value !== undefined && Str.isNonEmpty(Str.trim(value)));

function layoutSubjectHeader(
  identity: string,
  subject: string,
  candidateCounters: readonly string[],
  optional: readonly (string | undefined)[],
  width: number,
  separator: string,
  timing: string | undefined,
  subjectKind: CompactSubjectKind,
  subjectMinimumColumns: number,
) {
  const counters = Arr.filter(candidateCounters, (value) => Str.isNonEmpty(Str.trim(value)));
  const extra = promotedFact(counters, optional);
  const remaining = width - visibleWidth(identity);
  // A clipped heading always ends in an ellipsis, so it never reads as complete; the identity stays
  // whole beside a subject cut to its first column and `…`.
  const identityComplete = remaining >= (subject ? 3 : 0);
  if (remaining <= 0)
    return {
      row: clipToWidth(`${identity}${subject ? ` ${subject}` : ""}`, width),
      counter: undefined,
      fact: undefined,
      subjectComplete: !subject,
      identityComplete,
    };
  const subjectMinimum = subject ? 1 + Math.min(subjectMinimumColumns, visibleWidth(subject)) : 0;
  const counterBudget = remaining - subjectMinimum;
  const timingToken = timing && Str.trim(timing) ? `${separator}${timing}` : "";
  const lay = (facts: readonly string[]) => {
    const counter = findOrUndefined(
      facts,
      (value) => visibleWidth(`${separator}${value}`) <= counterBudget,
    );
    const counterText = counter === undefined ? "" : `${separator}${counter}`;
    const counterWidth = visibleWidth(counterText);
    const timingText =
      (!counters.length || counterText.length > 0) &&
      counterWidth + visibleWidth(timingToken) <= counterBudget
        ? timingToken
        : "";
    const target = elideSubject(
      subject,
      remaining - counterWidth - visibleWidth(timingText) - 1,
      subjectKind,
      counter === undefined ? WORD_CUT_SLACK : FACT_CUT_SLACK,
    );
    return { counter, counterText, timingText, target };
  };
  const promoted = extra === undefined ? undefined : lay([extra]);
  const { counter, counterText, timingText, target } =
    counters.length > 0
      ? lay(counters)
      : promoted?.counter !== undefined && cutsCleanly(subject, promoted.target, subjectKind)
        ? promoted
        : lay([]);
  if (subject && !target)
    return {
      row: clipToWidth(`${identity} ${subject}`, width),
      counter: undefined,
      fact: undefined,
      subjectComplete: false,
      identityComplete,
    };
  return {
    row: identity + (target ? ` ${target}` : "") + counterText + timingText,
    counter: counters.length ? counter : undefined,
    fact: counter,
    subjectComplete: target === subject,
    identityComplete,
  };
}
