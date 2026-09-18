import type { Theme } from "@earendil-works/pi-coding-agent";
import { type CompactPhase, type CompactSummary } from "../tools/compact-summary";
import { renderCompactRow, indentedCompactText } from "./compact-row";
import { renderCompactChildren } from "./compact-children";
import {
  summaryCompactIssues,
  normalizeCompactIssues,
  compactIssueSeverity,
} from "../tools/compact-issues";
import { renderCompactIssues } from "./compact-issues";
export { renderCompactNotices, compactSingleLine } from "./compact-row";

interface CompactToolCallInput {
  name: string;
  phase: CompactPhase;
  summary: CompactSummary;
  duration?: string | undefined;
  elapsedMs?: number | undefined;
  timingEnabled?: boolean;
  animationFrame?: number | undefined;
  expanded?: boolean;
}

/** Child status remains local; the outer issue container owns every child's attention. */
function headingAndChildren(input: CompactToolCallInput, theme: Theme, width: number): string[] {
  const { summary } = input;
  const children = input.expanded
    ? []
    : renderCompactChildren(
        summary.children && {
          ...summary.children,
          entries: summary.children.entries.map((child) =>
            Object.assign({}, child, {
              notices: [],
              issues: { coverage: "complete" as const, entries: [] },
            }),
          ),
        },
        theme,
        width,
        input.animationFrame,
        input.timingEnabled,
      );
  return [renderCompactRow(input, theme, width), ...children];
}

export function renderCompactToolCall(
  input: CompactToolCallInput,
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  const { summary } = input;
  return [
    ...headingAndChildren(input, theme, width),
    ...renderCompactIssues(
      summaryCompactIssues(summary, input.expanded),
      theme,
      width,
      input.expanded,
      Boolean(summary.children?.total),
      summary.outcome === "error",
    ),
  ];
}

/** An explicit failure owns both compact and expanded text. Never stack the original card. */
export function renderCompactFailure(
  input: CompactToolCallInput & { failure: NonNullable<CompactSummary["failure"]> },
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  const { summary, failure, expanded } = input;
  const header = headingAndChildren(input, theme, width);
  const issues = summaryCompactIssues(summary, expanded);
  const knownFailure = summary.outcome === "error" || compactIssueSeverity(issues) === "error";
  const color = knownFailure ? "error" : summary.outcome === "cancelled" ? "muted" : "warning";
  if (expanded)
    return [
      ...header,
      ...indentedCompactText(failure.details, "  ", color, theme, width),
      ...renderCompactIssues(
        {
          ...issues,
          entries: issues.entries.filter((issue) => !summary.issues || !issue.expandedInResult),
        },
        theme,
        width,
        true,
        Boolean(summary.children?.total),
        knownFailure,
      ),
    ];
  const all = summary.issues
    ? issues
    : normalizeCompactIssues([
        {
          coverage: "unknown",
          entries: [
            {
              operation: "outer",
              code: "legacy-failure",
              severity: color === "error" ? "error" : "warning",
              cause: failure.cause,
              recovery: [],
            },
          ],
        },
        issues,
      ]);
  return [
    ...header,
    ...renderCompactIssues(
      all,
      theme,
      width,
      false,
      Boolean(summary.children?.total),
      knownFailure,
    ),
  ];
}
