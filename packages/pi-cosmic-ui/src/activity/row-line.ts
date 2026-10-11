import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatElapsed } from "pi-cosmic-core";
import { managerTone } from "../manager/style.ts";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerNoticeGlyph,
  clipToWidth,
  spinnerFrameAt,
  type ManagerStatusColor,
} from "../manager/chrome.ts";
import {
  activityAttention,
  activityAttentionLabels,
  activityAttentionCounts,
  activityPlanned,
  activityQueued,
  activityStatus,
  addAttention,
} from "./attention.ts";
import { isFinished, type ActivityRow } from "./model.ts";
import type { GroupedActivityRow } from "./grouped-tree.ts";
import { renderActivityRow, STATUS_DROP, type ActivityStatusPart } from "./row-render.ts";

const PLANNED_GLYPH = "◦";
const NOT_RUN_GLYPH = "–";
const REASON_WIDTH = 32;
const REASON_MINIMUM_WIDTH = 10;

export interface ActivityMark {
  readonly glyph: string;
  readonly color: ManagerStatusColor;
}
export const activityMark = (row: ActivityRow, now = 0): ActivityMark => {
  if (activityPlanned(row))
    return { glyph: isFinished(row) ? NOT_RUN_GLYPH : PLANNED_GLYPH, color: "dim" };
  if (row.status === "needs-input" || row.status === "blocked")
    return { glyph: managerNoticeGlyph("warning"), color: "warning" };
  if (activityQueued(row)) return { glyph: "○", color: "muted" };
  const kind = row.status === "cancelled" ? "stopped" : row.status;
  return {
    glyph: managerActivityGlyph(kind, spinnerFrameAt(now)),
    color: managerActivityColor(kind),
  };
};
export const activityElapsed = (row: ActivityRow, now?: number, compact = false): string => {
  if (row.startedAt === undefined) return "";
  const elapsed = Math.max(
    0,
    (row.endedAt ?? now ?? row.updatedAt ?? row.startedAt) - row.startedAt,
  );
  return elapsedLabel(elapsed, compact);
};
export const elapsedLabel = (elapsed: number, compact: boolean): string => {
  const text = formatElapsed(elapsed);
  return compact ? (text.split(" ")[0] ?? text) : text;
};
const activityTypes = {
  agent: "SUBAGENT",
  command: "TASK",
  question: "QUESTION",
  workflow: "WORKFLOW",
} as const;
export const activityType = (row: ActivityRow): string => activityTypes[row.kind];

const widgetTypeColors = {
  command: "syntaxKeyword",
  agent: "thinkingHigh",
  question: "warning",
  workflow: managerTone.identity,
} as const;
const managerTypeColors = {
  command: "muted",
  agent: managerTone.identity,
  question: "warning",
  workflow: managerTone.identity,
} as const;

export interface RowPaint {
  readonly now?: number | undefined;
  readonly theme?: Pick<Theme, "fg">;
}

const memberReason = (row: ActivityRow, widget: boolean): string | undefined =>
  (widget && row.status === "failed") ||
  (row.status === "cancelled" && row.startedAt === undefined && !activityPlanned(row))
    ? row.summary?.trim()
    : undefined;

const memberAttention = (row: ActivityRow, planned: boolean): string =>
  planned || activityAttention(row) !== undefined || row.status === "failed" || activityQueued(row)
    ? activityStatus(row)
    : "";

const memberStatus = (
  row: ActivityRow,
  { warnings, attention, reason }: { warnings: string; attention: string; reason: string },
  width: number,
  now: number | undefined,
): ActivityStatusPart[] => {
  if (warnings) return [{ text: warnings }];
  if (reason)
    return [
      { text: attention, drop: STATUS_DROP.progress },
      { text: reason, drop: STATUS_DROP.state, clip: REASON_MINIMUM_WIDTH },
    ];
  return [
    { text: attention },
    { text: activityElapsed(row, now, width < 60), drop: STATUS_DROP.elapsed },
  ];
};

export function groupedMemberLine(
  entry: Extract<GroupedActivityRow, { readonly type: "member" }>,
  width: number,
  options: RowPaint,
  presentation: "manager" | "widget",
  focusedStyle?: (text: string) => string,
): string {
  const { row } = entry;
  const interactive = presentation === "manager";
  const warnings = entry.expanded
    ? ""
    : activityAttentionLabels(
        addAttention(entry.summary.attention, activityAttentionCounts(row), -1),
      ).join(" · ");
  const planned = activityPlanned(row);
  const attention = memberAttention(row, planned);
  const ended = memberReason(row, !interactive);
  const reason = ended
    ? clipToWidth(ended, Math.min(REASON_WIDTH, Math.floor(width / 3)), "…")
    : "";
  const status = memberStatus(row, { warnings, attention, reason }, width, options.now);
  const { glyph, color } = activityMark(row, options.now);
  return renderActivityRow(
    {
      kind: activityType(row),
      title: row.title,
      continuations: entry.continuations,
      children: entry.children,
      expanded: entry.expanded,
      glyph,
      color,
      typeColor: (interactive ? managerTypeColors : widgetTypeColors)[row.kind],
      status,
      statusSeparator: reason ? " · " : " ",
      statusColor: warnings ? "warning" : !interactive && !attention ? "muted" : color,
      compactStatus: warnings.length > 0,
      ...(planned && { dim: true }),
      ...(entry.history && { history: true }),
      ...(row.kind === "agent" && row.profile && { profile: row.profile }),
      ...(row.route && { route: row.route }),
      ...(row.awaited && { awaited: true }),
      ...(row.omittedChildren && { omittedChildren: row.omittedChildren }),
    },
    width,
    options.theme,
    presentation,
    focusedStyle,
  );
}
