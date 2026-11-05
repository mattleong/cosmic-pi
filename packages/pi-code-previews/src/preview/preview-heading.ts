import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderToolHeader } from "pi-cosmic-ui/tool";
import type { CompactSummary } from "../tools/compact-summary";
import { compactSingleLine } from "./compact-row";

/**
 * A preview heading drawn from a summary, as tool rows draw theirs: the title, then the action,
 * subject, first counter, and metadata dimmed. Counters are alternatives, so only the first shows.
 */
export function renderPreviewHeading(
  title: string,
  summary: CompactSummary,
  expanded: boolean,
  theme: Pick<Theme, "fg" | "bold">,
): string {
  return layoutPreviewHeading(title, summary, expanded, theme).text;
}

// renderToolHeader clips a longer subtitle.
const SUBTITLE_LIMIT = 160;

/** A drawn heading and whether it shows the whole subject, which a body may then leave out. */
export interface PreviewHeadingLayout {
  readonly text: string;
  readonly subjectComplete: boolean;
}

export function layoutPreviewHeading(
  title: string,
  summary: CompactSummary,
  expanded: boolean,
  theme: Pick<Theme, "fg" | "bold">,
): PreviewHeadingLayout {
  const subject = expanded ? summary.subject : (summary.compactSubject ?? summary.subject);
  const facts = Arr.filter(
    Arr.map([...(summary.counters ?? []).slice(0, 1), ...(summary.metadata ?? [])], (fact) =>
      compactSingleLine(fact),
    ),
    Str.isNonEmpty,
  );
  const lead = Arr.join(
    Arr.filter(
      [compactSingleLine(summary.action ?? ""), compactSingleLine(subject)],
      Str.isNonEmpty,
    ),
    " ",
  );
  const subtitle = Arr.join(Arr.filter([lead, ...facts], Str.isNonEmpty), " · ");
  return {
    text: renderToolHeader({ title, subtitle }, theme),
    subjectComplete: visibleWidth(subtitle) <= SUBTITLE_LIMIT,
  };
}
