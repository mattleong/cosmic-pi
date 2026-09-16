import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CompactChild, CompactSummary } from "../tools/compact-summary";
import { renderCompactRow, renderCompactNotices } from "./compact-row";
import { formatToolCallDuration } from "./format";

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
  return { entries, omitted: Math.max(0, children.total - entries.length) };
}

export function renderCompactChildren(
  children: CompactSummary["children"],
  theme: Theme,
  width: number,
  animationFrame = 0,
  timingEnabled = true,
): string[] {
  if (!children || width <= 0) return [];
  const { entries, omitted } = selectCompactChildren(children);
  const rows = entries.flatMap((entry, index) => {
    const branch = index === entries.length - 1 && omitted === 0 ? "╰─" : "├─";
    const prefix = theme.fg("dim", `  ${branch} `);
    const duration =
      entry.durationMs !== undefined && Number.isFinite(entry.durationMs) && entry.durationMs >= 0
        ? formatToolCallDuration(entry.durationMs)
        : undefined;
    const row = renderCompactRow(
      {
        name: entry.label,
        phase: entry.status === "pending" || entry.status === "running" ? entry.status : "settled",
        status: entry.status,
        summary: {
          ...entry,
          subject: entry.subject ?? "",
          metadata: entry.metadata ?? (entry.status === "returned" ? ["returned"] : []),
        },
        duration,
        elapsedMs: entry.durationMs,
        timingEnabled,
        animationFrame,
      },
      theme,
      Math.max(0, width - visibleWidth(prefix)),
    );
    // Nest recovery beneath its call, but surrender decoration before losing text.
    const noticeIndent = width - visibleWidth(prefix) >= 2 ? visibleWidth(prefix) : 0;
    const continuation = noticeIndent ? theme.fg("dim", branch === "├─" ? "  │  " : "     ") : "";
    return [truncateToWidth(`${prefix}${row}`, width, "")].concat(
      renderCompactNotices(entry.notices, theme, width - noticeIndent).map(
        (notice) => `${continuation}${notice}`,
      ),
    );
  });
  if (omitted > 0)
    rows.push(
      truncateToWidth(
        theme.fg("dim", `  ╰─ … ${omitted} more ${omitted === 1 ? "call" : "calls"}`),
        width,
        "",
      ),
    );
  return rows;
}
