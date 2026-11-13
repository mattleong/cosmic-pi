import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { clipToWidth } from "../manager/chrome.ts";
import { managerTone } from "../manager/style.ts";

type Tone = Parameters<Theme["fg"]>[0];

export interface ActivityStatusPart {
  readonly text: string;
  /** Higher numbers give way first when the status column is cramped. */
  readonly drop?: number;
  readonly clip?: number;
  /** Shown before `text` only when another part precedes it, such as `· ` before an elapsed time. */
  readonly lead?: string;
}
export const STATUS_DROP = { state: 1, progress: 2, elapsed: 3, waitWord: 4 } as const;

// A title keeps at least this many columns, ellipsis included, before an identity moves below it.
const TITLE_FLOOR = 12;

export interface ActivityRowVisual {
  /** A quiet word after the title saying what the row is, when its profile doesn't. */
  readonly kind: string;
  readonly title: string;
  readonly continuations: readonly boolean[];
  readonly children: number;
  readonly expanded: boolean;
  readonly glyph: string;
  readonly color: Tone;
  readonly status: readonly ActivityStatusPart[];
  readonly statusSeparator?: string;
  readonly statusColor: Tone;
  readonly profile?: string;
  /** An agent's model: `label` adds effort and qualifiers to `name` (`provider/model`). */
  readonly model?: { readonly name: string; readonly label: string };
  readonly awaited?: boolean;
  readonly omittedChildren?: number;
  readonly history?: boolean;
  /** Live progress after the name, such as a task's latest output line; dropped when cramped. */
  readonly activity?: string | undefined;
}

const MINIMUM_ACTIVITY_WIDTH = 8;

// Every tree uses three-column connectors. In the manager a branch's fold marker takes the
// connector's second stroke (`├▾ `, `└▸ `), so glyphs line up whether or not a row has children.
const GUIDE_WIDTH = 3;
const through = (continues: boolean) => (continues ? "│  " : "   ");
const treeGuide = (
  continuations: readonly boolean[],
  levels: number,
  fold: string | undefined,
): string => {
  const clipped = continuations.length > levels;
  const shown = levels > 0 ? continuations.slice(-levels) : [];
  const stroke = fold !== undefined && Str.isNonEmpty(fold) ? fold : "─";
  const last = (continues: boolean) => `${continues ? "├" : "└"}${stroke} `;
  const root = fold && shown.length === 0 ? `${fold} ` : "";
  return `${clipped ? "… " : ""}${root}${Arr.join(
    Arr.map(shown, (continues, index) =>
      index === shown.length - 1 ? last(continues) : through(continues),
    ),
    "",
  )}`;
};
/** The guide beneath a row: its ancestors' rules continue, and so does its own branch. */
const continuationGuide = (continuations: readonly boolean[], levels: number): string => {
  const shown = levels > 0 ? continuations.slice(-levels) : [];
  return `${continuations.length > levels ? "  " : ""}${Arr.join(Arr.map(shown, through), "")}`;
};
const guideLevels = (continuations: readonly boolean[], budget: number): number => {
  const all = Math.min(12, continuations.length);
  if (all * GUIDE_WIDTH <= budget) return all;
  return Math.min(all, Math.max(0, Math.floor((budget - 2) / GUIDE_WIDTH)));
};

const mostDroppable = (parts: readonly ActivityStatusPart[]) => {
  let found: { readonly index: number; readonly part: ActivityStatusPart } | undefined;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part && (part.drop ?? 0) > (found?.part.drop ?? 0)) found = { index, part };
  }
  return found;
};

const fitStatus = (
  parts: readonly ActivityStatusPart[],
  separator: string,
  budget: number,
): string => {
  const kept = Arr.filter(parts, (part) => part.text.length > 0);
  const text = () =>
    Arr.join(
      Arr.map(kept, (part, index) => (index === 0 ? part.text : `${part.lead ?? ""}${part.text}`)),
      separator,
    );
  while (visibleWidth(text()) > budget) {
    const found = mostDroppable(kept);
    if (!found) break;
    const { index, part } = found;
    const room = budget - (visibleWidth(text()) - visibleWidth(part.text));
    if (part.clip !== undefined && room >= part.clip) {
      kept[index] = { ...part, text: clipToWidth(part.text, room, "…") };
      break;
    }
    kept.splice(index, 1);
  }
  return text();
};

type Paint = (tone: Tone, text: string) => string;

