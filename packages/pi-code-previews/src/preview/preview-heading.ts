import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderToolHeader } from "pi-cosmic-ui/tool";
import type { CompactSummary } from "../tools/compact-summary";
import { elideSubject } from "./compact-header";
import { wrapPreviewHeading } from "./heading-wrap";
import { compactSingleLine } from "./compact-row";

// renderToolHeader clips a longer subtitle.
const SUBTITLE_LIMIT = 160;

/** A drawn heading and whether it shows the whole subject, which a body may then leave out. */
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
    subjectComplete: visibleWidth(subtitle) <= SUBTITLE_LIMIT,
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
    subjectComplete: visibleWidth(subtitle) <= SUBTITLE_LIMIT,
  };
}

// The least room a cut subject keeps before a counter gives way to it, as compact headings keep.
const SUBJECT_MINIMUM = 12;

/**
 * A preview heading on one row, as tool rows draw theirs: the title, then the action, subject,
 * first counter, and metadata dimmed. Counters are alternatives, so only the first shows. A subject
 * that doesn't fit is cut the way compact headings cut it (prose at the end on a word boundary, a
 * path in the middle); metadata follows only a whole subject, and the first counter stays while the
 * cut subject keeps its minimum room.
 */
export function previewHeadingRow(
  title: string,
  summary: CompactSummary,
  expanded: boolean,
  theme: Pick<Theme, "fg" | "bold">,
  width: number,
): string {
  const action = compactSingleLine(summary.action ?? "");
  const subject = compactSingleLine(
    expanded ? summary.subject : (summary.compactSubject ?? summary.subject),
  );
  const facts = headingFacts(summary);
  const tail = (count: number) => factTail(facts, count);
  const room =
    width - visibleWidth(compactSingleLine(title)) - 1 - (action ? visibleWidth(action) + 1 : 0);
  const draw = (shown: string, count: number) =>
    clipToWidth(
      renderToolHeader({ title, subtitle: headingSubtitle(action, shown, facts, count) }, theme),
      width,
    );
  for (let count = facts.length; count >= 0; count--)
    if (visibleWidth(subject) + visibleWidth(tail(count)) <= room) return draw(subject, count);
  const counter =
    Arr.isReadonlyArrayNonEmpty(summary.counters ?? []) &&
    room - visibleWidth(tail(1)) >= Math.min(SUBJECT_MINIMUM, visibleWidth(subject))
      ? 1
      : 0;
  const cut = elideSubject(
    subject,
    room - visibleWidth(tail(counter)),
    summary.pathSubject ? "path" : "prose",
  );
  return draw(cut, counter);
}
