import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { findOrUndefined } from "pi-cosmic-core/array";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderToolHeader } from "pi-cosmic-ui/tool";
import type { CompactSummary } from "../tools/compact-summary";
import {
  cutsCleanly,
  elideSubject,
  endElide,
  FACT_CUT_SLACK,
  SUBJECT_MINIMUM,
  subjectForms,
} from "./compact-header";
import type { TaggableHeading } from "./heading-tag";
import { previewHeadingText, takeHeadingRoom, wrapPreviewHeading } from "./heading-wrap";
import { drawsExpandedHeading } from "./preview-issues";
import { compactSingleLine, showsWholeSubject } from "./compact-row";

const factTail = (facts: readonly string[], count: number): string =>
  count === 0 ? "" : ` · ${Arr.join(Arr.take(facts, count), " · ")}`;

const headingSubtitle = (
  action: string,
  subject: string,
  facts: readonly string[],
  count: number,
): string =>
  `${Arr.join(Arr.filter([action, subject], Str.isNonEmpty), " ")}${factTail(facts, count)}`;

const singleLineFacts = (values: readonly string[] | undefined): string[] =>
  Arr.filter(Arr.map(values ?? [], compactSingleLine), Str.isNonEmpty);

/**
 * An expanded preview heading: the collapsed row's title, action, subject, first counter, and
 * metadata. It wraps rather than cuts, so it always shows the whole subject, which a body may then
 * leave out.
 */
export function wrappedPreviewHeading(
  title: string,
  summary: CompactSummary,
  theme: Pick<Theme, "fg" | "bold">,
  width: number,
): string[] {
  const facts = singleLineFacts([
    ...(summary.counters ?? []).slice(0, 1),
    ...(summary.metadata ?? []),
  ]);
  const subtitle = headingSubtitle(
    compactSingleLine(summary.action ?? ""),
    compactSingleLine(summary.subject),
    facts,
    facts.length,
  );
  return wrapPreviewHeading(renderToolHeader({ title, subtitle }, theme), width);
}

/** A one-row preview heading, and whether it shows its whole subject. */
export interface PreviewHeadingRowLayout extends TaggableHeading {
  readonly subjectComplete: boolean;
}

/**
 * A preview heading on one row, as tool rows draw theirs, with the fact it keeps: the title, then
 * the action, subject, a counter, and metadata dimmed. Counters are alternatives, widest first, as
 * on compact rows: the first that fits beside the whole subject shows, with as much metadata after
 * it as fits. A subject that fits beside none shows the first of its narrower whole forms
 * (`subjectAlternatives`) that does. Otherwise the first counter alternative that leaves the
 * subject `subjectMinimum` columns, as compact headings keep, stays, or without counters the first
 * metadata when the cut keeps whole words or a path's file name, so the row keeps its outcome, and
 * the subject is cut the way compact headings cut it (prose at the end on a word boundary, a path
 * in the middle); only a row left with no fact shows a narrower whole form alone instead.
 */
