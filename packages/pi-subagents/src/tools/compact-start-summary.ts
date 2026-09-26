import { compactIssueSeverity } from "pi-code-previews";
import type { CompactIssue, CompactPhase, CompactSummary } from "pi-code-previews";
import type { SubagentStartDetails } from "./details-schema.ts";
import { failedStartRecoveryAction, formatFailedStartRecovery } from "./format.ts";

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
  eligible: "The launch can be retried",
  pending: "Retry must wait until cleanup settles",
  blocked: "Automatic retry is blocked",
  exhausted: "The profile route is exhausted",
  unavailable: "The launch has no route to retry",
} satisfies Record<AdmittedRun["retryDisposition"], string>;

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
        message: `${label}: A worker option produced a warning`,
        detail: entry.warning,
      });
    if (
      entry.status === "failed" &&
      !details.startFailures?.some((failure) => failure.index === entry.index)
    )
      issues.push({
        severity: "error",
        code: `launch:${entry.index}:failed`,
        message: `${label}: Launch failed`,
        detail: "Inspect expanded launch evidence.",
      });
  }
  for (const failure of details.startFailures ?? []) {
    const label = (failure.name ?? `Launch ${failure.index + 1}`).slice(0, 60);
    issues.push({
      severity: "error",
      code: `launch:${failure.index}:start-failed`,
      message: `${label}: ${failure.code === "get_state_outcome_uncertain" ? "Could not confirm startup; work may have started" : "Startup reported an error"}`,
      detail: `${failure.code ? `[${failure.code}] ` : ""}${failure.message}`,
    });
    const recovery = failure.admittedRun;
    if (!recovery) {
      issues.push({
        severity: "warning",
        code: `launch:${failure.index}:recovery-unknown`,
        message: `${label}: Worker ownership and cleanup status are unknown`,
        detail:
          "Inspect full launch details and status for ownership and cleanup before recovery. Missing retry data does not establish eligibility.",
      });
      continue;
    }
    const confirmed = recovery.cleanupDisposition === "confirmed";
    issues.push(
      {
        // Confirmed cleanup is a recovery fact, not a problem; the start error already warns.
        severity: confirmed ? "info" : "warning",
        code: `run:${recovery.runId}:cleanup-receipt`,
        message: `${label}: ${confirmed ? "Worker cleanup is confirmed" : "Worker cleanup is not confirmed; processes may still be running"}`,
        detail: formatFailedStartRecovery(recovery),
      },
      {
        severity: "info",
        code: `run:${recovery.runId}:retry-gate`,
        message: `${label}: ${confirmed ? retryMessages[recovery.retryDisposition] : "Do not retry until cleanup is confirmed"}`,
        detail: confirmed
          ? failedStartRecoveryAction(recovery)
          : "Do not retry or launch a replacement while cleanup is pending or quarantined. Inspect full subagent_status and confirm process and writer cleanup before recovery.",
      },
    );
  }
  if (compactIssueSeverity(issues) === "error") summary.outcome = "error";
  else if (phase === "settled" && started !== details.startEntries.length)
    summary.outcome = "uncertain";
  return summary;
}
