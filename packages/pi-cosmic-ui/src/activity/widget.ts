import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { countLabel } from "pi-cosmic-core";
import { managerActivityGlyph, clipToWidth, spinnerFrameAt } from "../manager/chrome.ts";
import { activityPlanned, compactNotices, needsYou } from "./attention.ts";
import { activityPath, isFinished, type ActivityRow } from "./model.ts";
import type { GroupedActivityRow } from "./grouped-tree.ts";
import {
  activeWorkLabels,
  addGroupSummaries,
  emptyGroupSummary,
  endedWorkLabels,
  type GroupSummary,
} from "./group-summary.ts";
import {
  activityWidgetSections,
  isPlannedEntry,
  workflowNarrator,
  type ActivityWidgetSection,
  type WidgetOptions,
} from "./widget-projection.ts";
import { groupedMemberLine } from "./row-line.ts";
import { workflowRowLine } from "./workflow-row.ts";

export const activityStartupGlyph = (
  rows: readonly ActivityRow[],
  starting: number,
  now = 0,
): string =>
  starting > 0 && !rows.some((row) => !isFinished(row) && !activityPlanned(row))
    ? managerActivityGlyph("pending", spinnerFrameAt(now))
    : "";
/** A row's ownership path, dropping leading owners until it fits `width`. */
export function activityOwnerLabel(
  rows: readonly ActivityRow[],
  row: ActivityRow,
  width: number,
): string {
  const parts = activityPath(rows, row.key).map((item) => item.title);
  const full = parts.join(" › ");
  if (visibleWidth(full) <= width) return full;
  while (parts.length > 1) {
    parts.shift();
    const suffix = `… › ${parts.join(" › ")}`;
    if (visibleWidth(suffix) <= width) return suffix;
  }
  return clipToWidth(parts[0] ?? "", Math.max(0, width), "…");
}

/** Reserve space for attention and omitted evidence before routine progress or long names. */
const widgetGroupLine = (
  summary: GroupSummary,
  width: number,
  omissions: readonly string[],
): string => {
  const title = "…";
  const omitted = omissions.join(" · ");
  const notices = [...compactNotices(summary.attention), ...omissions];
  const full = [
    title,
    ...notices,
    ...endedWorkLabels(summary),
    ...activeWorkLabels(summary),
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

type Omissions = Pick<
  ActivityWidgetSection,
  "hiddenSources" | "hiddenPhases" | "hiddenWorkflows" | "hiddenPlanned"
>;
const omissionLabels = (hidden: Omissions): string[] => [
  ...(hidden.hiddenSources ? [`+${countLabel(hidden.hiddenSources, "item")}`] : []),
  ...(hidden.hiddenPhases ? [`+${countLabel(hidden.hiddenPhases, "phase")}`] : []),
  ...(hidden.hiddenWorkflows ? [`+${countLabel(hidden.hiddenWorkflows, "workflow")}`] : []),
  ...(hidden.hiddenPlanned ? [`+${hidden.hiddenPlanned} planned`] : []),
];

/** A workflow's narrator line, dim beneath its row and continuing the tree guide to its phases. */
const narratorLine = (
  text: string,
  width: number,
  continues: boolean,
  theme: Pick<Theme, "fg"> | undefined,
): string => {
  const line = clipToWidth(`${continues ? "│  " : "   "}${text}`, width, "…");
  return theme?.fg("dim", line) ?? line;
};

/**
 * A branch's failed members past the per-workflow cap, at the depth of its members: beneath its
 * last failure shown, continuing that row's guides, or beneath the branch row itself, continuing
 * the guide to its children when `continues`.
 */
const hiddenFailuresLine = (
  entry: GroupedActivityRow,
  count: number,
  width: number,
  continues: boolean,
  theme: Pick<Theme, "fg"> | undefined,
): string => {
  const guides = entry.continuations
    .slice(1)
    .map((continuing) => (continuing ? "│  " : "   "))
    .join("");
  const branch = entry.type === "member" ? "" : continues ? "│  " : "   ";
  const line = clipToWidth(`${guides}${branch}+${count} failed`, width, "…");
  return theme?.fg("warning", line) ?? line;
};

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
    const sum = (count: (section: ActivityWidgetSection) => number) =>
      sections.reduce((total, section) => total + count(section), 0);
    const shown = (matches: (entry: GroupedActivityRow) => boolean) =>
      sum((section) => section.entries.filter(matches).length);
    const hidden = (type: GroupedActivityRow["type"]) => shown((entry) => entry.type === type);
    const shownPlanned = shown(isPlannedEntry);
    // Capped failures that would have had a count line are hidden here too.
    const countedFailures = sum((section) =>
      [...section.failureOverflow.values()].reduce((total, count) => total + count, 0),
    );
    return [
      style(
        widgetGroupLine(
          total,
          width,
          omissionLabels({
            hiddenSources:
              sum((section) => section.hiddenSources) +
              hidden("member") -
              shownPlanned +
              countedFailures,
            hiddenPhases: sum((section) => section.hiddenPhases) + hidden("phase"),
            hiddenWorkflows: sum((section) => section.hiddenWorkflows) + hidden("workflow"),
            hiddenPlanned: sum((section) => section.hiddenPlanned) + shownPlanned,
          }),
        ),
      ),
    ];
  }
  for (const section of sections) {
    for (const [index, entry] of section.entries.entries()) {
      if (entry.type === "member") lines.push(groupedMemberLine(entry, width, options, "widget"));
      else if (entry.type === "workflow" || entry.type === "phase")
        lines.push(workflowRowLine(entry, width, options));
      const continues = section.entries[index + 1]?.parentId === entry.id;
      const narrator = section.narrators.has(entry.id) ? workflowNarrator(entry) : undefined;
      if (narrator !== undefined)
        lines.push(narratorLine(narrator, width, continues, options.theme));
      const failures = section.failureOverflow.get(entry.id);
      if (failures)
        lines.push(hiddenFailuresLine(entry, failures, width, continues, options.theme));
    }
    if (section.omittedRows)
      lines.push(style(widgetGroupLine(section.heading.summary, width, omissionLabels(section))));
  }
  if (!lines.length && (options.starting ?? 0) > 0)
    lines.push(style(`Subagents ${activityStartupGlyph(rows, options.starting!, options.now)}`));
  return lines.slice(0, maxRows).map((line) => clipToWidth(line, width, ""));
}
