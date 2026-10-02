import { compactIssueSeverity } from "pi-code-previews";
import type { CompactIssue, CompactPhase, CompactSummary } from "pi-code-previews";
import { QUOTED_TEXT_LIMIT, quoted } from "./compact-run-issues.ts";
import type { SubagentCardFailure, SubagentStartDetails } from "./details-schema.ts";
import { failedStartRecoveryAction, formatFailedStartRecovery } from "./format.ts";
import { isUncertainToolFailure } from "./outcome.ts";
import { failureMessage } from "pi-cosmic-core";

/** Progress counter; a sole named target needs no count. */
export function progressDetail(
  count: number,
  total: number,
  state: "started" | "finished",
  subject: string,
): string {
  return count === 1 && total === 1 && subject.trim() ? state : `${count}/${total} ${state}`;
}

type AdmittedRun = NonNullable<
  NonNullable<SubagentStartDetails["startFailures"]>[number]["admittedRun"]
>;
const retryMessages = {
  eligible: "the launch can be retried",
  pending: "retry waits for cleanup to settle",
  blocked: "automatic retry is blocked",
  exhausted: "no profile options remain to retry",
  unavailable: "no route is left to retry",
} satisfies Record<AdmittedRun["retryDisposition"], string>;

const launchFailureIssue = (
  failure: SubagentCardFailure,
  label: string,
  uncertain: boolean,
): CompactIssue => ({
  severity: uncertain ? "warning" : "error",
  code: `launch:${failure.index}:start-failed`,
  message: uncertain
    ? `${label} may have started; startup and cleanup couldn't be confirmed`
    : `${label} couldn't start: ${failureMessage(failure.message, "startup failed", QUOTED_TEXT_LIMIT)}`,
  detail: `${failure.code ? `[${failure.code}] ` : ""}${failure.message}`,
});

/** Launch receipts own start counters, launch-slot issues, and start outcome. */
export function summarizeStart(
  details: SubagentStartDetails,
  phase: CompactPhase,
  summary: CompactSummary,
  issues: CompactIssue[],
): CompactSummary {
  const started = details.startEntries.filter((entry) => entry.status === "started").length;
  summary.counters = [
    progressDetail(started, details.startEntries.length, "started", summary.subject),
  ];
  for (const entry of details.startEntries) {
    const label = entry.name.slice(0, 60);
    if (entry.routeStatus === "selected" && entry.warning)
      issues.push({
        severity: "warning",
        code: `launch:${entry.index}:warning`,
        ...quoted(label, entry.warning, "has a launch option warning"),
      });
    if (
      entry.status === "failed" &&
      !details.startFailures?.some((failure) => failure.index === entry.index)
    )
      issues.push({
        severity: "error",
        code: `launch:${entry.index}:failed`,
        message: `${label} couldn't start`,
        detail: "Inspect expanded launch evidence.",
      });
  }
  for (const failure of details.startFailures ?? []) {
    const label = (failure.name ?? `Launch ${failure.index + 1}`).slice(0, 60);
    const uncertain = isUncertainToolFailure(failure);
    issues.push(launchFailureIssue(failure, label, uncertain));
    const recovery = failure.admittedRun;
    if (!recovery) {
      // A missing receipt is not proof that the launch had no effects.
      issues.push({
        severity: "warning",
        code: `launch:${failure.index}:recovery-unknown`,
        message: `${label}: ownership and cleanup are unknown`,
        detail: uncertain
          ? "Do not retry or launch a replacement while outcome or cleanup is unconfirmed. Inspect full launch details and status before recovery. Missing retry data does not establish eligibility."
          : "Inspect full launch details and status for ownership and cleanup before recovery. Missing retry data does not establish eligibility.",
      });
      continue;
    }
    const confirmed = recovery.cleanupDisposition === "confirmed";
    // One line per launch: cleanup and what it allows next.
    issues.push({
      // Confirmed cleanup is a recovery fact, not a problem; the start error already warns.
      severity: confirmed ? "info" : "warning",
      code: `run:${recovery.runId}:cleanup-receipt`,
      message: `${label}: ${confirmed ? `cleanup is confirmed; ${retryMessages[recovery.retryDisposition]}` : "cleanup isn't confirmed; processes may still be running"}`,
      detail: [
        formatFailedStartRecovery(recovery),
        confirmed
          ? failedStartRecoveryAction(recovery)
          : "Do not retry or launch a replacement while cleanup is pending or quarantined. Inspect full subagent_status and confirm process and writer cleanup before recovery.",
      ].join("\n"),
    });
  }
  if (compactIssueSeverity(issues) === "error") summary.outcome = "error";
  else if (phase === "settled" && started !== details.startEntries.length)
    summary.outcome = "uncertain";
  return summary;
}
