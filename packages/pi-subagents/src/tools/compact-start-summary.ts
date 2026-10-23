import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { compactIssueSeverity } from "pi-code-previews";
import type { CompactIssue, CompactPhase, CompactSummary } from "pi-code-previews";
import { QUOTED_TEXT_LIMIT, quoted } from "./compact-run-issues.ts";
import type { SubagentCardFailure, SubagentStartDetails } from "./details-schema.ts";
import { failedStartRecoveryAction, formatFailedStartRecovery } from "./format.ts";
import { isUncertainToolFailure } from "./outcome.ts";
import { failureMessage } from "pi-cosmic-core/message-text";

type AdmittedRun = NonNullable<
  NonNullable<SubagentStartDetails["startFailures"]>[number]["admittedRun"]
>;

const admittedRunMessage = ({ cleanupDisposition, nextCandidate }: AdmittedRun): string =>
  cleanupDisposition === "quarantined"
    ? "cleanup is quarantined"
    : nextCandidate === undefined
      ? "it was admitted before failing"
      : nextCandidate === "none"
        ? "its route has no other model"
        : "its route has another model to try";

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
  detail: Arr.join(
    [
      `${failure.code ? `[${failure.code}] ` : ""}${failure.message}`,
      ...(uncertain && !failure.admittedRun
        ? [
            "List runs with agent_list and inspect them with agent_read before retrying or launching a replacement.",
          ]
        : []),
    ],
    "\n",
  ),
});

const startedCounter = (started: number, total: number, subject: string): string =>
  started === 1 && total === 1 && Str.trim(subject) ? "started" : `${started}/${total} started`;

export function summarizeStart(
  details: SubagentStartDetails,
  phase: CompactPhase,
  summary: CompactSummary,
  issues: CompactIssue[],
): CompactSummary {
  const started = Arr.filter(details.startEntries, (entry) => entry.status === "started").length;
  const total = details.startEntries.length;
  summary.counters = [startedCounter(started, total, summary.subject)];
  for (const entry of details.startEntries) {
    const label = Fn.pipe(entry.name, Str.slice(0, 60));
    if (entry.routeStatus === "selected" && entry.warning)
      issues.push({
        severity: "warning",
        code: `launch:${entry.index}:warning`,
        ...quoted(label, entry.warning, "has a launch option warning"),
      });
  }
  for (const failure of details.startFailures ?? []) {
    const label = Fn.pipe(failure.name ?? `Launch ${failure.index + 1}`, Str.slice(0, 60));
    const uncertain = isUncertainToolFailure(failure);
    issues.push(launchFailureIssue(failure, label, uncertain));
    const recovery = failure.admittedRun;
    if (!recovery) continue;
    const quarantined = recovery.cleanupDisposition === "quarantined";
    issues.push({
      severity: quarantined ? "warning" : "info",
      code: `run:${recovery.runId}:admitted-run`,
      message: `${label}: ${admittedRunMessage(recovery)}`,
      detail: Arr.join(
        [formatFailedStartRecovery(recovery), failedStartRecoveryAction(recovery)],
        "\n",
      ),
    });
  }
  if (compactIssueSeverity(issues) === "error") summary.outcome = "error";
  else if (phase === "settled" && started !== total) summary.outcome = "uncertain";
  return summary;
}
