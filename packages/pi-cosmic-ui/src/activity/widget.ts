import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerNoticeGlyph,
} from "../manager/chrome.ts";
import type { ActivityRow } from "./model.ts";
import {
  activityPath,
  activityTree,
  needsYou,
  type ActivityTreeOptions,
  type ActivityTreeRow,
} from "./tree.ts";

export const activityGlyph = (row: ActivityRow, now = 0): string =>
  row.status === "needs-input" || row.status === "blocked"
    ? managerNoticeGlyph("warning")
    : managerActivityGlyph(
        row.status === "cancelled" ? "stopped" : row.status,
        Math.floor(now / 100),
      );
export const activityStatus = (row: ActivityRow): string =>
  row.status === "needs-input" ? "waiting" : row.status;
export const activityElapsed = (row: ActivityRow, now?: number, compact = false): string => {
  if (row.startedAt === undefined) return "";
  const seconds = Math.floor(
    Math.max(0, (row.endedAt ?? now ?? row.updatedAt ?? row.startedAt) - row.startedAt) / 1000,
  );
  return seconds < 60
    ? `${seconds}s`
    : compact || seconds % 60 === 0
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
export const activityType = (row: ActivityRow): string =>
  row.kind === "agent" ? "SUBAGENT" : row.kind === "command" ? "TASK" : "QUESTION";
export function activityOwnerLabel(
  rows: readonly ActivityRow[],
  row: ActivityRow,
  width?: number,
): string {
  const parts = activityPath(rows, row.key).map((item) => item.title);
  const full = parts.join(" › ");
  if (width === undefined || visibleWidth(full) <= width) return full;
  while (parts.length > 1) {
    parts.shift();
    const suffix = `… › ${parts.join(" › ")}`;
    if (visibleWidth(suffix) <= width) return suffix;
  }
  return truncateToWidth(parts[0] ?? "", Math.max(0, width), "…");
}

const treeGuide = (entry: ActivityTreeRow, levels: number): string => {
  const clipped = entry.continuations.length > levels;
  const shown = levels > 0 ? entry.continuations.slice(-levels) : [];
  return `${clipped ? "… " : ""}${shown
    .map((continues, index) =>
      index === shown.length - 1 ? (continues ? "├─ " : "└─ ") : continues ? "│  " : "   ",
    )
    .join("")}`;
};
const foldMarker = (entry: ActivityTreeRow): string =>
  entry.children ? (entry.expanded ? "▾ " : "▸ ") : "  ";
export function activityRowLine(
  entry: ActivityTreeRow,
  width: number,
  now?: number,
  theme?: Pick<Theme, "fg">,
): string {
  const row = entry.row;
  const kind = activityType(row);
  const warnings = entry.expanded
    ? ""
    : [
        entry.attention.waiting ? `${entry.attention.waiting} waiting` : "",
        entry.attention.blocked ? `${entry.attention.blocked} blocked` : "",
        entry.attention.failed ? `${entry.attention.failed} failed` : "",
      ]
        .filter(Boolean)
        .join(" · ");
  const status =
    warnings || `${activityStatus(row)} ${activityElapsed(row, now, width < 60)}`.trim();
  const color =
    row.status === "needs-input" || row.status === "blocked"
      ? "warning"
      : managerActivityColor(row.status === "cancelled" ? "stopped" : row.status);
  const typeColor = row.kind === "agent" ? "accent" : row.kind === "question" ? "warning" : "muted";
  const paint = (tone: Parameters<Theme["fg"]>[0], text: string) => theme?.fg(tone, text) ?? text;
  const profileName = row.kind === "agent" ? (row.profile ?? "") : "";
  const identityWidth = visibleWidth(kind) + (profileName ? visibleWidth(profileName) + 1 : 0);
  const rightBudget = Math.max(0, width - identityWidth - 6);
  const showStatus =
    (width >= 48 || (warnings.length > 0 && width >= 32)) &&
    rightBudget >= Math.min(9, visibleWidth(status));
  const rightWidth = showStatus ? Math.min(visibleWidth(status), rightBudget) : 0;
  const leftWidth = Math.max(0, width - (showStatus ? rightWidth + 2 : 0));
  const guideBudget = Math.max(0, leftWidth - identityWidth - 3);
  const levels = Math.min(12, Math.max(0, Math.floor((guideBudget - 4) / 3)));
  const guide = paint(
    "dim",
    truncateToWidth(`${treeGuide(entry, levels)}${foldMarker(entry)}`, guideBudget, ""),
  );
  const glyph = paint(color, activityGlyph(row, now));
  const profile = profileName ? `${profileName} · ` : "";
  const omitted = row.omittedChildren ? ` · ≥${row.omittedChildren} omitted` : "";
  const left = truncateToWidth(
    `${guide}${glyph} ${paint(typeColor, kind)} ${paint("muted", profile)}${paint("text", row.title)}${paint("dim", omitted)}`,
    leftWidth,
    "…",
  );
  return showStatus
    ? `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth))}${paint(warnings ? "warning" : color, truncateToWidth(status, rightWidth, "…"))}`
    : left;
}
interface WidgetOptions extends ActivityTreeOptions {
  readonly now?: number;
  readonly theme?: Pick<Theme, "fg">;
}
/** A bounded, read-only ownership projection. /activity owns keyboard focus. */
export function renderActivityWidget(
  rows: readonly ActivityRow[],
  width: number,
  maxRows = 8,
  options: WidgetOptions = {},
): string[] {
  if (width <= 0 || rows.length === 0 || maxRows <= 0) return [];
  const tree = activityTree(rows, options);
  const urgent = needsYou(rows);
  const live = tree.filter((entry) => !entry.history);
  const history = tree.filter((entry) => entry.history && entry.depth === 0).length;
  const style = (text: string) => options.theme?.fg("muted", text) ?? text;
  const heading =
    width < 22 && urgent.length
      ? `Needs you: ${urgent.length}`
      : `Activity${urgent.length ? ` · Needs you: ${urgent.length}` : ""}`;
  const hint = visibleWidth(`${heading}  /activity`) <= width ? "  /activity" : "";
  if (live.length === 0) {
    const failed = rows.filter((row) => row.status === "failed").length;
    const summary = `Activity · ${history} finished ${history === 1 ? "branch" : "branches"}${failed ? ` · ${failed} failed` : ""}`;
    const open = visibleWidth(`${summary}  /activity`) <= width ? "  /activity" : "";
    return [truncateToWidth(style(`${summary}${open}`), width, "…")];
  }
  const lines = [style(`${heading}${hint}`)];
  if (urgent.length)
    lines.push(
      style(
        `Needs you: ${activityOwnerLabel(rows, urgent[0]!, Math.max(0, width - 11 - (urgent.length > 1 ? ` +${urgent.length - 1}`.length : 0)))}${urgent.length > 1 ? ` +${urgent.length - 1}` : ""}`,
      ),
    );
  const capacity = Math.max(0, maxRows - lines.length - 1);
  lines.push(
    ...live
      .slice(0, capacity)
      .map((entry) => activityRowLine(entry, width, options.now, options.theme)),
  );
  const hidden = Math.max(0, live.length - capacity);
  const omitted = Math.max(0, ...rows.map((row) => row.omittedHistory ?? 0));
  if (hidden || history || omitted)
    lines.push(
      style(
        `${hidden ? `+${hidden} rows  ` : ""}${history ? `History: ${history} branches` : ""}${omitted ? ` · ≥${omitted} earlier branches omitted` : ""}`,
      ),
    );
  return lines.slice(0, maxRows).map((line) => truncateToWidth(line, width, ""));
}
