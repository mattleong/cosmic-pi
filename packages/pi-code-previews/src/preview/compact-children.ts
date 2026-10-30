import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  compactSettledStatus,
  type CompactChild,
  type CompactOutcome,
  type CompactSummary,
} from "../tools/compact-summary";
import { layoutCompactRow, type CompactRowInput } from "./compact-row";
import { compactIssueLabel, renderCompactIssues, wrapHanging } from "./compact-issues";
import { formatDuration } from "pi-cosmic-core/display";
import { clipToWidth } from "pi-cosmic-ui/manager";

const MAX_CHILDREN = 5;

type IndexedChild = { entry: CompactChild; index: number };

// Active calls lead, then problems, then calls awaiting a reply or decision, then routine ones.
const SETTLED_PRIORITY: Readonly<Record<CompactOutcome, number>> = {
  error: 1,
  warning: 1,
  uncertain: 1,
  cancelled: 1,
  attention: 2,
  success: 3,
  returned: 3,
};

const priority = (child: CompactChild): number =>
  child.status === "pending" || child.status === "running"
    ? 0
    : SETTLED_PRIORITY[
        compactSettledStatus({ subject: "", outcome: child.status, issues: child.issues ?? [] })
      ];

export function selectCompactChildren(
  children: NonNullable<CompactSummary["children"]>,
  limit = MAX_CHILDREN,
) {
  const entries = Fn.pipe(
    Arr.map(children.entries, (entry, index): IndexedChild => ({ entry, index })),
    Arr.sortBy(
      Order.mapInput(Order.Number, (item: IndexedChild) => priority(item.entry)),
      Order.mapInput(Order.flip(Order.Number), (item: IndexedChild) => item.index),
    ),
    Arr.take(limit),
    Arr.sortWith((item) => item.index, Order.Number),
    Arr.map(({ entry }) => entry),
  );
  const hiddenFailed =
    Arr.filter(children.entries, (entry) => entry.status === "error").length -
    Arr.filter(entries, (entry) => entry.status === "error").length;
  return { entries, omitted: Math.max(0, children.total - entries.length), hiddenFailed };
}

export function renderCompactChildren(
  children: CompactSummary["children"],
  theme: Theme,
  width: number,
  options: {
    animationFrame?: number | undefined;
    timingEnabled?: boolean | undefined;
    layout?: "tree" | "flat";
    all?: boolean;
  } = {},
): string[] {
  if (!children || width <= 0) return [];
  const flat = options.layout === "flat";
  const { entries, omitted, hiddenFailed } = selectCompactChildren(
    children,
    options.all ? Infinity : MAX_CHILDREN,
  );
  const rows =
    flat && omitted > 0
      ? wrapHanging(theme.fg("dim", `… ${omitted} ${calls(omitted)} not listed`), width, "", "", 0)
      : [];
  Arr.forEach(entries, (entry, index) => {
    const branch = index === entries.length - 1 && omitted === 0 ? "╰─" : "├─";
    const prefix = flat ? "" : theme.fg("dim", `  ${branch} `);
    const issueLabel = flat ? "" : compactIssueLabel(entry.issues ?? [], theme);
    const { row, issueShown } = layoutCompactRow(
      childRowInput(entry, issueLabel, flat, options),
      theme,
      Math.max(0, width - visibleWidth(prefix)),
    );
    rows.push(clipToWidth(`${prefix}${row}`, width, ""));
    if (flat) rows.push(...renderCompactIssues(entry.issues, theme, width, true));
    else if (issueLabel && !issueShown) {
      const rail = theme.fg("dim", branch === "├─" ? "  │    " : "       ");
      rows.push(...wrapHanging(issueLabel, width, rail, rail, 8));
    }
  });
  if (!flat && omitted > 0) rows.push(...omissionRows(omitted, hiddenFailed, theme, width));
  return rows;
}

function childRowInput(
  entry: CompactChild,
  issueLabel: string,
  flat: boolean,
  options: {
    readonly animationFrame?: number | undefined;
    readonly timingEnabled?: boolean | undefined;
  },
): CompactRowInput {
  return {
    name: entry.label,
    phase: entry.status === "pending" || entry.status === "running" ? entry.status : "settled",
    status: entry.status,
    returnedCheckmark: entry.returnedCheckmark,
    summary: { ...entry, subject: entry.subject ?? "" },
    issueLabel: issueLabel || undefined,
    duration: entry.durationMs === undefined ? undefined : formatDuration(entry.durationMs),
    elapsedMs: entry.durationMs,
    timingEnabled: options.timingEnabled ?? true,
    animationFrame: options.animationFrame ?? 0,
    expanded: flat,
  };
}

const calls = (count: number) => (count === 1 ? "call" : "calls");

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
  const spaces = Fn.pipe(" ", Str.repeat(visibleWidth(branch)));
  const rows = wrapHanging(more, width, branch, spaces, 8);
  return failed
    ? rows.concat(wrapHanging(failed, width, spaces, spaces, visibleWidth(failed)))
    : rows;
}