export function layoutPreviewHeadingRow(
  title: string,
  summary: CompactSummary,
  expanded: boolean,
  theme: Pick<Theme, "fg" | "bold">,
  width: number,
  subjectMinimum = SUBJECT_MINIMUM,
): PreviewHeadingRowLayout {
  const action = compactSingleLine(summary.action ?? "");
  const subject = compactSingleLine(
    expanded ? summary.subject : (summary.compactSubject ?? summary.subject),
  );
  const subjectWidth = visibleWidth(subject);
  const counters = singleLineFacts(summary.counters);
  const metadata = singleLineFacts(summary.metadata);
  const room =
    width - visibleWidth(compactSingleLine(title)) - 1 - (action ? visibleWidth(action) + 1 : 0);
  // The title and action show whole beside a subject cut to its first column and `…`.
  const identityComplete = room >= (subject ? 2 : -1);
  // A collapsed row's short subject is never the whole one.
  const whole = expanded || showsWholeSubject(summary);
  const draw = (
    shown: string,
    shownFacts: readonly string[],
    count: number,
  ): PreviewHeadingRowLayout => ({
    row: clipToWidth(
      renderToolHeader(
        { title, subtitle: headingSubtitle(action, shown, shownFacts, count) },
        theme,
      ),
      width,
    ),
    fact: count > 0 ? shownFacts[0] : undefined,
    identityComplete,
    subjectComplete: whole && identityComplete && shown === subject,
  });
  const fits = (shown: string, shownFacts: readonly string[], count: number) =>
    visibleWidth(shown) + visibleWidth(factTail(shownFacts, count)) <= room;
  const kind = summary.pathSubject ? "path" : "prose";
  const counter = findOrUndefined(
    counters.length > 0 ? counters : Arr.take(metadata, 1),
    (value) => room - visibleWidth(factTail([value], 1)) >= Math.min(subjectMinimum, subjectWidth),
  );
  const factSets =
    counters.length > 0
      ? Arr.map(counters, (shownCounter) => [shownCounter, ...metadata])
      : [metadata];
  const firstFit = (
    form: string,
    sets: readonly (readonly string[])[],
    leastCount: number,
  ): HeadingChoice | undefined => {
    for (const shownFacts of sets)
      for (let count = shownFacts.length; count >= Math.max(1, leastCount); count--)
        if (fits(form, shownFacts, count)) return { shown: form, facts: shownFacts, count };
    return undefined;
  };
  const cut = (kept: readonly string[]) =>
    elideSubject(
      subject,
      room - visibleWidth(factTail(kept, kept.length)),
      kind,
      kept.length > 0 ? FACT_CUT_SLACK : undefined,
    );
  const subjectChoice = (): HeadingChoice => {
    const withFacts = firstFit(subject, factSets, 1);
    if (withFacts) return withFacts;
    const kept = counter === undefined ? [] : [counter];
    // Metadata gives way only to a cut that keeps whole words, or a path's file name.
    if (kept.length > 0 && (counters.length > 0 || cutsCleanly(subject, cut(kept), kind)))
      return { shown: cut(kept), facts: kept, count: kept.length };
    return { shown: fits(subject, [], 0) ? subject : cut([]), facts: [], count: 0 };
  };
  const base = subjectChoice();
  const alternatives = expanded
    ? []
    : Arr.drop(
        subjectForms(subject, Arr.map(summary.subjectAlternatives ?? [], compactSingleLine)),
        1,
      );
  // A whole subject never gives way; an alternative replaces a cut one only when it keeps the
  // counter the cut kept, or an earlier, more informative one, and at least as many facts.
  if (base.shown === subject || alternatives.length === 0)
    return draw(base.shown, base.facts, base.count);
  const keptIndex =
    base.count > 0
      ? Option.getOrElse(
          Arr.findFirstIndex(counters, (value) => value === base.facts[0]),
          () => counters.length - 1,
        )
      : counters.length - 1;
  const sets = counters.length > 0 ? Arr.take(factSets, keptIndex + 1) : factSets;
  for (const form of alternatives) {
    const choice = firstFit(form, sets, base.count);
    if (choice) return draw(choice.shown, choice.facts, choice.count);
  }
  // A row that keeps no fact shows a narrower whole form before it cuts the subject.
  const alone =
    base.count === 0 ? Arr.findFirst(alternatives, (form) => fits(form, [], 0)) : Option.none();
  return Option.isSome(alone) ? draw(alone.value, [], 0) : draw(base.shown, base.facts, base.count);
}

/** The subject form and facts a one-row preview heading draws. */
interface HeadingChoice {
  readonly shown: string;
  readonly facts: readonly string[];
  readonly count: number;
}

/** A heading that names who a message goes to or comes from, such as `Message → web work`. */
export interface PreviewMessageHeading {
  /** The words before the name, such as `Message →` or `Reply ←`. */
  readonly title: string;
  /** The agent or session on the other end; blank when it is unknown. */
  readonly name?: string | undefined;
}

const messageHeadingTitle = (title: string, name: string): string =>
  Arr.join(Arr.filter([title, name], Str.isNonEmpty), " ");

/**
 * A preview call heading that names a message's other end, read at each render because a result
 * may name the recipient after the call draws. Collapsed it is one row, as a collapsed message
 * heading is, so a long name never wraps into the message beneath it: the name is cut at a word
 * boundary as compact headings cut prose. Expanded it wraps with the name whole.
 */
export function previewMessageHeading(
  heading: () => PreviewMessageHeading,
  theme: Pick<Theme, "fg" | "bold">,
  context: { readonly expanded: boolean; readonly state: unknown },
): Component {
  const shown = () => {
    const { title, name } = heading();
    return { title: compactSingleLine(title), name: compactSingleLine(name ?? "") };
  };
  if (drawsExpandedHeading(context))
    return previewHeadingText(() => {
      const { title, name } = shown();
      return renderToolHeader({ title: messageHeadingTitle(title, name) }, theme);
    });
  // The row's tag takes its room from the name, which is then cut at a word boundary.
  const tagRoom = takeHeadingRoom();
  return {
    render(width) {
      if (width <= 0) return [];
      const { title, name } = shown();
      const room = width - visibleWidth(title) - 1 - (tagRoom?.reserve ?? 0);
      const cut = room > 1 ? endElide(name, room) : name;
      return [
        clipToWidth(renderToolHeader({ title: messageHeadingTitle(title, cut) }, theme), width),
      ];
    },
    invalidate() {},
  };
}
