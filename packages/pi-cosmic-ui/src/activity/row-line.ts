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
  type ActivityAttentionCounts,
} from "./attention.ts";
import { isFinished, type ActivityRow } from "./model.ts";
import type { ActivityTreeRow } from "./tree.ts";
import type { GroupedActivityRow } from "./grouped-tree.ts";
import type { GroupSummary } from "./group-summary.ts";
import { renderActivityRow, STATUS_DROP, type ActivityStatusPart } from "./row-render.ts";

/** Planned work has a static glyph; once its owner ends, it reads like a skipped phase. */
const PLANNED_GLYPH = "◦";
const NOT_RUN_GLYPH = "–";
/** A failure reason takes at most a third of a widget row, and never more than these columns. */
const REASON_WIDTH = 32;
/** A reason clipped narrower than this says too little, so it gives way instead. */
const REASON_MINIMUM_WIDTH = 10;

export const activityGlyph = (row: ActivityRow, now = 0): string =>
  activityPlanned(row)
    ? isFinished(row)
      ? NOT_RUN_GLYPH
      : PLANNED_GLYPH
    : row.status === "needs-input" || row.status === "blocked"
      ? managerNoticeGlyph("warning")
      : activityQueued(row)
        ? "○"
        : managerActivityGlyph(
            row.status === "cancelled" ? "stopped" : row.status,
            spinnerFrameAt(now),
          );
/** Whole-second elapsed time; narrow rows keep only the largest unit ("2m"). */
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

// Use theme palette tokens for blue, violet, and amber rather than fixed RGB colors.
export const widgetTypeColors = {
  command: "syntaxKeyword",
  agent: "thinkingHigh",
  question: "warning",
  workflow: managerTone.identity,
} as const;
export const managerTypeColors = {
  command: "muted",
  agent: managerTone.identity,
  question: "warning",
  workflow: managerTone.identity,
} as const;

export const activityColor = (row: ActivityRow, interactive: boolean): ManagerStatusColor =>
  activityPlanned(row)
    ? "dim"
    : row.status === "needs-input" || row.status === "blocked"
      ? "warning"
      : activityQueued(row)
        ? "muted"
        : !interactive && row.status === "running"
          ? "accent"
          : managerActivityColor(row.status === "cancelled" ? "stopped" : row.status);

/**
 * A source row. A collapsed branch shows its descendants' attention instead of its own state. A
 * `reason`, such as a failed member's summary, replaces elapsed time beside the row's state.
 */
export function activityRowLine(
  entry: ActivityTreeRow & { readonly reason?: string },
  width: number,
  now?: number,
  theme?: Pick<Theme, "fg">,
  presentation: "manager" | "widget" = "manager",
  focusedStyle?: (text: string) => string,
): string {
  const row = entry.row;
  const interactive = presentation === "manager";
  const warnings = entry.expanded ? "" : activityAttentionLabels(entry.attention).join(" · ");
  const planned = activityPlanned(row);
  const attention =
    planned ||
    activityAttention(row) !== undefined ||
    row.status === "failed" ||
    activityQueued(row)
      ? activityStatus(row)
      : "";
  const reason = entry.reason
    ? clipToWidth(entry.reason, Math.min(REASON_WIDTH, Math.floor(width / 3)), "…")
    : "";
  // The failed glyph already says what happened, so the reason outlasts the state word.
  const status: ActivityStatusPart[] = warnings
    ? [{ text: warnings }]
    : reason
      ? [
          { text: attention, drop: STATUS_DROP.progress },
          { text: reason, drop: STATUS_DROP.state, clip: REASON_MINIMUM_WIDTH },
        ]
      : [
          { text: attention },
          { text: activityElapsed(row, now, width < 60), drop: STATUS_DROP.elapsed },
        ];
  const color = activityColor(row, interactive);
  return renderActivityRow(
    {
      kind: activityType(row),
      title: row.title,
      continuations: entry.continuations,
      children: entry.children,
      expanded: entry.expanded,
      glyph: activityGlyph(row, now),
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
    theme,
    presentation,
    focusedStyle,
  );
}

/** Branch attention below a row, excluding the row's own state. */
const descendantAttention = (summary: GroupSummary, row: ActivityRow): ActivityAttentionCounts => {
  const own = activityAttentionCounts(row);
  return {
    user: summary.attention.user - own.user,
    parent: summary.attention.parent - own.parent,
    blocked: summary.attention.blocked - own.blocked,
    failed: summary.attention.failed - own.failed,
  };
};
export interface RowPaint {
  readonly now?: number | undefined;
  readonly theme?: Pick<Theme, "fg">;
}

/**
 * Why a member row ended, from its summary, beside its state: in the widget, which shows only
 * live work, a failed member of a live workflow; anywhere, work cancelled before it started, such
 * as an agent skipped or refused while queued, whose reason tells those apart.
 */
const memberReason = (row: ActivityRow, widget: boolean): string | undefined =>
  (widget && row.status === "failed") ||
  (row.status === "cancelled" && row.startedAt === undefined && !activityPlanned(row))
    ? row.summary?.trim()
    : undefined;

/** A grouped member row, with the reason it ended when {@link memberReason} gives one. */
export function groupedMemberLine(
  entry: Extract<GroupedActivityRow, { readonly type: "member" }>,
  width: number,
  options: RowPaint,
  presentation: "manager" | "widget",
  focusedStyle?: (text: string) => string,
): string {
  const widget = presentation === "widget";
  const reason = memberReason(entry.row, widget);
  return activityRowLine(
    {
      row: entry.row,
      depth: entry.depth,
      continuations: widget ? entry.continuations.slice(1) : entry.continuations,
      children: entry.children,
      history: entry.history,
      expanded: entry.expanded,
      attention: descendantAttention(entry.summary, entry.row),
      ...(reason && { reason }),
    },
    width,
    options.now,
    options.theme,
    presentation,
    focusedStyle,
  );
}
