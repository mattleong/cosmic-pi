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
 * One word wider than the room is cut where it reaches the edge.
 */
export function endElide(text: string, width: number): string {
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
    atWord && visibleWidth(atWord) >= (width - 1) * (1 - WORD_CUT_SLACK)
      ? atWord
      : Str.replace(TRAILING_BREAK, "")(head);
  return `${kept || head}…`;
}

export function elideSubject(text: string, width: number, kind: CompactSubjectKind): string {
  return kind === "path" ? middleElide(text, width) : endElide(text, width);
}

/**
 * Lays out `identity subject · counter`, choosing the first counter alternative that leaves the
 * subject 12 columns. `keepCounter` instead shortens the subject to as little as one character to
 * keep a counter; an expanded heading passes it with the alternatives from the collapsed row's
 * choice on, so both keep the same words at one terminal width.
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
  keepCounter = false,
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
  const subjectMinimum = (room: number) => (subject ? 1 + Math.min(room, subjectWidth) : 0);
  const counterBudget = remaining - subjectMinimum(12);
  // A kept counter leaves the subject one character and its ellipsis.
  const keptBudget = keepCounter ? remaining - subjectMinimum(2) : counterBudget;
  const counter = Option.getOrUndefined(
    Arr.findFirst(counters, (value) => visibleWidth(`${separator}${value}`) <= keptBudget),
  );
  const counterText = counter === undefined ? "" : `${separator}${counter}`;
  const counterWidth = visibleWidth(counterText);
  const timingToken = timing && Str.trim(timing) ? `${separator}${timing}` : "";
  const timingText =
    (!counters.length || counterText.length > 0) &&
    counterWidth + visibleWidth(timingToken) <= counterBudget
      ? timingToken
      : "";
  const target = elideSubject(
    subject,
    remaining - counterWidth - visibleWidth(timingText) - 1,
    subjectKind,
  );
  if (subject && !target)
    return {
      row: clipToWidth(`${identity} ${subject}`, width),
      counter: undefined,
      subjectComplete: false,
    };
  const row = identity + (target ? ` ${target}` : "") + counterText;
  const token = extra === undefined ? "" : `${separator}${extra}`;
  const fits =
    target === subject &&
    visibleWidth(row) + visibleWidth(timingText) + visibleWidth(token) <= width;
  return {
    row: row + (fits ? token : "") + timingText,
    counter,
    subjectComplete: target === subject,
  };
}
