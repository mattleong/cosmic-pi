import { visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import {
  managerActivityGlyph,
  managerNoticeColor,
  managerNoticeGlyph,
  clipToWidth,
  spinnerFrameAt,
} from "../manager/chrome.ts";
import { activityAttentionLabels, needsYou } from "./attention.ts";
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
  hiddenWidgetFailures,
  widgetRows,
  type ActivityWidgetSection,
  type WidgetOptions,
} from "./widget-projection.ts";
import { groupedMemberLines } from "./row-line.ts";

export const activityStartupGlyph = (
  rows: readonly ActivityRow[],
  starting: number,
  now = 0,
): string =>
  starting > 0 && !Arr.some(rows, (row) => !isFinished(row))
    ? managerActivityGlyph("pending", spinnerFrameAt(now))
    : "";
export function activityOwnerLabel(
  rows: readonly ActivityRow[],
  row: ActivityRow,
  width: number,
): string {
  const parts = Arr.map(activityPath(rows, row.key), (item) => item.title);
  const full = Arr.join(parts, " › ");
  if (visibleWidth(full) <= width) return full;
  while (parts.length > 1) {
    parts.shift();
    const suffix = `… › ${Arr.join(parts, " › ")}`;
    if (visibleWidth(suffix) <= width) return suffix;
  }
  return clipToWidth(parts[0] ?? "", Math.max(0, width), "…");
}

/**
 * Stands in for rows the widget can't show: `… 9 more · 1 needs your input · 3 running`. As room
 * runs out, ended work goes first, then the live-work breakdown; attention stays longest.
 */
const widgetGroupLine = (summary: GroupSummary, width: number, hidden: number): string => {
  const lead = hidden ? `… ${hidden} more` : "…";
  const attention = activityAttentionLabels(summary.attention);
  const { user, parent, blocked, failed } = summary.attention;
  const attentionTotal = user + parent + blocked + failed;
  const active = summary.running + summary.pending + summary.stopping;
  const awaited = summary.awaited ? [`${summary.awaited} awaited`] : [];
  const tiers: ReadonlyArray<readonly string[]> = [
    [...attention, ...endedWorkLabels(summary), ...activeWorkLabels(summary), ...awaited],
    [...attention, ...activeWorkLabels(summary)],
    [...attention, ...(active ? [`${active} active`] : awaited)],
    attention,
    attentionTotal
      ? [`${attentionTotal} ${attentionTotal === 1 ? "needs" : "need"} attention`]
      : [],
    [],
  ];
  const line = (facts: readonly string[]) =>
    facts.length ? `${lead}${hidden ? " · " : " "}${Arr.join(facts, " · ")}` : lead;
  return clipToWidth(
    Option.getOrElse(
      Arr.findFirst(Arr.map(tiers, line), (candidate) => visibleWidth(candidate) <= width),
      () => line(attention),
    ),
    width,
    "…",
  );
};

const overflowLine = (
  sections: readonly ActivityWidgetSection[],
  width: number,
  style: (text: string) => string,
): string => {
  const total = Arr.reduce(
    Arr.map(sections, ({ heading }) => heading.summary),
    emptyGroupSummary,
    addGroupSummaries,
  );
  const hidden = Arr.reduce(
    sections,
    0,
    (subtotal, section) => subtotal + section.entries.length + section.omittedRows,
  );
  return style(widgetGroupLine(total, width, hidden));
};

const sectionLines = (
  section: ActivityWidgetSection,
  width: number,
  options: WidgetOptions,
  style: (text: string) => string,
): string[] => {
  const lines = Arr.flatMap(section.entries, (entry) =>
    entry.type === "member" ? groupedMemberLines(entry, width, options, "widget") : [],
  );
  if (section.omittedRows)
    lines.push(style(widgetGroupLine(section.heading.summary, width, section.omittedRows)));
  return lines;
};

const shownKeys = (sections: readonly ActivityWidgetSection[]): ReadonlySet<string> =>
  new Set(
    Arr.flatMap(sections, ({ entries }) =>
      Arr.flatMap(entries, (entry) => (entry.type === "member" ? [entry.row.key] : [])),
    ),
  );

const needsYouLine = (
  rows: readonly ActivityRow[],
  waiting: readonly ActivityRow[],
  width: number,
  options: WidgetOptions,
): string | undefined => {
  const first = waiting[0];
  if (!first) return undefined;
  const glyph = managerNoticeGlyph("attention");
  const prefix = `Needs your input${waiting.length > 1 ? ` (${waiting.length})` : ""}: `;
  const label = activityOwnerLabel(rows, first, Math.max(0, width - prefix.length - 2));
  const text = `${prefix}${label}`;
  const theme = options.theme;
  return theme
    ? `${theme.fg(managerNoticeColor("attention"), glyph)} ${theme.fg("muted", text)}`
    : `${glyph} ${text}`;
};

const failureLine = (
  failures: readonly ActivityRow[],
  width: number,
  options: WidgetOptions,
): string | undefined => {
  const only = failures.length === 1 ? failures[0] : undefined;
  if (!failures.length) return undefined;
  const where = " · /activity";
  const subject = only
    ? `${clipToWidth(only.title, Math.max(4, width - where.length - 11), "…")} failed`
    : `${failures.length} failed`;
  const glyph = managerActivityGlyph("failed");
  const theme = options.theme;
  return theme
    ? `${theme.fg("error", glyph)} ${theme.fg("muted", `${subject}${where}`)}`
    : `${glyph} ${subject}${where}`;
};

export function renderActivityWidget(
  published: readonly ActivityRow[],
  width: number,
  maxRows = 8,
  options: WidgetOptions = {},
): string[] {
  if (width <= 0 || maxRows <= 0) return [];
  const rows = widgetRows(published, options.inputDockVisible);
  const urgent = needsYou(rows);
  const failures = failureLine(
    hiddenWidgetFailures(rows, options.now, options.inspected),
    width,
    options,
  );
  const reserved = Number(failures !== undefined);
  let sections = activityWidgetSections(rows, maxRows, { ...options, reserved });
  // Waiting rows the checklist already shows need no heading; only the unseen ones do.
  const unseen = () => {
    const shown = shownKeys(sections);
    return Arr.filter(urgent, (row) => !shown.has(row.key));
  };
  let waiting = unseen();
  if (waiting.length) {
    sections = activityWidgetSections(rows, maxRows, { ...options, reserved: reserved + 1 });
    waiting = unseen();
  }
  const style = (text: string) => options.theme?.fg("muted", text) ?? text;
  const lines: string[] = [];
  const heading = needsYouLine(rows, waiting, width, options);
  if (heading) lines.push(heading);
  if (sections.length > maxRows - lines.length - reserved)
    return [overflowLine(sections, width, style)];
  for (const section of sections) lines.push(...sectionLines(section, width, options, style));
  const starting = options.starting ?? 0;
  if (!lines.length && starting > 0)
    lines.push(style(`Subagents ${activityStartupGlyph(rows, starting, options.now)}`));
  if (failures) lines.push(failures);
  return Arr.map(lines.slice(0, maxRows), (line) => clipToWidth(line, width, ""));
}