interface RowMarkers {
  readonly continuations: readonly boolean[];
  readonly awaited: string;
  /** The manager's fold marker, empty for a leaf; undefined in the widget, which never folds. */
  readonly fold: string | undefined;
  readonly omitted: string;
}

const rowMarkers = (row: ActivityRowVisual, interactive: boolean): RowMarkers => ({
  continuations: interactive ? row.continuations : row.continuations.slice(1),
  awaited: row.awaited ? "◎ " : "",
  fold: interactive ? (row.children ? (row.expanded ? "▾" : "▸") : "") : undefined,
  omitted: interactive && row.omittedChildren ? ` · ≥${row.omittedChildren} omitted` : "",
});

const joinIdentity = (profile: string | undefined, model: string): string =>
  profile ? `${profile} → ${model}` : model;

/**
 * What follows the title quietly, widest first: the profile, or the row's kind when it has none,
 * then for an agent the model it runs on. As room runs out the model's qualifiers go first, then
 * the profile; the `provider/model` itself stays. Variants that keep the profile come first.
 */
const rowSuffixes = (row: ActivityRowVisual): readonly string[] => {
  const { model, profile } = row;
  if (!model) return [profile ?? row.kind];
  const withProfile = Arr.dedupe([
    joinIdentity(profile, model.label),
    joinIdentity(profile, model.name),
  ]);
  return profile ? [...withProfile, model.name] : withProfile;
};

const statusColumnWidth = (
  status: string,
  width: number,
  rightBudget: number,
): number | undefined => {
  if (status.length === 0 || rightBudget < Math.min(9, visibleWidth(status))) return undefined;
  if (width < 32) return undefined;
  return Math.min(visibleWidth(status), rightBudget);
};

interface RowLayout {
  readonly row: ActivityRowVisual;
  readonly interactive: boolean;
  readonly paint: Paint;
  readonly focusedStyle: ((text: string) => string) | undefined;
  readonly omitted: string;
}

const quietName = (
  { row, interactive, paint, focusedStyle, omitted }: RowLayout,
  title: string,
  suffix: string,
): string => {
  const quiet = suffix ? ` · ${suffix}` : "";
  if (focusedStyle) return `${focusedStyle(`${title}${quiet}`)}${paint("dim", omitted)}`;
  const recede = row.history && interactive ? "muted" : undefined;
  const identityTone = recede ?? (interactive ? managerTone.identity : "text");
  return `${paint(identityTone, title)}${paint("dim", omitted)}${paint(recede ?? "muted", quiet)}`;
};

const nameWidth = (title: string, omitted: string, suffix: string): number =>
  visibleWidth(title) + visibleWidth(omitted) + (suffix ? visibleWidth(suffix) + 3 : 0);

type NameFit =
  | {
      readonly lines: 1;
      readonly title: string;
      readonly suffix: string;
      readonly activity: string;
    }
  | { readonly lines: 2; readonly title: string; readonly suffix: string };

/**
 * Fits the title and its identity into `room`. Live activity gives way first, then the model's
 * qualifiers, then the profile, then the title shortens to its floor. Past that the manager moves
 * the identity to a continuation line so `provider/model` is never cut; the widget, which keeps
 * one line per row, cuts the title further and the model only as a last resort.
 */
const fitName = (
  layout: RowLayout,
  room: number,
  activityRoom: (used: number) => number,
): NameFit => {
  const { row, omitted, interactive } = layout;
  const suffixes = rowSuffixes(row);
  const narrowest = suffixes.at(-1) ?? "";
  const fits = (suffix: string) => nameWidth(row.title, omitted, suffix) <= room;
  // Live activity outranks the model's qualifiers but not the profile.
  const withProfile = row.model && row.profile ? suffixes.slice(0, -1) : suffixes;
  if (row.activity) {
    const busy = Arr.findFirst(
      withProfile,
      (suffix) =>
        fits(suffix) &&
        activityRoom(nameWidth(row.title, omitted, suffix)) >= MINIMUM_ACTIVITY_WIDTH,
    );
    if (Option.isSome(busy)) {
      const used = nameWidth(row.title, omitted, busy.value);
      return {
        lines: 1,
        title: row.title,
        suffix: busy.value,
        activity: clipToWidth(row.activity, activityRoom(used), "…"),
      };
    }
  }
  const whole = Arr.findFirst(suffixes, fits);
  if (Option.isSome(whole))
    return { lines: 1, title: row.title, suffix: whole.value, activity: "" };
  const titleRoom = room - nameWidth("", omitted, narrowest);
  const floor = Math.min(TITLE_FLOOR, visibleWidth(row.title));
  if (titleRoom >= floor || (!interactive && titleRoom >= 2))
    return {
      lines: 1,
      title: clipToWidth(row.title, titleRoom, "…"),
      suffix: narrowest,
      activity: "",
    };
  if (interactive) return { lines: 2, title: row.title, suffix: narrowest };
  return { lines: 1, title: row.title, suffix: narrowest, activity: "" };
};

