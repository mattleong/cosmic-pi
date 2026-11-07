import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { SUBJECT_MINIMUM } from "./compact-header";

/** The narrowest row whose tag names what expansion reveals; narrower rows show a bare `▸`. */
export const TAG_LABEL_MIN_WIDTH = 80;
// Columns kept clear between a row's content and its tag.
const TAG_GAP = 2;
const BARE_TAG_WIDTH = 1;
/** The columns a bare `▸` tag takes from a row's content, with its gap. */
export const BARE_TAG_RESERVE = TAG_GAP + BARE_TAG_WIDTH;
// A row narrower than this has no room for a tag beside any content.
const MIN_TAGGED_WIDTH = BARE_TAG_RESERVE + 1;

const labelTag = (label: string, theme: Pick<Theme, "fg">) =>
  renderExpansionAffordance(label, false, theme);
const bareTag = (theme: Pick<Theme, "fg">) => theme.fg("accent", "▸");

/** The columns the full `▸ label` tag takes with its gap, or undefined where it never shows. */
const labelTagReserve = (label: string, width: number): number | undefined =>
  width >= TAG_LABEL_MIN_WIDTH ? TAG_GAP + visibleWidth(`▸ ${label}`) : undefined;

/** A drawn row's width without the blank columns that pad it to the row's width. */
const contentWidth = (row: string): number => visibleWidth(Str.trimEnd(stripTerminalControls(row)));

/**
 * A collapsed row's first row with its expansion tag flush right: `▸ label` from 80 columns when it
 * fits, else a bare `▸`, at least two columns after the row's content. A row whose content leaves
 * no room for even a bare `▸` is cut by the tag's width with `…`. Undefined `label` leaves the row
 * as drawn.
 */
export function placeHeadingTag(
  row: string,
  label: string | undefined,
  theme: Pick<Theme, "fg">,
  width: number,
): string {
  if (label === undefined || width < MIN_TAGGED_WIDTH) return row;
  const used = contentWidth(row);
  const content = used < visibleWidth(row) ? clipToWidth(row, used, "") : row;
  const full = labelTagReserve(label, width);
  const tag = full !== undefined && used + full <= width ? labelTag(label, theme) : bareTag(theme);
  const tagWidth = visibleWidth(tag);
  const shown =
    used + TAG_GAP + tagWidth <= width ? content : clipToWidth(row, width - TAG_GAP - tagWidth);
  return `${shown}${Fn.pipe(" ", Str.repeat(width - contentWidth(shown) - tagWidth))}${tag}`;
}

/** What a one-row heading layout shows, which a tag's reserve must not cost it. */
export interface TaggableHeading {
  readonly row: string;
  /** The counter or outcome fact the row shows beside its subject, if any. */
  readonly fact: string | undefined;
  /** Whether the row shows its tool's name, and action, whole. */
  readonly identityComplete: boolean;
}

/**
 * A one-row heading laid out at a width, keeping its subject at least `subjectMinimum` columns
 * (or whole, if shorter) beside a fact.
 */
export type TaggableLayout<Layout extends TaggableHeading> = (
  width: number,
  subjectMinimum: number,
) => Layout;

/**
 * A one-row heading laid out beside its expansion tag, so the tag never overlaps it. The layout
 * gets the room a bare `▸` leaves; where that would drop the first fact the row shows untagged, the
 * reserve comes out of the subject's minimum instead. The full `▸ label` from 80 columns is drawn
 * only when the layout it leaves room for is the same row, so the label never costs content. A row
 * whose tool name the tag would cut draws no tag.
 */
export function layoutTaggedHeading<Layout extends TaggableHeading>(
  label: string | undefined,
  theme: Pick<Theme, "fg">,
  width: number,
  layout: TaggableLayout<Layout>,
): Layout {
  const untagged = () => layout(width, SUBJECT_MINIMUM);
  if (label === undefined || width < MIN_TAGGED_WIDTH) return untagged();
  const room = width - BARE_TAG_RESERVE;
  let bare = layout(room, SUBJECT_MINIMUM);
  if (!bare.identityComplete) return untagged();
  if (bare.fact === undefined && untagged().fact !== undefined) {
    const tight = layout(room, Math.max(1, SUBJECT_MINIMUM - BARE_TAG_RESERVE));
    if (tight.fact !== undefined) bare = tight;
  }
  const reserve = labelTagReserve(label, width);
  const full =
    reserve === undefined || reserve >= width
      ? undefined
      : layout(width - reserve, SUBJECT_MINIMUM);
  const chosen = full !== undefined && full.row === bare.row ? full : bare;
  return { ...chosen, row: placeHeadingTag(chosen.row, label, theme, width) };
}

/** Rows with the tag on the first; rows that draw nothing gain no row for it. */
export function tagFirstRow(
  rows: readonly string[],
  label: string | undefined,
  theme: Pick<Theme, "fg">,
  width: number,
): string[] {
  const [first, ...rest] = rows;
  return first === undefined || label === undefined
    ? [...rows]
    : [placeHeadingTag(first, label, theme, width), ...rest];
}
