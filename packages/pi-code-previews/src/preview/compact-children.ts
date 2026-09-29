import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CompactChild, CompactSummary } from "../tools/compact-summary";
import { layoutCompactRow } from "./compact-row";
import { compactIssueLabel, renderCompactIssues } from "./compact-issues";
import { formatDuration } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";

const MAX_CHILDREN = 5;
const priority = (child: CompactChild): number =>
  child.status === "pending" || child.status === "running"
    ? 0
    : child.status === "success" || child.status === "returned"
      ? 2
      : 1;

/** Prefer active/problem calls, then recent completions; keep their admission order. */
export function selectCompactChildren(children: NonNullable<CompactSummary["children"]>) {
  const entries = children.entries
    .map((entry, index) => ({ entry, index }))
    .toSorted((a, b) => priority(a.entry) - priority(b.entry) || b.index - a.index)
    .slice(0, MAX_CHILDREN)
    .toSorted((a, b) => a.index - b.index)
    .map(({ entry }) => entry);
  const shown = new Set(entries);
  const hiddenFailed = children.entries.filter(
    (entry) => !shown.has(entry) && entry.status === "error",
  ).length;
  return { entries, omitted: Math.max(0, children.total - entries.length), hiddenFailed };
}

/**
 * Collapsed trees show each call's primary issue on its own row. The flat expanded layout
 * lists every retained call with all of its issues and details beneath it.
 */
export function renderCompactChildren(
  children: CompactSummary["children"],
  theme: Theme,
  width: number,
  options: {
    animationFrame?: number;
    timingEnabled?: boolean;
    layout?: "tree" | "flat";
    /** Show every retained call instead of the five most relevant. */
    all?: boolean;
  } = {},
): string[] {
  if (!children || width <= 0) return [];
  const flat = options.layout === "flat";
  const { entries, omitted, hiddenFailed } = options.all
    ? {
        entries: children.entries,
        omitted: Math.max(0, children.total - children.entries.length),
        hiddenFailed: 0,
      }
    : selectCompactChildren(children);
  const rows: string[] = [];
  // Omitted calls may be older rows that were evicted or calls never tracked, so say neither.
  if (flat && omitted > 0)
    rows.push(clipToWidth(theme.fg("dim", `… ${omitted} ${calls(omitted)} not listed`), width, ""));
  entries.forEach((entry, index) => {
    const branch = index === entries.length - 1 && (flat || omitted === 0) ? "╰─" : "├─";
    const prefix = flat ? "" : theme.fg("dim", `  ${branch} `);
    const duration =
      entry.durationMs !== undefined && Number.isFinite(entry.durationMs) && entry.durationMs >= 0
        ? formatDuration(entry.durationMs)
        : undefined;
    const issueLabel = flat ? "" : compactIssueLabel(entry.issues ?? [], theme);
    const { row, issueShown } = layoutCompactRow(
      {
        name: entry.label,
        phase: entry.status === "pending" || entry.status === "running" ? entry.status : "settled",
        status: entry.status,
        returnedCheckmark: entry.returnedCheckmark,
        summary: {
          ...entry,
          subject: entry.subject ?? "",
          metadata: entry.metadata ?? (entry.status === "returned" ? ["returned"] : []),
        },
        issueLabel: issueLabel || undefined,
        duration,
        elapsedMs: entry.durationMs,
        timingEnabled: options.timingEnabled ?? true,
        animationFrame: options.animationFrame ?? 0,
        expanded: flat,
      },
      theme,
      Math.max(0, width - visibleWidth(prefix)),
    );
    rows.push(clipToWidth(`${prefix}${row}`, width, ""));
    if (flat) rows.push(...renderCompactIssues(entry.issues, theme, width, true));
    // A reason that does not fit on its row moves beneath it rather than disappearing.
    else if (issueLabel && !issueShown) {
      const rail = theme.fg("dim", branch === "├─" ? "  │    " : "       ");
      const indent = width - visibleWidth(rail) >= 8 ? visibleWidth(rail) : 0;
      for (const line of wrapTextWithAnsi(issueLabel, width - indent))
        rows.push(clipToWidth(`${indent ? rail : ""}${line}`, width, ""));
    }
  });
  if (!flat && omitted > 0)
    rows.push(
      clipToWidth(
        theme.fg("dim", `  ╰─ … ${omitted} more ${calls(omitted)}`) +
          (hiddenFailed > 0 ? theme.fg("error", ` (${hiddenFailed} failed)`) : ""),
        width,
        "",
      ),
    );
  return rows;
}

const calls = (count: number) => (count === 1 ? "call" : "calls");
