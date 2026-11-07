import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
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
} from "./compact-header";
import type { TaggableHeading } from "./heading-tag";
import { previewHeadingText, takeHeadingRoom, wrapPreviewHeading } from "./heading-wrap";
import { drawsExpandedHeading } from "./preview-issues";
import { compactSingleLine } from "./compact-row";

/**
 * A drawn heading and whether it shows the whole subject, which a body may then leave out. The
 * heading is never cut, so it shows the whole subject wherever its rows wrap rather than clip.
 */
export interface PreviewHeadingLayout {
  readonly text: string;
  readonly subjectComplete: boolean;
}

const headingFacts = (summary: CompactSummary): string[] =>
  Arr.filter(
    Arr.map([...(summary.counters ?? []).slice(0, 1), ...(summary.metadata ?? [])], (fact) =>
      compactSingleLine(fact),
    ),
    Str.isNonEmpty,
  );

export function layoutPreviewHeading(
  title: string,
  summary: CompactSummary,
  expanded: boolean,
  theme: Pick<Theme, "fg" | "bold">,
): PreviewHeadingLayout {
  const subject = expanded ? summary.subject : (summary.compactSubject ?? summary.subject);
  const lead = Arr.join(
    Arr.filter(
      [compactSingleLine(summary.action ?? ""), compactSingleLine(subject)],
      Str.isNonEmpty,
    ),
    " ",
  );
  const subtitle = Arr.join(Arr.filter([lead, ...headingFacts(summary)], Str.isNonEmpty), " · ");
  return {
    text: renderToolHeader({ title, subtitle }, theme),
    subjectComplete: true,
  };
}

const factTail = (facts: readonly string[], count: number): string =>
  count === 0 ? "" : ` · ${Arr.join(Arr.take(facts, count), " · ")}`;

const headingSubtitle = (
  action: string,
  subject: string,
  facts: readonly string[],
  count: number,
): string =>
  `${Arr.join(Arr.filter([action, subject], Str.isNonEmpty), " ")}${factTail(facts, count)}`;

/** A heading drawn on as many rows as it needs, and whether it shows the whole subject. */
export interface WrappedPreviewHeading {
  readonly rows: string[];
  readonly subjectComplete: boolean;
}

/**
 * An expanded message's preview heading: the collapsed row's title, action, subject, first counter,
 * and metadata, wrapped rather than cut, and whether it shows the whole subject.
 */
export function wrappedPreviewHeading(
  title: string,
  summary: CompactSummary,
  theme: Pick<Theme, "fg" | "bold">,
  width: number,
): WrappedPreviewHeading {
  const facts = headingFacts(summary);
  const subtitle = headingSubtitle(
    compactSingleLine(summary.action ?? ""),
    compactSingleLine(summary.subject),
    facts,
    facts.length,
  );
  return {
    rows: wrapPreviewHeading(renderToolHeader({ title, subtitle }, theme), width),
    subjectComplete: true,
  };
}

const singleLineFacts = (values: readonly string[] | undefined): string[] =>
  Arr.filter(Arr.map(values ?? [], compactSingleLine), Str.isNonEmpty);

/**
 * A preview heading on one row, as tool rows draw theirs: the title, then the action, subject, a
 * counter, and metadata dimmed. Counters are alternatives, widest first, as on compact rows: the
 * first that fits beside the whole subject shows, with as much metadata after it as fits. Otherwise
 * the first counter alternative that leaves the subject its minimum room stays, or without counters
 * the first metadata when the cut keeps whole words or a path's file name, so the row keeps its
 * outcome, and the subject is cut the way compact headings cut it (prose at the end on a word
 * boundary, a path in the middle).
 */
export function previewHeadingRow(
  title: string,
  summary: CompactSummary,
  expanded: boolean,
  theme: Pick<Theme, "fg" | "bold">,
  width: number,
): string {
  return layoutPreviewHeadingRow(title, summary, expanded, theme, width).row;
}

/**
 * {@link previewHeadingRow} with the fact it keeps, its subject keeping `subjectMinimum` columns
 * beside a counter, as compact headings keep.
 */
export function layoutPreviewHeadingRow(
  title: string,
  summary: CompactSummary,
  expanded: boolean,
  theme: Pick<Theme, "fg" | "bold">,
  width: number,
  subjectMinimum = SUBJECT_MINIMUM,
): TaggableHeading {
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
  const draw = (shown: string, shownFacts: readonly string[], count: number): TaggableHeading => ({
    row: clipToWidth(
      renderToolHeader(
        { title, subtitle: headingSubtitle(action, shown, shownFacts, count) },
        theme,
      ),
      width,
    ),
    fact: count > 0 ? shownFacts[0] : undefined,
    identityComplete,
  });
  const fits = (shownFacts: readonly string[], count: number) =>
    subjectWidth + visibleWidth(factTail(shownFacts, count)) <= room;
  for (const shownFacts of counters.length > 0
    ? Arr.map(counters, (counter) => [counter, ...metadata])
    : [metadata])
    for (let count = shownFacts.length; count >= 1; count--)
      if (fits(shownFacts, count)) return draw(subject, shownFacts, count);
  const kind = summary.pathSubject ? "path" : "prose";
  const counter = Option.getOrUndefined(
    Arr.findFirst(
      counters.length > 0 ? counters : Arr.take(metadata, 1),
      (value) =>
        room - visibleWidth(factTail([value], 1)) >= Math.min(subjectMinimum, subjectWidth),
    ),
  );
  const cut = (kept: readonly string[]) =>
    elideSubject(
      subject,
      room - visibleWidth(factTail(kept, kept.length)),
      kind,
      kept.length > 0 ? FACT_CUT_SLACK : undefined,
    );
  const kept = counter === undefined ? [] : [counter];
  // Metadata gives way only to a cut that keeps whole words, or a path's file name.
  return counters.length > 0 || cutsCleanly(subject, cut(kept), kind)
    ? draw(cut(kept), kept, kept.length)
    : draw(cut([]), [], 0);
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
