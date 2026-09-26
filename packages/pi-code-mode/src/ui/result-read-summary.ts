import * as Schema from "effect/Schema";
import type { CompactIssue, CompactSummary } from "pi-code-previews";
import { decodeOption } from "../tools/format.ts";
import { ResultReadPresentationSchema, resultReadFailures } from "../results/read-presentation.ts";

const ReadDetails = Schema.Struct({ resultRead: ResultReadPresentationSchema });

const READ_FAILURES = {
  "invalid-input": "The saved-output request is invalid",
  unavailable: "Saved output is not available",
  "invalid-offset": "The requested position is outside the saved output or splits a character",
  "page-budget": "The output limit is too small to load this page",
  revoked: "Saved output is no longer available in this session",
} as const;

/** Read delivery is separate from the retained execution. Never inspect page text. */
export function resultReadCompactSummary<Details>(
  details: Details,
  id: string,
): CompactSummary | undefined {
  const read = decodeOption(ReadDetails, details)?.resultRead;
  if (!read) return undefined;
  const heading = {
    action: "result.read",
    subject: id,
    compactSubject: "Saved output",
    showTiming: true as const,
  };
  if (read.status === "error")
    return {
      ...heading,
      outcome: "error",
      issues: [
        {
          severity: "error",
          code: read.code,
          message: READ_FAILURES[read.code],
          detail: `${resultReadFailures[read.code].cause}\nNo execution was run. Do not replay mutations to recover output.`,
        },
      ],
    };
  if (
    read.id !== id ||
    read.offset > read.end ||
    read.end > read.total ||
    (read.next === null
      ? read.end !== read.total
      : read.next !== read.end || read.end >= read.total || read.end <= read.offset)
  )
    return undefined;
  const issues: CompactIssue[] = [];
  if (read.originalOutcome !== "succeeded")
    issues.push({
      severity: "warning",
      code: `original-${read.originalOutcome}`,
      message:
        read.originalOutcome === "failed"
          ? "Saved output from a run that failed"
          : "Saved output from a cancelled run",
      detail: "Reading retained output does not rerun the program or undo side effects.",
    });
  if (read.next !== null)
    issues.push({
      severity: "info",
      code: "read-pagination",
      message: `More output from offset ${read.next}`,
      detail: `Continue with result.read id="${id}" offset=${read.next}.`,
    });
  return {
    ...heading,
    counters: [
      `page ${read.offset}..${read.end}/${read.total}${read.next === null ? " · EOF" : ""}`,
    ],
    outcome: issues.some((issue) => issue.severity === "warning") ? "warning" : "success",
    issues,
  };
}
