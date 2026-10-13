import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clipToWidth } from "../manager/chrome.ts";
import { managerTone } from "../manager/style.ts";

type Tone = Parameters<Theme["fg"]>[0];

export interface ActivityStatusPart {
  readonly text: string;
  readonly drop?: number;
  readonly clip?: number;
}
export const STATUS_DROP = { state: 1, progress: 2, elapsed: 3 } as const;

const MINIMUM_TITLE_WIDTH = 14;
const PROFILE_RESERVE_WIDTH = 12;

export interface ActivityRowVisual {
  readonly kind: string;
  readonly title: string;
  readonly continuations: readonly boolean[];
  readonly children: number;
  readonly expanded: boolean;
  readonly glyph: string;
  readonly color: Tone;
  readonly typeColor: Tone;
  readonly status: readonly ActivityStatusPart[];
  readonly statusSeparator?: string;
  readonly statusColor: Tone;
  readonly compactStatus?: boolean;
  readonly profile?: string;
  readonly route?: string;
  readonly awaited?: boolean;
  readonly omittedChildren?: number;
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
  const kept = parts.filter((part) => part.text.length > 0);
  const text = () => kept.map((part) => part.text).join(separator);
  while (visibleWidth(text()) > budget) {
    const found = mostDroppable(kept);
    if (!found) break;
    const { index, part } = found;
    const room = budget - (visibleWidth(text()) - visibleWidth(part.text));
    if (part.clip !== undefined && room >= part.clip) {
      kept[index] = { text: clipToWidth(part.text, room, "…") };
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
  readonly fold: string;
  readonly omitted: string;
}

const rowMarkers = (row: ActivityRowVisual, interactive: boolean): RowMarkers => {
  if (!interactive)
    return {
      continuations: row.continuations.slice(1),
      awaited: row.awaited ? "◎ " : "",
      fold: "",
      omitted: "",
    };
  return {
    continuations: row.continuations,
    awaited: row.awaited ? "◎ " : "  ",
    fold: row.children ? (row.expanded ? "▾ " : "▸ ") : "  ",
    omitted: row.omittedChildren ? ` · ≥${row.omittedChildren} omitted` : "",
  };
};

const minimumLeftWidth = (
  row: ActivityRowVisual,
  { continuations, awaited, fold, omitted }: RowMarkers,
  profileName: string,
): number =>
  visibleWidth(treeGuide(continuations, Math.min(12, continuations.length))) +
  visibleWidth(fold) +
  visibleWidth(awaited) +
  2 +
  (row.kind ? visibleWidth(row.kind) + 1 : 0) +
  (profileName ? Math.min(PROFILE_RESERVE_WIDTH, visibleWidth(profileName) + 3) : 0) +
  Math.min(MINIMUM_TITLE_WIDTH, visibleWidth(`${row.title}${omitted}`));

const statusColumnWidth = (
  row: ActivityRowVisual,
  status: string,
  width: number,
  rightBudget: number,
): number | undefined => {
  if (status.length === 0 || rightBudget < Math.min(9, visibleWidth(status))) return undefined;
  if (width < 48 && !(row.compactStatus && width >= 32)) return undefined;
  return Math.min(visibleWidth(status), rightBudget);
};

const rowRoute = (
  row: ActivityRowVisual,
  interactive: boolean,
  width: number,
  leftWidth: number,
  paint: Paint,
): string =>
  !interactive && width >= 100 && row.route
    ? paint("muted", clipToWidth(row.route, Math.floor(leftWidth / 2), "…"))
    : "";

const rowName = (
  row: ActivityRowVisual,
  interactive: boolean,
  profile: string,
  paint: Paint,
  focusedStyle: ((text: string) => string) | undefined,
): string => {
  const kind = row.kind ? `${row.kind} ` : "";
  if (focusedStyle) return focusedStyle(`${kind}${profile}${row.title}`);
  const recede = row.history && interactive ? "muted" : undefined;
  const identityTone = recede ?? (interactive ? managerTone.identity : undefined);
  return `${paint(recede ?? row.typeColor, kind)}${paint(identityTone ?? "muted", profile)}${paint(identityTone ?? "text", row.title)}`;
};

export function renderActivityRow(
  row: ActivityRowVisual,
  width: number,
  theme: Pick<Theme, "fg"> | undefined,
  presentation: "manager" | "widget",
  focusedStyle?: (text: string) => string,
): string {
  const interactive = presentation === "manager";
  const paint: Paint = (tone, text) => theme?.fg(tone, text) ?? text;
  const markers = rowMarkers(row, interactive);
  const { continuations, awaited, fold, omitted } = markers;
  const markerWidth = visibleWidth(awaited);
  const profileName = row.profile ?? "";
  const identityWidth = visibleWidth(row.kind) + (profileName ? visibleWidth(profileName) + 1 : 0);
  const status = fitStatus(
    row.status,
    row.statusSeparator ?? " · ",
    width - minimumLeftWidth(row, markers, profileName) - 2,
  );
  const rightWidth = statusColumnWidth(
    row,
    status,
    width,
    Math.max(0, width - identityWidth - markerWidth - 6),
  );
  const leftWidth = Math.max(0, width - (rightWidth === undefined ? 0 : rightWidth + 2));
  const guideBudget = Math.max(0, leftWidth - identityWidth - markerWidth - 3);
  const levels = Math.min(12, Math.max(0, Math.floor((guideBudget - visibleWidth(fold) - 2) / 3)));
  const guide = paint(
    "dim",
    clipToWidth(`${treeGuide(continuations, levels)}${fold}`, guideBudget, ""),
  );
  const glyph = paint(row.color, row.glyph);
  const profile = profileName ? `${profileName} · ` : "";
  const route = rowRoute(row, interactive, width, leftWidth, paint);
  const routeWidth = route ? visibleWidth(route) + 2 : 0;
  const name = rowName(row, interactive, profile, paint, focusedStyle);
  const identity = clipToWidth(
    `${guide}${paint("accent", awaited)}${glyph} ${name}${paint("dim", omitted)}`,
    Math.max(0, leftWidth - routeWidth),
    "…",
  );
  const left = route ? `${identity}  ${route}` : identity;
  return rightWidth === undefined
    ? left
    : `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth))}${paint(row.statusColor, clipToWidth(status, rightWidth, "…"))}`;
}
