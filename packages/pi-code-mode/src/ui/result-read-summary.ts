import * as Schema from "effect/Schema";
import type { CompactSummary } from "pi-code-previews";
import { decodeOption } from "../tools/format.ts";
import { resultReadFailures } from "../results/read-presentation.ts";

const Offset = Schema.Natural.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const ReadDetails = Schema.Struct({
  resultRead: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("page"),
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      originalOutcome: Schema.Literals(["succeeded", "failed", "cancelled"]),
      offset: Offset,
      end: Offset,
      next: Schema.NullOr(Offset),
      total: Offset,
    }),
    Schema.Struct({
      status: Schema.Literal("error"),
      code: Schema.Literals([
        "invalid-input",
        "unavailable",
        "invalid-offset",
        "page-budget",
        "revoked",
      ]),
    }),
  ]),
});

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
      issues: {
        coverage: "complete",
        entries: [
          {
            operation: "result.read",
            code: read.code,
            severity: "error",
            cause: resultReadFailures[read.code].cause,
            description: {
              "invalid-input": "The saved-output request is invalid.",
              unavailable: "Saved output is not available.",
              "invalid-offset":
                "The requested position is outside the saved output or splits a character.",
              "page-budget": "The output limit is too small to load this page.",
              revoked: "Saved output is no longer available in this session.",
            }[read.code],
            recovery: [],
            diagnostics: ["No execution was run. Do not replay mutations to recover output."],
          },
        ],
      },
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
  const originalProblem = read.originalOutcome !== "succeeded";
  return {
    ...heading,
    counters: [
      `page ${read.offset}..${read.end}/${read.total}${read.next === null ? " · EOF" : ""}`,
    ],
    outcome: originalProblem ? "warning" : "success",
    issues: {
      coverage: "complete",
      entries: originalProblem
        ? [
            {
              operation: "original-execution",
              code: `original-${read.originalOutcome}`,
              severity: "warning",
              cause: `Original execution ${read.originalOutcome}; page read succeeded.`,
              description:
                read.originalOutcome === "failed"
                  ? "Output loaded. The earlier run failed."
                  : "Output loaded. The earlier run was cancelled.",
              recovery: [],
              diagnostics: [
                "Reading retained output does not rerun the program or undo side effects.",
              ],
            },
          ]
        : [],
    },
    notices:
      read.next === null
        ? []
        : [
            {
              code: "read-pagination",
              kind: "recovery",
              text: `Continue with result.read id="${id}" offset=${read.next}.`,
              expandedOnly: true,
            },
          ],
  };
}
