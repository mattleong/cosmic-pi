/** Program-level issues and outcome. Nested calls carry their own issues on their rows. */
import {
  compactIssueSeverity,
  firstLineMessage,
  type CompactChild,
  type CompactIssue,
  type CompactOutcome,
} from "pi-code-previews";
import { INCOMPLETE_ATTENTION } from "../tools/compact-evidence.ts";
import type { CodeModeRenderDetails } from "./tool-render-details.ts";

export const TRUNCATED_OUTPUT_NOTICE =
  "Output exceeded the output limit; prior operations may already have taken effect.";

/** The runtime's diagnostic envelope: `[Kind] (line L, column C) message`. */
const ENVELOPE = /^\[([A-Za-z]+)\](?: \(line (\d+), column \d+\))? ([^\n]*)/u;
const KIND_LABELS = new Map([
  ["ParseError", "Syntax error"],
  ["UnsupportedSyntax", "Unsupported syntax"],
  ["UnknownTool", "Unknown tool"],
  ["InvalidToolInput", "Invalid tool input"],
  ["InvalidToolOutput", "Invalid tool output"],
  ["InvalidDataValue", "Invalid value"],
  ["ToolCallLimitExceeded", "Tool call limit reached"],
  ["TimeoutExceeded", "Timed out"],
  ["ExecutionFailure", "Program error"],
]);

/**
 * Name the nested call that stopped the program only when exactly one failed call of that tool
 * is retained; otherwise name just the tool rather than guess.
 */
const programFailure = (
  text: string,
  details: CodeModeRenderDetails,
  rows: readonly CompactChild[],
): CompactIssue => {
  const envelope = ENVELOPE.exec(text);
  const [, kind = "", line, message = ""] = envelope ?? [];
  const nested = kind === "ToolFailure" ? /^Nested tool '([^']+)' failed:/u.exec(message) : null;
  if (nested?.[1]) {
    const tool = nested[1];
    const failed = details.toolCalls.flatMap((call, index) =>
      call.status === "error" && (call.tool === tool || call.tool === `pi.${tool}`)
        ? [rows[index]]
        : [],
    );
    const culprit = failed.length === 1 ? failed[0] : undefined;
    const label = culprit?.label ?? tool;
    const subject = culprit?.compactSubject ?? culprit?.subject;
    return {
      severity: "error",
      code: "program-stopped",
      message: firstLineMessage(
        culprit
          ? `Program stopped: ${label}${subject ? ` ${subject}` : ""} failed`
          : `Program stopped: a ${label} call failed`,
        "Program stopped",
      ),
    };
  }
  const label = KIND_LABELS.get(kind);
  return {
    severity: "error",
    code: "program-failure",
    message: label
      ? firstLineMessage(
          `${label}${line ? ` (line ${line})` : ""}: ${message.replace(/^Uncaught: /u, "")}`,
          label,
        )
      : firstLineMessage(text, "The program failed"),
  };
};

export const programIssues = (
  details: CodeModeRenderDetails,
  rows: readonly CompactChild[],
  text: string,
  isError: boolean,
): CompactIssue[] => {
  const issues: CompactIssue[] = [];
  if (details.cancelled)
    issues.push({
      severity: "warning",
      code: "cancelled",
      message: "Cancelled; earlier changes may remain",
    });
  else if (isError) issues.push(programFailure(text, details, rows));
  const preview = details.initialPreview;
  if (preview?.next != null)
    issues.push({
      severity: "info",
      code: "saved-output",
      message: "More output is saved",
      detail: `Continue saved output with result.read id="${preview.id}" offset=${preview.next}.`,
    });
  else if (details.truncated && preview === undefined)
    issues.push({
      severity: "warning",
      code: "output-truncated",
      message: "Output was cut off",
      detail: details.receiptsReadOnly
        ? "Output exceeded the output limit."
        : TRUNCATED_OUTPUT_NOTICE,
    });
  // Rows are bounded; problems on calls that are no longer listed still need a line.
  const attention = details.compactAttention;
  if (attention) {
    const recorded =
      attention.errors + attention.warnings + attention.cancelled + attention.uncertain;
    const listed = details.toolCalls.filter(
      (call) => call.compact !== undefined && call.compact.outcome !== "success",
    ).length;
    const unlisted = recorded - listed;
    if (unlisted > 0)
      issues.push({
        severity: "warning",
        code: "unlisted-problems",
        message: `${unlisted} earlier ${unlisted === 1 ? "call" : "calls"} with problems ${unlisted === 1 ? "is" : "are"} no longer listed`,
        detail: "Only the most recent and most relevant calls are retained for display.",
      });
  }
  // Cancelled and unsettled calls already explain their own missing receipts.
  if (
    details.compactAttention?.incomplete &&
    !hasUnsettledCalls(details) &&
    !details.cancelled &&
    details.counts.cancelled === 0
  )
    issues.push({
      severity: "warning",
      code: "incomplete",
      message: "Some call details were not recorded",
      detail: INCOMPLETE_ATTENTION,
    });
  return issues;
};

const hasUnsettledCalls = (details: CodeModeRenderDetails) =>
  details.counts.running + details.counts.queued > 0 ||
  details.toolCalls.some((call) => call.status === "running" || call.status === "queued");

/**
 * The run's own outcome. Failed nested calls the program handled make the run a warning;
 * only calls that may still be running make it uncertain.
 */
export const programOutcome = (
  details: CodeModeRenderDetails,
  rows: readonly CompactChild[],
  issues: readonly CompactIssue[],
  isError: boolean,
): CompactOutcome => {
  if (details.cancelled) return "cancelled";
  if (isError) return "error";
  if (hasUnsettledCalls(details)) return "uncertain";
  const attention = details.compactAttention;
  const nested =
    details.counts.failed + details.counts.cancelled > 0 ||
    (attention !== undefined &&
      attention.errors + attention.warnings + attention.cancelled + attention.uncertain > 0) ||
    rows.some((row) => compactIssueSeverity(row.issues) !== undefined);
  return nested || compactIssueSeverity(issues) !== undefined ? "warning" : "success";
};
