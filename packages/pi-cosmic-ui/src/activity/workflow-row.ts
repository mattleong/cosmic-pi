import { managerTone } from "../manager/style.ts";
import {
  managerActivityGlyph,
  managerNoticeGlyph,
  spinnerFrameAt,
  type ManagerStatusColor,
} from "../manager/chrome.ts";
import { activityStatus, compactNotices } from "./attention.ts";
import type { GroupedActivityRow } from "./grouped-tree.ts";
import {
  activeWorkLabels,
  finishedWork,
  phaseCountLabels,
  plannedLabels,
  workflowMemberSpan,
  type PhaseState,
} from "./group-summary.ts";
import {
  activityElapsed,
  activityMark,
  activityType,
  elapsedLabel,
  type RowPaint,
} from "./row-line.ts";
import { renderActivityRow, STATUS_DROP, type ActivityStatusPart } from "./row-render.ts";

export const phaseLabels = {
  pending: "not started",
  running: "running",
  done: "finished",
  failed: "failed",
  stopped: "stopped",
  skipped: "skipped",
} satisfies Readonly<Record<PhaseState, string>>;
const phaseColors = {
  pending: "muted",
  running: "accent",
  done: "success",
  failed: "warning",
  stopped: "muted",
  skipped: "muted",
} satisfies Readonly<Record<PhaseState, ManagerStatusColor>>;
const phaseGlyph = (state: PhaseState, now: number): string =>
  state === "pending"
    ? "○"
    : state === "skipped"
      ? "–"
      : managerActivityGlyph(state, spinnerFrameAt(now));
const parts = (texts: readonly string[], drop?: number): ActivityStatusPart[] =>
  texts.map((text) => (drop === undefined ? { text } : { text, drop }));

function phaseProgressParts(
  entry: Extract<GroupedActivityRow, { readonly type: "phase" }>,
  width: number,
  now: number | undefined,
): ActivityStatusPart[] {
  const { state, summary } = entry;
  if (state === "running") {
    const finished = finishedWork(summary);
    const work = [...activeWorkLabels(summary), ...(finished > 0 ? [`${finished} finished`] : [])];
    return work.length
      ? parts(work, STATUS_DROP.progress)
      : parts([phaseLabels.running], STATUS_DROP.state);
  }
  if (state === "pending" || state === "skipped")
    return parts([phaseLabels[state]], STATUS_DROP.state);
  const span = workflowMemberSpan(entry.members, now);
  const elapsed =
    span === undefined ? [] : parts([elapsedLabel(span, width < 60)], STATUS_DROP.elapsed);
  const word =
    state === "stopped" || (state === "done" && span === undefined)
      ? parts([phaseLabels[state]], STATUS_DROP.state)
      : [];
  return [...word, ...elapsed];
}

function phaseRowLine(
  entry: Extract<GroupedActivityRow, { readonly type: "phase" }>,
  width: number,
  options: RowPaint,
  presentation: "manager" | "widget",
  focusedStyle?: (text: string) => string,
): string {
  const notices = compactNotices(entry.summary.attention);
  const attention = notices.length > 0;
  return renderActivityRow(
    {
      kind: "PHASE",
      title: entry.title,
      continuations: entry.continuations,
      children: entry.children,
      expanded: entry.expanded,
      glyph: attention ? managerNoticeGlyph("warning") : phaseGlyph(entry.state, options.now ?? 0),
      color: attention ? "warning" : phaseColors[entry.state],
      typeColor: managerTone.value,
      status: [
        ...parts(notices),
        ...phaseProgressParts(entry, width, options.now),
        ...parts(plannedLabels(entry.summary), STATUS_DROP.phases),
      ],
      statusColor: attention ? "warning" : "muted",
      compactStatus: attention,
      ...(entry.history && { history: true }),
    },
    width,
    options.theme,
    presentation,
    focusedStyle,
  );
}

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
  const notices = compactNotices(entry.summary.attention);
  const phases = row.phases?.length ?? 0;
  const overlay = notices.length > 0 && row.status !== "failed";
  const ended = row.status === "failed" || row.status === "cancelled" || row.status === "stopping";
  const phaseCounts =
    row.status === "cancelled" ? { ...entry.phaseCounts, stopped: 0 } : entry.phaseCounts;
  const mark = activityMark(row, options.now);
  return renderActivityRow(
    {
      kind: activityType(row),
      title: row.title,
      continuations: entry.continuations,
      children: entry.children,
      expanded: entry.expanded,
      glyph: overlay ? managerNoticeGlyph("warning") : mark.glyph,
      color: overlay ? "warning" : mark.color,
      typeColor: managerTone.identity,
      status: [
        ...parts(notices),
        ...(ended ? parts([activityStatus(row)], STATUS_DROP.state) : []),
        ...(phases
          ? parts(
              [
                ...phaseCountLabels(phaseCounts, phases, "phases"),
                ...plannedLabels(entry.unphased),
              ],
              STATUS_DROP.phases,
            )
          : parts(
              [...activeWorkLabels(entry.summary), ...plannedLabels(entry.summary)],
              STATUS_DROP.progress,
            )),
        ...parts([activityElapsed(row, options.now, width < 60)], STATUS_DROP.elapsed),
      ],
      statusColor: notices.length ? "warning" : "muted",
      compactStatus: notices.length > 0,
      ...(entry.history && { history: true }),
      ...(row.awaited && { awaited: true }),
      ...(row.omittedChildren && { omittedChildren: row.omittedChildren }),
    },
    width,
    options.theme,
    presentation,
    focusedStyle,
  );
}
