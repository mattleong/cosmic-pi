import { visibleWidth } from "@earendil-works/pi-tui";
import { countLabel } from "pi-cosmic-core";
import { managerActivityGlyph, clipToWidth, spinnerFrameAt } from "../manager/chrome.ts";
import { compactNotices, needsYou } from "./attention.ts";
import { activityPath, isFinished, type ActivityRow } from "./model.ts";
import {
  activeWorkLabels,
  addGroupSummaries,
  emptyGroupSummary,
  endedWorkLabels,
  type GroupSummary,
} from "./group-summary.ts";
import {
  activityWidgetSections,
  type ActivityWidgetSection,
  type WidgetOptions,
} from "./widget-projection.ts";
import { groupedMemberLine } from "./row-line.ts";

export const activityStartupGlyph = (
  rows: readonly ActivityRow[],
  starting: number,
  now = 0,
): string =>
  starting > 0 && !rows.some((row) => !isFinished(row))
    ? managerActivityGlyph("pending", spinnerFrameAt(now))
    : "";
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
    const { user, parent, blocked, failed } = summary.attention;
    const attention = user + parent + blocked + failed;
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

const omissionLabels = (hidden: number): string[] =>
  hidden ? [`+${countLabel(hidden, "item")}`] : [];

const overflowLine = (
  sections: readonly ActivityWidgetSection[],
  width: number,
  style: (text: string) => string,
): string => {
  const total = sections
    .map(({ heading }) => heading.summary)
    .reduce(addGroupSummaries, emptyGroupSummary);
  const hidden = sections.reduce(
    (subtotal, section) => subtotal + section.entries.length + section.omittedRows,
    0,
  );
  return style(widgetGroupLine(total, width, omissionLabels(hidden)));
};

const sectionLines = (
  section: ActivityWidgetSection,
  width: number,
  options: WidgetOptions,
  style: (text: string) => string,
): string[] => {
  const lines = section.entries.flatMap((entry) =>
    entry.type === "member" ? [groupedMemberLine(entry, width, options, "widget")] : [],
  );
  if (section.omittedRows)
    lines.push(
      style(widgetGroupLine(section.heading.summary, width, omissionLabels(section.omittedRows))),
    );
  return lines;
};

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
  const first = urgent[0];
  if (first)
    lines.push(
      style(
        `Needs you (${urgent.length}): ${activityOwnerLabel(rows, first, Math.max(0, width - 16))}`,
      ),
    );
  if (sections.length > maxRows - lines.length) return [overflowLine(sections, width, style)];
  for (const section of sections) lines.push(...sectionLines(section, width, options, style));
  const starting = options.starting ?? 0;
  if (!lines.length && starting > 0)
    lines.push(style(`Subagents ${activityStartupGlyph(rows, starting, options.now)}`));
  return lines.slice(0, maxRows).map((line) => clipToWidth(line, width, ""));
}
