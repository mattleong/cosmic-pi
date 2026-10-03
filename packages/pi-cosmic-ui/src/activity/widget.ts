import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatElapsed } from "pi-cosmic-core";
import { managerTone } from "../manager/style.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
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
  activityQueued,
  activityStatus,
  type ActivityAttentionCounts,
} from "./attention.ts";
import { isFinished, type ActivityRow } from "./model.ts";
import { activityPath, needsYou, type ActivityTreeRow } from "./tree.ts";
import type { GroupedActivityRow, PhaseState } from "./grouped-tree.ts";
import { addGroupSummaries, emptyGroupSummary, type GroupSummary } from "./group-summary.ts";
import { activityWidgetSections, type WidgetOptions } from "./widget-projection.ts";
export { activityWidgetSections } from "./widget-projection.ts";
import { renderActivityRow } from "./row-render.ts";

export const activityGlyph = (row: ActivityRow, now = 0): string =>
  row.status === "needs-input" || row.status === "blocked"
    ? managerNoticeGlyph("warning")
    : activityQueued(row)
      ? "○"
      : managerActivityGlyph(
          row.status === "cancelled" ? "stopped" : row.status,
          spinnerFrameAt(now),
        );
export const activityStartupGlyph = (
  rows: readonly ActivityRow[],
  starting: number,
  now = 0,
): string =>
  starting > 0 && !rows.some((row) => !isFinished(row))
    ? managerActivityGlyph("pending", spinnerFrameAt(now))
    : "";
/** Whole-second elapsed time; narrow rows keep only the largest unit ("2m"). */
export const activityElapsed = (row: ActivityRow, now?: number, compact = false): string => {
  if (row.startedAt === undefined) return "";
  const elapsed = Math.max(
    0,
    (row.endedAt ?? now ?? row.updatedAt ?? row.startedAt) - row.startedAt,
  );
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
  return clipToWidth(parts[0] ?? "", Math.max(0, width), "…");
}

// Use theme palette tokens for blue, violet, and amber rather than fixed RGB colors.
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

const activityColor = (row: ActivityRow, interactive: boolean): ManagerStatusColor =>
  row.status === "needs-input" || row.status === "blocked"
    ? "warning"
    : activityQueued(row)
      ? "muted"
      : !interactive && row.status === "running"
        ? "accent"
        : managerActivityColor(row.status === "cancelled" ? "stopped" : row.status);

