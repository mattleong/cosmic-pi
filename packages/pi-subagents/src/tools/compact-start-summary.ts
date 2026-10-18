import { compactIssueSeverity } from "pi-code-previews";
import type { CompactIssue, CompactPhase, CompactSummary } from "pi-code-previews";
import { QUOTED_TEXT_LIMIT, quoted } from "./compact-run-issues.ts";
import type { SubagentCardFailure, SubagentStartDetails } from "./details-schema.ts";
import { failedStartRecoveryAction, formatFailedStartRecovery } from "./format.ts";
import { isUncertainToolFailure } from "./outcome.ts";
import { failureMessage } from "pi-cosmic-core";

type AdmittedRun = NonNullable<
  NonNullable<SubagentStartDetails["startFailures"]>[number]["admittedRun"]
>;
const retryMessages = {
  eligible: "the launch can be retried",
  pending: "the launch can be retried",
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
    ? `${label} may have started`
    : `${label} couldn't start: ${failureMessage(failure.message, "startup failed", QUOTED_TEXT_LIMIT)}`,
  detail: [
    `${failure.code ? `[${failure.code}] ` : ""}${failure.message}`,
    ...(uncertain && !failure.admittedRun
      ? ["List runs with subagent_status before retrying or launching a replacement."]
      : []),
  ].join("\n"),
});

const startedCounter = (started: number, total: number, subject: string): string =>
  started === 1 && total === 1 && subject.trim() ? "started" : `${started}/${total} started`;

export function summarizeStart(
  details: SubagentStartDetails,
  phase: CompactPhase,
  summary: CompactSummary,
  issues: CompactIssue[],
): CompactSummary {
  const started = details.startEntries.filter((entry) => entry.status === "started").length;
  const total = details.startEntries.length;
  summary.counters = [startedCounter(started, total, summary.subject)];
  for (const entry of details.startEntries) {
    const label = entry.name.slice(0, 60);
    if (entry.routeStatus === "selected" && entry.warning)
      issues.push({
        severity: "warning",
        code: `launch:${entry.index}:warning`,
        ...quoted(label, entry.warning, "has a launch option warning"),
      });
  }
  for (const failure of details.startFailures ?? []) {
    const label = (failure.name ?? `Launch ${failure.index + 1}`).slice(0, 60);
    const uncertain = isUncertainToolFailure(failure);
    issues.push(launchFailureIssue(failure, label, uncertain));
    const recovery = failure.admittedRun;
    if (!recovery) continue;
    const quarantined = recovery.cleanupDisposition === "quarantined";
    issues.push({
      severity: quarantined ? "warning" : "info",
      code: `run:${recovery.runId}:retry-receipt`,
      message: `${label}: ${quarantined ? "cleanup is quarantined" : retryMessages[recovery.retryDisposition]}`,
      detail: [formatFailedStartRecovery(recovery), failedStartRecoveryAction(recovery)].join("\n"),
    });
  }
  if (compactIssueSeverity(issues) === "error") summary.outcome = "error";
  else if (phase === "settled" && started !== total) summary.outcome = "uncertain";
  return summary;
}
