import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clipToWidth } from "../manager/chrome.ts";
import { managerTone } from "../manager/style.ts";

type Tone = Parameters<Theme["fg"]>[0];

/** Visual fields only: phase rows are presentation, not provider items or capabilities. */
export interface ActivityRowVisual {
  readonly kind: string;
  readonly title: string;
  readonly continuations: readonly boolean[];
  readonly children: number;
  readonly expanded: boolean;
  readonly glyph: string;
  readonly color: Tone;
  readonly typeColor: Tone;
  readonly status: string;
  readonly statusColor: Tone;
  readonly compactStatus?: boolean;
  readonly profile?: string;
  readonly route?: string;
  readonly awaited?: boolean;
  readonly omittedChildren?: number;
  /** Declared work that has not started: the whole identity recedes. */
  readonly dim?: boolean;
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

/** Shared source/workflow row geometry, clipping and semantic theme treatment. */
export function renderActivityRow(
  row: ActivityRowVisual,
  width: number,
  theme?: Pick<Theme, "fg">,
  presentation: "manager" | "widget" = "manager",
  focusedStyle?: (text: string) => string,
): string {
  const interactive = presentation === "manager";
  const paint = (tone: Tone, text: string) => theme?.fg(tone, text) ?? text;
  const awaited = row.awaited ? "◎ " : interactive ? "  " : "";
  const fold = interactive ? (row.children ? (row.expanded ? "▾ " : "▸ ") : "  ") : "";
  const markerWidth = visibleWidth(awaited);
  const profileName = row.profile ?? "";
  const identityWidth = visibleWidth(row.kind) + (profileName ? visibleWidth(profileName) + 1 : 0);
  const rightBudget = Math.max(0, width - identityWidth - markerWidth - 6);
  const showStatus =
    row.status.length > 0 &&
    (width >= 48 || (row.compactStatus && width >= 32)) &&
    rightBudget >= Math.min(9, visibleWidth(row.status));
  const rightWidth = showStatus ? Math.min(visibleWidth(row.status), rightBudget) : 0;
  const leftWidth = Math.max(0, width - (showStatus ? rightWidth + 2 : 0));
  const guideBudget = Math.max(0, leftWidth - identityWidth - markerWidth - 3);
  const levels = Math.min(12, Math.max(0, Math.floor((guideBudget - visibleWidth(fold) - 2) / 3)));
  const guide = paint(
    "dim",
    clipToWidth(`${treeGuide(row.continuations, levels)}${fold}`, guideBudget, ""),
  );
  const glyph = paint(row.color, row.glyph);
  const profile = profileName ? `${profileName} · ` : "";
  const omitted = interactive && row.omittedChildren ? ` · ≥${row.omittedChildren} omitted` : "";
  const route =
    !interactive && width >= 100 && row.route
      ? paint("muted", clipToWidth(row.route, Math.floor(leftWidth / 2), "…"))
      : "";
  const routeWidth = route ? visibleWidth(route) + 2 : 0;
  const kind = row.kind ? `${row.kind} ` : "";
  const identityTone = row.dim ? "dim" : interactive ? managerTone.identity : undefined;
  const name = focusedStyle
    ? focusedStyle(`${kind}${profile}${row.title}`)
    : `${paint(row.dim ? "dim" : row.typeColor, kind)}${paint(identityTone ?? "muted", profile)}${paint(identityTone ?? "text", row.title)}`;
  const identity = clipToWidth(
    `${guide}${paint("accent", awaited)}${glyph} ${name}${paint("dim", omitted)}`,
    Math.max(0, leftWidth - routeWidth),
    "…",
  );
  const left = route ? `${identity}  ${route}` : identity;
  return showStatus
    ? `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth))}${paint(row.statusColor, clipToWidth(row.status, rightWidth, "…"))}`
    : left;
}
