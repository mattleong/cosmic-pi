import type { Theme } from "@earendil-works/pi-coding-agent";
import { compactIssueSeverity, type CompactIssues } from "../tools/compact-issues";
import { indentedCompactText } from "./compact-row";

/** One container owns all causes and essential recovery. Wrapping never clips instructions. */
export function renderCompactIssues(
  issues: CompactIssues,
  theme: Theme,
  width: number,
  expanded = false,
  attribute = false,
  knownFailure = false,
): string[] {
  const severity = compactIssueSeverity(issues);
  if (!severity || width <= 0) return [];
  const attributed = attribute || new Set(issues.entries.map((issue) => issue.operation)).size > 1;
  const text = issues.entries
    .flatMap((issue) => {
      const lines = [
        ...(issue.cause ? [issue.cause] : []),
        ...issue.recovery.map((instruction) => instruction.text),
        ...(expanded ? (issue.diagnostics ?? []) : []),
      ];
      return attributed
        ? lines.map((line, index) => (index === 0 ? `${issue.operation}: ${line}` : line))
        : lines;
    })
    .join("\n");
  return text
    ? indentedCompactText(text, "  ╰─ ", knownFailure ? "error" : severity, theme, width)
    : [];
}
