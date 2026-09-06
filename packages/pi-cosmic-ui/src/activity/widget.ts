import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerNoticeGlyph,
} from "../manager/chrome.ts";
import {
  activityAttention,
  activityAttentionLabels,
  activityAttentionTotals,
  activityStatus,
} from "./attention.ts";
export { activityStatus } from "./attention.ts";
import { isFinished, type ActivityRow } from "./model.ts";
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
export const activityStartupGlyph = (
  rows: readonly ActivityRow[],
  starting: number,
  now = 0,
): string =>
  starting > 0 && !rows.some((row) => !isFinished(row))
    ? managerActivityGlyph("pending", Math.floor(now / 100))
    : "";
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
  showHistory = true,
): string {
  const row = entry.row;
  const kind = activityType(row);
  const warnings = entry.expanded ? "" : activityAttentionLabels(entry.attention).join(" · ");
  const attention =
    activityAttention(row) !== undefined || row.status === "failed" ? activityStatus(row) : "";
  const status = warnings || `${attention} ${activityElapsed(row, now, width < 60)}`.trim();
  const color =
    row.status === "needs-input" || row.status === "blocked"
      ? "warning"
      : managerActivityColor(row.status === "cancelled" ? "stopped" : row.status);
  const typeColor = row.kind === "agent" ? "accent" : row.kind === "question" ? "warning" : "muted";
  const paint = (tone: Parameters<Theme["fg"]>[0], text: string) => theme?.fg(tone, text) ?? text;
  // Keep the state icon and identity fixed when await ownership changes.
  const awaited = row.awaited ? "◎ " : "  ";
  const markerWidth = visibleWidth(awaited);
  const profileName = row.kind === "agent" ? (row.profile ?? "") : "";
  const identityWidth = visibleWidth(kind) + (profileName ? visibleWidth(profileName) + 1 : 0);
  const rightBudget = Math.max(0, width - identityWidth - markerWidth - 6);
  const showStatus =
    status.length > 0 &&
    (width >= 48 || (warnings.length > 0 && width >= 32)) &&
    rightBudget >= Math.min(9, visibleWidth(status));
  const rightWidth = showStatus ? Math.min(visibleWidth(status), rightBudget) : 0;
  const leftWidth = Math.max(0, width - (showStatus ? rightWidth + 2 : 0));
  const guideBudget = Math.max(0, leftWidth - identityWidth - markerWidth - 3);
  const levels = Math.min(12, Math.max(0, Math.floor((guideBudget - 4) / 3)));
  const guide = paint(
    "dim",
    truncateToWidth(`${treeGuide(entry, levels)}${foldMarker(entry)}`, guideBudget, ""),
  );
  const glyph = paint(color, activityGlyph(row, now));
  const profile = profileName ? `${profileName} · ` : "";
  const omitted = showHistory && row.omittedChildren ? ` · ≥${row.omittedChildren} omitted` : "";
  const left = truncateToWidth(
    `${guide}${paint("accent", awaited)}${glyph} ${paint(typeColor, kind)} ${paint("muted", profile)}${paint("text", row.title)}${paint("dim", omitted)}`,
    leftWidth,
    "…",
  );
  return showStatus
    ? `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth))}${paint(warnings ? "warning" : color, truncateToWidth(status, rightWidth, "…"))}`
    : left;
}
interface WidgetOptions extends ActivityTreeOptions {
  readonly starting?: number;
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
  const starting = options.starting ?? 0;
  if (width <= 0 || (rows.length === 0 && starting === 0) || maxRows <= 0) return [];
  const tree = activityTree(rows, { ...options, hideHistory: true });
  const urgent = needsYou(rows);
  const live = tree.filter((entry) => !entry.history);
  if (live.length === 0 && starting === 0) return [];
  const style = (text: string) => options.theme?.fg("muted", text) ?? text;
  const counts = activityAttentionTotals(rows);
  const attention = activityAttentionLabels({ ...counts, failed: 0 }).join(" · ");
  const heading =
    width < 22 && urgent.length
      ? activityAttentionLabels({ ...counts, parent: 0, blocked: 0, failed: 0 }).join(" · ")
      : `Activity${attention ? ` · ${attention}` : ""}`;
  const startup = activityStartupGlyph(rows, starting, options.now);
  const combined = `${heading}${startup ? ` ${startup}` : ""}`;
  const lines = [style(combined)];
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
      .map((entry) => activityRowLine(entry, width, options.now, options.theme, false)),
  );
  const hidden = Math.max(0, live.length - capacity);
  if (hidden) lines.push(style(`+${hidden} rows`));
  return lines.slice(0, maxRows).map((line) => truncateToWidth(line, width, ""));
}