const minimumLeftWidth = (
  layout: RowLayout,
  guide: string,
  awaited: string,
  suffix: string,
): number =>
  visibleWidth(guide) +
  visibleWidth(awaited) +
  2 +
  // The manager can move the identity below the title, so only the widget reserves room for it,
  // ahead of the status: `provider/model` stays whole.
  (!layout.interactive && suffix ? visibleWidth(suffix) + 3 : 0) +
  Math.min(TITLE_FLOOR, nameWidth(layout.row.title, layout.omitted, ""));

const padTo = (text: string, width: number): string =>
  `${text}${Fn.pipe(" ", Str.repeat(Math.max(0, width - visibleWidth(text))))}`;

/**
 * One Activity row: tree guide, glyph, title, identity, and a right-aligned status. In the
 * manager a row that can't keep its whole `provider/model` beside a readable title takes a
 * second line for the identity.
 */
export function renderActivityRowLines(
  row: ActivityRowVisual,
  width: number,
  theme: Pick<Theme, "fg"> | undefined,
  presentation: "manager" | "widget",
  focusedStyle?: (text: string) => string,
): readonly string[] {
  const interactive = presentation === "manager";
  const paint: Paint = (tone, text) => theme?.fg(tone, text) ?? text;
  const { continuations, awaited, fold, omitted } = rowMarkers(row, interactive);
  const layout: RowLayout = { row, interactive, paint, focusedStyle, omitted };
  const markerWidth = visibleWidth(awaited);
  const narrowest = rowSuffixes(row).at(-1) ?? "";
  const fullGuide = treeGuide(continuations, Math.min(12, continuations.length), fold);
  const statusBudget = width - minimumLeftWidth(layout, fullGuide, awaited, narrowest) - 2;
  const status = fitStatus(row.status, row.statusSeparator ?? " · ", statusBudget);
  const rightWidth = statusColumnWidth(status, width, Math.max(0, statusBudget));
  const leftWidth = Math.max(0, width - (rightWidth === undefined ? 0 : rightWidth + 2));
  const levels = guideLevels(
    continuations,
    leftWidth - markerWidth - 2 - Math.min(TITLE_FLOOR, visibleWidth(row.title)),
  );
  const guide = treeGuide(continuations, levels, fold);
  const prefixWidth = visibleWidth(guide) + markerWidth + 2;
  const prefix = `${paint("dim", guide)}${paint("accent", awaited)}${paint(row.color, row.glyph)} `;
  const room = Math.max(0, leftWidth - prefixWidth);
  // Keep one space before the status column so the activity never runs into it.
  const activityRoom = (used: number) => room - used - 3 - Number(rightWidth !== undefined);
  const fit = fitName(layout, room, activityRoom);
  const statusText =
    rightWidth === undefined ? "" : paint(row.statusColor, clipToWidth(status, rightWidth, "…"));
  const withStatus = (left: string) =>
    rightWidth === undefined ? left : `${padTo(left, width - rightWidth)}${statusText}`;
  if (fit.lines === 1) {
    const activity = fit.activity ? paint("muted", ` · ${fit.activity}`) : "";
    const name = quietName(layout, fit.title, fit.suffix);
    return [withStatus(clipToWidth(`${prefix}${name}${activity}`, leftWidth, "…"))];
  }
  const title = clipToWidth(
    `${prefix}${quietName(layout, clipToWidth(row.title, Math.max(1, room - visibleWidth(omitted)), "…"), "")}`,
    leftWidth,
    "…",
  );
  // Beneath the row its own children's branch continues from the glyph column.
  const below = padTo(
    `${continuationGuide(continuations, levels)}${row.children && row.expanded ? "│" : ""}`,
    prefixWidth,
  );
  const identityRoom = Math.max(1, width - prefixWidth);
  const identity = Option.getOrElse(
    Arr.findFirst(rowSuffixes(row), (suffix) => visibleWidth(suffix) <= identityRoom),
    () => clipToWidth(narrowest, identityRoom, "…"),
  );
  const quiet = focusedStyle ? focusedStyle(identity) : paint("muted", identity);
  return [withStatus(title), `${paint("dim", below)}${quiet}`];
}
