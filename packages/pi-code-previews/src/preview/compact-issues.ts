import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  compactIssueSeverity,
  subtractCompactIssueClaims,
  type CompactIssueClaim,
  type CompactIssues,
} from "../tools/compact-issues";
import { indentedCompactText } from "./compact-row";

/** Shared expanded attention after exact evidence subtraction. */
export function renderExpandedAttention(
  issues: CompactIssues,
  claims: readonly CompactIssueClaim[] | undefined,
  theme: Theme,
  width: number,
  attribute = false,
): string[] {
  return renderCompactIssues(
    subtractCompactIssueClaims(issues, claims),
    theme,
    width,
    true,
    attribute,
  );
}

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
  const attributed = attribute;
  const text = issues.entries
    .flatMap((issue) => {
      const description =
        issue.description ??
        (issue.cause
          ? issue.severity === "error"
            ? "The tool reported an error."
            : "The tool reported a warning."
          : "");
      const lines = expanded
        ? [
            ...(issue.cause ? [issue.cause] : []),
            ...issue.recovery.map((instruction) => instruction.text),
            ...(issue.diagnostics ?? []),
          ]
        : description
          ? [description]
          : [];
      return expanded && attributed
        ? lines.map((line, index) => (index === 0 ? `${issue.operation}: ${line}` : line))
        : lines;
    })
    .join("\n");
  return text
    ? indentedCompactText(text, "  ╰─ ", knownFailure ? "error" : severity, theme, width)
    : [];
}
