import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CompactChild, CompactSummary } from "../tools/compact-summary";
import { layoutCompactRow } from "./compact-row";
import { compactIssueLabel, renderCompactIssues, wrapHanging } from "./compact-issues";
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
export function selectCompactChildren(
  children: NonNullable<CompactSummary["children"]>,
  limit = MAX_CHILDREN,
) {
  const entries = children.entries
    .map((entry, index) => ({ entry, index }))
    .toSorted((a, b) => priority(a.entry) - priority(b.entry) || b.index - a.index)
    .slice(0, limit)
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
    animationFrame?: number | undefined;
    timingEnabled?: boolean | undefined;
    layout?: "tree" | "flat";
    /** Show every retained call instead of the five most relevant. */
    all?: boolean;
  } = {},
): string[] {
  if (!children || width <= 0) return [];
  const flat = options.layout === "flat";
  const { entries, omitted, hiddenFailed } = selectCompactChildren(
    children,
    options.all ? Infinity : MAX_CHILDREN,
  );
  // Omitted calls may be older rows that were evicted or calls never tracked, so say neither.
  const rows =
    flat && omitted > 0
      ? wrapHanging(theme.fg("dim", `… ${omitted} ${calls(omitted)} not listed`), width, "", "", 0)
      : [];
  entries.forEach((entry, index) => {
    const branch = index === entries.length - 1 && omitted === 0 ? "╰─" : "├─";
    const prefix = flat ? "" : theme.fg("dim", `  ${branch} `);
    const issueLabel = flat ? "" : compactIssueLabel(entry.issues ?? [], theme);
    const { row, issueShown } = layoutCompactRow(
      {
        name: entry.label,
        phase: entry.status === "pending" || entry.status === "running" ? entry.status : "settled",
        status: entry.status,
        returnedCheckmark: entry.returnedCheckmark,
        summary: { ...entry, subject: entry.subject ?? "" },
        issueLabel: issueLabel || undefined,
        // The row shows a duration only for a finite, non-negative measurement.
        duration: entry.durationMs === undefined ? undefined : formatDuration(entry.durationMs),
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
      rows.push(...wrapHanging(issueLabel, width, rail, rail, 8));
    }
  });
  if (!flat && omitted > 0) rows.push(...omissionRows(omitted, hiddenFailed, theme, width));
  return rows;
}

const calls = (count: number) => (count === 1 ? "call" : "calls");

/** Counts are evidence: wrap overflow instead of clipping their digits or hiding a failure. */
function omissionRows(
  omitted: number,
  hiddenFailed: number,
  theme: Theme,
  width: number,
): string[] {
  const branch = theme.fg("dim", "  ╰─ ");
  const more = theme.fg("dim", `… ${omitted} more ${calls(omitted)}`);
  const failed = hiddenFailed > 0 ? theme.fg("error", `${hiddenFailed} failed`) : "";
  const single = branch + more + (failed ? ` (${failed})` : "");
  if (visibleWidth(single) <= width) return [single];
  const spaces = " ".repeat(visibleWidth(branch));
  const rows = wrapHanging(more, width, branch, spaces, 8);
  // Drop decoration before splitting a complete failure fact that fits unadorned.
  return failed
    ? rows.concat(wrapHanging(failed, width, spaces, spaces, visibleWidth(failed)))
    : rows;
}
