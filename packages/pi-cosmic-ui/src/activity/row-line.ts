import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { formatElapsed } from "pi-cosmic-core/display";
import { managerTone } from "../manager/style.ts";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerNoticeColor,
  managerNoticeGlyph,
  clipToWidth,
  spinnerFrameAt,
  type ManagerStatusColor,
} from "../manager/chrome.ts";
import {
  activityAttention,
  activityAttentionColor,
  activityAttentionLabels,
  activityAttentionCounts,
  activityQueued,
  activityStatus,
  addAttention,
} from "./attention.ts";
import type { ActivityRow } from "./model.ts";
import type { GroupedActivityRow } from "./grouped-tree.ts";
import { renderActivityRow, STATUS_DROP, type ActivityStatusPart } from "./row-render.ts";

const REASON_WIDTH = 32;
const REASON_MINIMUM_WIDTH = 10;

export interface ActivityMark {
  readonly glyph: string;
  readonly color: ManagerStatusColor;
}
export const activityMark = (row: ActivityRow, now = 0): ActivityMark => {
  if (row.status === "needs-input")
    return { glyph: managerNoticeGlyph("attention"), color: managerNoticeColor("attention") };
  if (row.status === "blocked") return { glyph: managerNoticeGlyph("warning"), color: "warning" };
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
  return compact ? Str.split(text, " ")[0] : text;
};
const activityTypes = {
  agent: "SUBAGENT",
  command: "TASK",
  question: "QUESTION",
} as const;
export const activityType = (row: ActivityRow): string => activityTypes[row.kind];

const widgetTypeColors = {
  command: "syntaxKeyword",
  agent: "thinkingHigh",
  question: "accent",
} as const;
const managerTypeColors = {
  command: "muted",
  agent: managerTone.identity,
  question: "accent",
} as const;

export interface RowPaint {
  readonly now?: number | undefined;
  readonly theme?: Pick<Theme, "fg">;
}

const memberReason = (row: ActivityRow, widget: boolean): string | undefined =>
  (widget && row.status === "failed") || (row.status === "cancelled" && row.startedAt === undefined)
    ? row.summary === undefined
      ? undefined
      : Str.trim(row.summary)
    : undefined;

const memberAttention = (row: ActivityRow): string =>
  activityAttention(row) !== undefined ||
  row.status === "failed" ||
  row.status === "paused" ||
  activityQueued(row)
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
  const descendants = addAttention(entry.summary.attention, activityAttentionCounts(row), -1);
  const warnings = entry.expanded ? "" : Arr.join(activityAttentionLabels(descendants), " · ");
  const attention = memberAttention(row);
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
      statusColor: warnings
        ? activityAttentionColor(descendants)
        : !interactive && !attention
          ? "muted"
          : color,
      compactStatus: warnings.length > 0,
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
