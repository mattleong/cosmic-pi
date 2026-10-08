import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clipToWidth } from "../manager/chrome.ts";
import { managerTone } from "../manager/style.ts";

type Tone = Parameters<Theme["fg"]>[0];

/** One status fragment. Parts without a `drop` rank, such as attention notices, always stay. */
export interface ActivityStatusPart {
  readonly text: string;
  /** When the row is short, the highest rank goes first; equal ranks go from the end. */
  readonly drop?: number;
  /** Clip to the room left, down to this many columns, before dropping the part. */
  readonly clip?: number;
}
/** Drop ranks: elapsed time goes first, then progress, then phase counts, then a row's own state. */
export const STATUS_DROP = { state: 1, phases: 2, progress: 3, elapsed: 4 } as const;

/**
 * Title columns kept after the kind label before optional status parts are shown; a shorter title
 * reserves only its own width, with any omitted-children suffix.
 */
const MINIMUM_TITLE_WIDTH = 14;
/** At most this many columns of a profile name, with its separator, join the reserved identity. */
const PROFILE_RESERVE_WIDTH = 12;

/** Visual fields only: phase rows are presentation, not provider items or capabilities. */
export interface ActivityRowVisual {
  readonly kind: string;
  readonly title: string;
  /**
   * Whether another sibling follows each ancestor level; the widget drops the first, section
   * level, since it shows no section rows.
   */
  readonly continuations: readonly boolean[];
  readonly children: number;
  readonly expanded: boolean;
  readonly glyph: string;
  readonly color: Tone;
  readonly typeColor: Tone;
  readonly status: readonly ActivityStatusPart[];
  /** Joins status parts; defaults to " · ". */
  readonly statusSeparator?: string;
  readonly statusColor: Tone;
  readonly compactStatus?: boolean;
  readonly profile?: string;
  readonly route?: string;
  readonly awaited?: boolean;
  readonly omittedChildren?: number;
  /** Declared work that has not started: the whole identity recedes. */
  readonly dim?: boolean;
  /** Settled history in the manager: the identity recedes while status tones stay. */
  readonly history?: boolean;
}

const treeGuide = (continuations: readonly boolean[], levels: number): string => {
  const clipped = continuations.length > levels;
  const shown = levels > 0 ? continuations.slice(-levels) : [];
  return `${clipped ? "… " : ""}${shown
    .map((continues, index) =>
      index === shown.length - 1 ? (continues ? "├─ " : "└─ ") : continues ? "│  " : "   ",
    )
    .join("")}`;
};

/**
 * Keeps every required part, clipping or dropping optional parts by rank until the status fits
 * `budget`.
 */
const fitStatus = (
  parts: readonly ActivityStatusPart[],
  separator: string,
  budget: number,
): string => {
  const kept = parts.filter((part) => part.text.length > 0);
  const text = () => kept.map((part) => part.text).join(separator);
  while (visibleWidth(text()) > budget) {
    let dropped = -1;
    for (let index = kept.length - 1; index >= 0; index--)
      if ((kept[index]!.drop ?? 0) > (dropped < 0 ? 0 : (kept[dropped]!.drop ?? 0)))
        dropped = index;
    if (dropped < 0) break;
    const part = kept[dropped]!;
    const room = budget - (visibleWidth(text()) - visibleWidth(part.text));
    if (part.clip !== undefined && room >= part.clip) {
      kept[dropped] = { text: clipToWidth(part.text, room, "…") };
      break;
    }
    kept.splice(dropped, 1);
  }
  return text();
};

/**
 * Shared source/workflow row geometry, clipping and semantic theme treatment. The tree guide,
 * glyph, kind and the start of the title keep their columns before optional status parts do;
 * required parts may still take the title's space, as they always could.
 */
export function renderActivityRow(
  row: ActivityRowVisual,
  width: number,
  theme: Pick<Theme, "fg"> | undefined,
  presentation: "manager" | "widget",
  focusedStyle?: (text: string) => string,
): string {
  const interactive = presentation === "manager";
  const continuations = interactive ? row.continuations : row.continuations.slice(1);
  const paint = (tone: Tone, text: string) => theme?.fg(tone, text) ?? text;
  const awaited = row.awaited ? "◎ " : interactive ? "  " : "";
  const fold = interactive ? (row.children ? (row.expanded ? "▾ " : "▸ ") : "  ") : "";
  const markerWidth = visibleWidth(awaited);
  const profileName = row.profile ?? "";
  const identityWidth = visibleWidth(row.kind) + (profileName ? visibleWidth(profileName) + 1 : 0);
  const omitted = interactive && row.omittedChildren ? ` · ≥${row.omittedChildren} omitted` : "";
  const minimumLeft =
    visibleWidth(treeGuide(continuations, Math.min(12, continuations.length))) +
    visibleWidth(fold) +
    markerWidth +
    2 +
    (row.kind ? visibleWidth(row.kind) + 1 : 0) +
    (profileName ? Math.min(PROFILE_RESERVE_WIDTH, visibleWidth(profileName) + 3) : 0) +
    Math.min(MINIMUM_TITLE_WIDTH, visibleWidth(`${row.title}${omitted}`));
  const status = fitStatus(row.status, row.statusSeparator ?? " · ", width - minimumLeft - 2);
  const rightBudget = Math.max(0, width - identityWidth - markerWidth - 6);
  const showStatus =
    status.length > 0 &&
    (width >= 48 || (row.compactStatus && width >= 32)) &&
    rightBudget >= Math.min(9, visibleWidth(status));
  const rightWidth = showStatus ? Math.min(visibleWidth(status), rightBudget) : 0;
  const leftWidth = Math.max(0, width - (showStatus ? rightWidth + 2 : 0));
  const guideBudget = Math.max(0, leftWidth - identityWidth - markerWidth - 3);
  const levels = Math.min(12, Math.max(0, Math.floor((guideBudget - visibleWidth(fold) - 2) / 3)));
  const guide = paint(
    "dim",
    clipToWidth(`${treeGuide(continuations, levels)}${fold}`, guideBudget, ""),
  );
  const glyph = paint(row.color, row.glyph);
  const profile = profileName ? `${profileName} · ` : "";
  const route =
    !interactive && width >= 100 && row.route
      ? paint("muted", clipToWidth(row.route, Math.floor(leftWidth / 2), "…"))
      : "";
  const routeWidth = route ? visibleWidth(route) + 2 : 0;
  const kind = row.kind ? `${row.kind} ` : "";
  const recede = row.dim ? "dim" : row.history && interactive ? "muted" : undefined;
  const identityTone = recede ?? (interactive ? managerTone.identity : undefined);
  const name = focusedStyle
    ? focusedStyle(`${kind}${profile}${row.title}`)
    : `${paint(recede ?? row.typeColor, kind)}${paint(identityTone ?? "muted", profile)}${paint(identityTone ?? "text", row.title)}`;
  const identity = clipToWidth(
    `${guide}${paint("accent", awaited)}${glyph} ${name}${paint("dim", omitted)}`,
    Math.max(0, leftWidth - routeWidth),
    "…",
  );
  const left = route ? `${identity}  ${route}` : identity;
  return showStatus
    ? `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth))}${paint(row.statusColor, clipToWidth(status, rightWidth, "…"))}`
    : left;
}
