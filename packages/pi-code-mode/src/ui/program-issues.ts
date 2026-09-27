/** Program-level issues and outcome. Nested calls carry their own issues on their rows. */
import {
  compactIssueSeverity,
  selectCompactChildren,
  type CompactChild,
  type CompactIssue,
  type CompactOutcome,
} from "pi-code-previews";
import { INCOMPLETE_ATTENTION } from "../tools/compact-evidence.ts";
import { describeProgramFailure } from "../tools/diagnostic-messages.ts";
import type { CodeModeRenderDetails } from "./tool-render-details.ts";
import { firstLineMessage } from "pi-cosmic-core";

export const TRUNCATED_OUTPUT_NOTICE =
  "Output exceeded the output limit; prior operations may already have taken effect.";

const STOPPED = "stopped the program";

/** The run's failure issue, unless a call row explains it, and the rows that may. */
interface ProgramFailure {
  readonly issue?: CompactIssue;
  readonly rows: readonly CompactChild[];
}

/** The run's own issues, and its call rows with any row that explains the run's failure. */
export interface ProgramIssues {
  readonly issues: CompactIssue[];
  readonly rows: readonly CompactChild[];
}

/** The row's collapsed reason says it also stopped the program. */
const markStopped = (row: CompactChild): CompactChild => {
  const issues = row.issues ?? [];
  const primary =
    issues.find((issue) => issue.severity === "error") ??
    issues.find((issue) => issue.severity === "warning");
  return {
    ...row,
    issues: primary
      ? issues.map((issue) =>
          issue === primary
            ? { ...issue, message: firstLineMessage(`${issue.message}; ${STOPPED}`, issue.message) }
            : issue,
        )
      : [
          { severity: "error", code: "stopped-program", message: `Failed and ${STOPPED}` },
          ...issues,
        ],
  };
};

/**
 * An unhandled failure of one call is explained on that call's row when it is the only
 * matching row and the collapsed tree shows it: a nested tool that failed, or a call refused
 * before it ran. Otherwise the program's own issue names the call, or just the tool rather
 * than guess. Results without recorded failure evidence show their first line.
 */
const programFailure = (
  text: string,
  details: CodeModeRenderDetails,
  rows: readonly CompactChild[],
): ProgramFailure => {
  const failure = details.failure;
  if (failure === undefined)
    return {
      rows,
      issue: {
        severity: "error",
        code: "program-failure",
        message: firstLineMessage(text, "The program failed"),
      },
    };
  const tool = failure.kind === "ToolFailure" ? failure.facts?.tool : undefined;
  const refusal = `not-sent:${failure.kind}`;
  const matches =
    tool === undefined
      ? rows.flatMap((row, index) =>
          row.issues?.some((issue) => issue.code === refusal) ? [index] : [],
        )
      : details.toolCalls.flatMap((call, index) =>
          call.status === "error" && call.tool === tool ? [index] : [],
        );
  const index = matches.length === 1 ? matches[0] : undefined;
  const culprit = index === undefined ? undefined : rows[index];
  if (
    culprit !== undefined &&
    selectCompactChildren({ total: details.counts.total, entries: rows }).entries.includes(culprit)
  )
    return { rows: rows.map((row, position) => (position === index ? markStopped(row) : row)) };
  const subject = culprit?.compactSubject ?? culprit?.subject;
  return {
    rows,
    issue: {
      severity: "error",
      code: culprit ? "program-stopped" : "program-failure",
      message: culprit
        ? firstLineMessage(
            `Stopped after ${culprit.label}${subject ? ` ${subject}` : ""} failed`,
            "The program stopped",
          )
        : describeProgramFailure(failure, text),
    },
  };
};

export const programIssues = (
  details: CodeModeRenderDetails,
  callRows: readonly CompactChild[],
  text: string,
  isError: boolean,
): ProgramIssues => {
  const issues: CompactIssue[] = [];
  let rows = callRows;
  if (details.cancelled)
    issues.push({
      severity: "warning",
      code: "cancelled",
      message: "Cancelled; earlier changes may remain",
    });
  else if (isError) {
    const failure = programFailure(text, details, callRows);
    rows = failure.rows;
    if (failure.issue) issues.push(failure.issue);
  }
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
        ? "Output exceeded the output limit and the rest was not saved."
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
  return { issues, rows };
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
