import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Option from "effect/Option";
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
const TRAILING_BREAK = /[\s,;:.\-–—…]+$/u;

/**
 * Cuts prose at the end on a word boundary, ending in `…`, so every word that remains is whole.
 * One word wider than the room is cut where it reaches the edge, as is text whose last boundary
 * would discard more than `slack` of the room.
 */
export function endElide(text: string, width: number, slack = WORD_CUT_SLACK): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  let head = "";
  let headWidth = 0;
  let lastBreak: string | undefined;
  for (const { segment } of graphemes.segment(text)) {
    const segmentWidth = visibleWidth(segment);
    if (headWidth + segmentWidth > width - 1) break;
    if (/\s/u.test(segment)) lastBreak = head;
    head += segment;
    headWidth += segmentWidth;
  }
  const atWord = lastBreak === undefined ? undefined : Str.replace(TRAILING_BREAK, "")(lastBreak);
  const kept =
    atWord && visibleWidth(atWord) >= (width - 1) * (1 - slack)
      ? atWord
      : Str.replace(TRAILING_BREAK, "")(head);
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
    return Str.endsWith(Option.getOrElse(Arr.last(Str.split(text, "/")), () => text))(cut);
  const head = Str.endsWith("…")(cut) ? Str.slice(0, -1)(cut) : cut;
  return Str.startsWith(head)(text) && WORD_BREAK.test(Str.slice(head.length)(text));
}

/**
 * Lays out `identity subject · counter`, choosing the first counter alternative that leaves the
 * subject 12 columns; a subject cut beside it keeps whole words. Without counters the first
 * optional fact takes a counter's place when such a cut exists (or keeps a path's file name), so a
 * heading whose subject is cut still shows its outcome, such as `finished in 1m 33s`.
 */
export function layoutCompactHeader(
  identity: string,
  subject: string,
  candidateCounters: readonly string[],
  optional: readonly (string | undefined)[],
  width: number,
  separator = " · ",
  timing?: string,
  subjectKind: CompactSubjectKind = "prose",
) {
  const counters = Arr.filter(candidateCounters, (value) => Str.isNonEmpty(Str.trim(value)));
  const extra = counters.length
    ? undefined
    : Option.getOrUndefined(
        Arr.findFirst(optional, (value) => value !== undefined && Str.isNonEmpty(Str.trim(value))),
      );
  const remaining = width - visibleWidth(identity);
  // A clipped heading always ends in an ellipsis, so it never reads as complete.
  if (remaining <= 0)
    return {
      row: clipToWidth(`${identity}${subject ? ` ${subject}` : ""}`, width),
      counter: undefined,
      subjectComplete: !subject,
    };
  const subjectWidth = visibleWidth(subject);
  const subjectMinimum = subject ? 1 + Math.min(12, subjectWidth) : 0;
  const counterBudget = remaining - subjectMinimum;
  const timingToken = timing && Str.trim(timing) ? `${separator}${timing}` : "";
  const lay = (facts: readonly string[]) => {
    const counter = Option.getOrUndefined(
      Arr.findFirst(facts, (value) => visibleWidth(`${separator}${value}`) <= counterBudget),
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
      subjectComplete: false,
    };
  return {
    row: identity + (target ? ` ${target}` : "") + counterText + timingText,
    counter: counters.length ? counter : undefined,
    subjectComplete: target === subject,
  };
}