export function activityRowLine(
  entry: ActivityTreeRow,
  width: number,
  now?: number,
  theme?: Pick<Theme, "fg">,
  presentation: "manager" | "widget" = "manager",
  focusedStyle?: (text: string) => string,
): string {
  const row = entry.row;
  const interactive = presentation === "manager";
  const warnings = entry.expanded ? "" : activityAttentionLabels(entry.attention).join(" · ");
  const attention =
    activityAttention(row) !== undefined || row.status === "failed" || activityQueued(row)
      ? activityStatus(row)
      : "";
  const status = warnings || `${attention} ${activityElapsed(row, now, width < 60)}`.trim();
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
      statusColor: warnings ? "warning" : !interactive && !attention ? "muted" : color,
      compactStatus: warnings.length > 0,
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
interface RowPaint {
  readonly now?: number | undefined;
  readonly theme?: Pick<Theme, "fg">;
}

export function groupedMemberLine(
  entry: Extract<GroupedActivityRow, { readonly type: "member" }>,
  width: number,
  options: RowPaint,
  presentation: "manager" | "widget",
  focusedStyle?: (text: string) => string,
): string {
  return activityRowLine(
    {
      row: entry.row,
      depth: entry.depth,
      continuations: presentation === "widget" ? entry.continuations.slice(1) : entry.continuations,
      children: entry.children,
      history: entry.history,
      expanded: entry.expanded,
      attention: descendantAttention(entry.summary, entry.row),
    },
    width,
    options.now,
    options.theme,
    presentation,
    focusedStyle,
  );
}

const compactNotices = (attention: ActivityAttentionCounts): string[] => [
  ...(attention.user ? [`${attention.user} you`] : []),
  ...(attention.parent ? [`${attention.parent} parent`] : []),
  ...(attention.blocked ? [`${attention.blocked} blocked`] : []),
  ...(attention.failed ? [`${attention.failed} failed`] : []),
];
const progressLabels = (summary: GroupSummary): string[] => [
  ...(summary.running ? [`${summary.running} running`] : []),
  ...(summary.pending > summary.queued ? [`${summary.pending - summary.queued} starting`] : []),
  ...(summary.queued ? [`${summary.queued} queued`] : []),
  ...(summary.stopping ? [`${summary.stopping} stopping`] : []),
];
const phaseLabels = {
  pending: "not started",
  running: "running",
  done: "finished",
  stopped: "stopped",
  skipped: "skipped",
} satisfies Readonly<Record<PhaseState, string>>;
const phaseColors = {
  pending: "muted",
  running: "accent",
  done: "success",
  stopped: "muted",
  skipped: "muted",
} satisfies Readonly<Record<PhaseState, ManagerStatusColor>>;
const phaseGlyph = (state: PhaseState, now: number): string =>
  state === "pending"
    ? "○"
    : state === "skipped"
      ? "–"
      : managerActivityGlyph(state, spinnerFrameAt(now));

function phaseRowLine(
  entry: Extract<GroupedActivityRow, { readonly type: "phase" }>,
  width: number,
  options: RowPaint,
  presentation: "manager" | "widget",
  focusedStyle?: (text: string) => string,
): string {
  const summary = entry.summary;
  const notices = compactNotices(summary.attention);
  const finished = summary.terminal - summary.attention.failed - summary.stopped;
  const progress = [...progressLabels(summary), ...(finished > 0 ? [`${finished} finished`] : [])];
  const color = notices.length ? "warning" : phaseColors[entry.state];
  return renderActivityRow(
    {
      kind: "PHASE",
      title: entry.title,
      continuations: presentation === "widget" ? entry.continuations.slice(1) : entry.continuations,
      children: entry.children,
      expanded: entry.expanded,
      glyph: notices.length
        ? managerNoticeGlyph("warning")
        : phaseGlyph(entry.state, options.now ?? 0),
      color,
      typeColor: managerTone.value,
      status: [
        ...notices,
        ...(entry.state === "running" && progress.length ? progress : [phaseLabels[entry.state]]),
      ].join(" · "),
      statusColor: notices.length ? "warning" : "muted",
      compactStatus: notices.length > 0,
    },
    width,
    options.theme,
    presentation,
    focusedStyle,
  );
}

/** Workflow and phase rows; a workflow row also carries its own provider state and actions. */
export function workflowRowLine(
  entry: Extract<GroupedActivityRow, { readonly type: "workflow" | "phase" }>,
  width: number,
  options: RowPaint,
  presentation: "manager" | "widget" = "widget",
  focusedStyle?: (text: string) => string,
): string {
  if (entry.type === "phase")
    return phaseRowLine(entry, width, options, presentation, focusedStyle);
  const row = entry.row;
  const interactive = presentation === "manager";
  const notices = compactNotices(entry.summary.attention);
  const phases = row.phases?.length ?? 0;
  // The workflow's own failure keeps its glyph; member attention overlays a live or ended run.
  const overlay = notices.length > 0 && row.status !== "failed";
  const ended = row.status === "failed" || row.status === "cancelled" || row.status === "stopping";
  return renderActivityRow(
    {
      kind: activityType(row),
      title: row.title,
      continuations: presentation === "widget" ? entry.continuations.slice(1) : entry.continuations,
      children: entry.children,
      expanded: entry.expanded,
      glyph: overlay ? managerNoticeGlyph("warning") : activityGlyph(row, options.now),
      color: overlay ? "warning" : activityColor(row, interactive),
      typeColor: (interactive ? managerTypeColors : widgetTypeColors).workflow,
      status: [
        ...notices,
        ...(phases ? [`${entry.finishedPhases}/${phases} phases`] : progressLabels(entry.summary)),
        ...(ended ? [activityStatus(row)] : []),
        activityElapsed(row, options.now, width < 60),
      ]
        .filter(Boolean)
        .join(" · "),
      statusColor: notices.length ? "warning" : "muted",
      compactStatus: notices.length > 0,
      ...(row.awaited && { awaited: true }),
      ...(row.omittedChildren && { omittedChildren: row.omittedChildren }),
    },
    width,
    options.theme,
    presentation,
    focusedStyle,
  );
}

/** Reserve space for attention and omitted evidence before routine progress or long names. */
const widgetGroupLine = (
  title: string,
  summary: GroupSummary,
  width: number,
  omissions: readonly string[] = [],
): string => {
  const omitted = omissions.join(" · ");
  const notices = [...compactNotices(summary.attention), ...omissions];
  const full = [
    title,
    ...notices,
    ...(summary.stopped ? [`${summary.stopped} stopped`] : []),
    ...progressLabels(summary),
    ...(summary.awaited ? [`${summary.awaited} awaited`] : []),
  ].join(" · ");
  if (visibleWidth(full) <= width) return full;
  let evidence = notices.join(" · ");
  if (visibleWidth(evidence) + Math.min(12, visibleWidth(title)) + 3 > width)
    evidence = notices.join(" ");
  if (visibleWidth(evidence) > width) {
    const attention = Object.values(summary.attention).reduce((sum, count) => sum + count, 0);
    evidence = [attention ? `${attention} attention` : "", omitted].filter(Boolean).join(" · ");
  }
  const active = summary.running + summary.pending + summary.stopping;
  const progress = active
    ? `${active} active`
    : summary.awaited
      ? `${summary.awaited} awaited`
      : "";
  if (progress && visibleWidth([title, evidence, progress].filter(Boolean).join(" · ")) <= width)
    evidence = [evidence, progress].filter(Boolean).join(" · ");
  if (!evidence) return clipToWidth(title, width, "…");
  if (visibleWidth(evidence) + 4 > width) return clipToWidth(evidence, width, "…");
  return `${clipToWidth(title, Math.max(1, width - visibleWidth(evidence) - 3), "…")} · ${evidence}`;
};

const omissionLabels = (sources: number, phases: number, workflows: number): string[] => [
  ...(sources ? [`+${sources} items`] : []),
  ...(phases ? [`+${phases} phases`] : []),
  ...(workflows ? [`+${workflows} workflows`] : []),
];

/** A bounded read-only overview. All execution capabilities stay in the manager. */
export function renderActivityWidget(
  rows: readonly ActivityRow[],
  width: number,
  maxRows = 8,
  options: WidgetOptions = {},
): string[] {
  if (width <= 0 || maxRows <= 0) return [];
  const sections = activityWidgetSections(rows, maxRows, options);
  const urgent = needsYou(rows);
  const style = (text: string) => options.theme?.fg("muted", text) ?? text;
  const lines: string[] = [];
  if (urgent.length)
    lines.push(
      style(
        `Needs you (${urgent.length}): ${activityOwnerLabel(rows, urgent[0]!, Math.max(0, width - 16))}`,
      ),
    );
  if (sections.length > maxRows - lines.length) {
    // At tiny heights, preserve all sections' evidence rather than only the first question.
    const total = sections
      .map(({ heading }) => heading.summary)
      .reduce(addGroupSummaries, emptyGroupSummary);
    const hidden = (type: GroupedActivityRow["type"]) =>
      sections.reduce(
        (sum, section) => sum + section.entries.filter((entry) => entry.type === type).length,
        0,
      );
    const hiddenSources = sections.reduce((sum, section) => sum + section.hiddenSources, 0);
    const hiddenPhases = sections.reduce((sum, section) => sum + section.hiddenPhases, 0);
    const hiddenWorkflows = sections.reduce((sum, section) => sum + section.hiddenWorkflows, 0);
    return [
      style(
        widgetGroupLine(
          "…",
          total,
          width,
          omissionLabels(
            hiddenSources + hidden("member"),
            hiddenPhases + hidden("phase"),
            hiddenWorkflows + hidden("workflow"),
          ),
        ),
      ),
    ];
  }
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.type === "member") lines.push(groupedMemberLine(entry, width, options, "widget"));
      else if (entry.type === "workflow" || entry.type === "phase")
        lines.push(workflowRowLine(entry, width, options));
    }
    if (section.omittedRows)
      lines.push(
        style(
          widgetGroupLine(
            "…",
            section.heading.summary,
            width,
            omissionLabels(section.hiddenSources, section.hiddenPhases, section.hiddenWorkflows),
          ),
        ),
      );
  }
  if (!lines.length && (options.starting ?? 0) > 0)
    lines.push(style(`Subagents ${activityStartupGlyph(rows, options.starting!, options.now)}`));
  return lines.slice(0, maxRows).map((line) => clipToWidth(line, width, ""));
}
