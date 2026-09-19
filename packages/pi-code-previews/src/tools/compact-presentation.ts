import { summaryCompactIssues, compactIssueSeverity } from "./compact-issues";
import {
  compactSummaryNeedsDetails,
  resolveCompactSummary,
  type CompactPhase,
  type CompactSummary,
} from "./compact-summary";

/** Shared display policy only. Domain outcome classification stays with the producer. */
export function planCompactPresentation(input: {
  summary: CompactSummary | undefined;
  phase: CompactPhase;
  isError: boolean;
  expanded: boolean;
  heading?: Pick<CompactSummary, "subject" | "action" | "showTiming"> | undefined;
}) {
  const summary = resolveCompactSummary(input.summary, input.phase, input.isError);
  const covered = Boolean(
    summary &&
    ((!summary.issues && !summary.children?.entries.some((child) => child.issues)) ||
      summaryCompactIssues(summary).coverage === "complete"),
  );
  const isError = input.isError && summary?.outcome !== "cancelled";
  const fallback: CompactSummary = summary ?? {
    subject: input.heading?.subject ?? "",
    ...(input.heading?.action !== undefined && { action: input.heading.action }),
    ...(input.heading?.showTiming && { showTiming: true }),
    ...(input.phase === "settled" && { outcome: isError ? "error" : "uncertain" }),
  };
  const needsHint = input.phase === "settled" && !covered;
  const collapsedSummary: CompactSummary = !needsHint
    ? fallback
    : {
        ...fallback,
        ...(fallback.issues && {
          issues: {
            ...fallback.issues,
            entries: [
              ...fallback.issues.entries,
              {
                operation: fallback.issues.entries[0]?.operation ?? "outer",
                code: "details-on-expand",
                severity: isError ? "error" : "warning",
                cause: "Expand for details.",
                recovery: [],
              },
            ],
          },
        }),
        notices: [
          ...(fallback.notices ?? []),
          { kind: isError ? "error" : "warning", text: "Expand for details." },
        ],
      };
  const issues = summaryCompactIssues(collapsedSummary, input.expanded);
  return {
    summary,
    issues,
    severity: compactIssueSeverity(issues),
    collapsedSummary,
    covered,
    useFailure: Boolean(summary?.failure && covered && compactSummaryNeedsDetails(summary)),
    useExpandedContent: Boolean(input.expanded && summary),
  };
}
