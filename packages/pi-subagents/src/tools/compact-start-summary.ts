import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { compactIssueSeverity } from "pi-code-previews";
import type { CompactIssue, CompactPhase, CompactSummary } from "pi-code-previews";
import { QUOTED_TEXT_LIMIT, quoted } from "./compact-run-issues.ts";
import type { SubagentCardFailure, SubagentStartDetails } from "./details-schema.ts";
import { isUncertainToolFailure, MODEL_ROUTE_FAILURE_CODES, ROUTE_RECOVERY } from "./outcome.ts";
import { failureMessage, restatesText } from "pi-cosmic-core/message-text";
import { indexOfFrom } from "pi-cosmic-core/text-scan";
import { nextCandidateFact, savedFileFact } from "../ui/notice-facts.ts";

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

/**
 * What a launch failure's detail adds to its issue: the failure after the first line the issue
 * already quotes whole, or all of it otherwise, then the route's next step when its model or
 * sign-in failed.
 */
const launchFailureDetail = (failure: SubagentCardFailure, quote: string | undefined): string => {
  const text = Str.trim(failure.message);
  const lineEnd = indexOfFrom(text, "\n", 0);
  const [first, rest] =
    lineEnd === -1
      ? [text, ""]
      : [Fn.pipe(text, Str.slice(0, lineEnd)), Fn.pipe(text, Str.slice(lineEnd + 1), Str.trim)];
  const account = quote !== undefined && restatesText(first, quote) ? rest : text;
  const recovery =
    MODEL_ROUTE_FAILURE_CODES.includes(failure.code ?? "") &&
    !Fn.pipe(account, Str.includes("/subagents doctor"))
      ? ROUTE_RECOVERY
      : "";
  return Arr.join(Arr.filter([account, recovery], Str.isNonEmpty), "\n\n");
};

/**
 * A launch that failed or may have started. Beneath a heading that names the lone launch, whose
 * glyph says it failed or is unconfirmed, the issue states only the cause.
 */
const launchFailureIssue = (
  failure: SubagentCardFailure,
  label: string,
  uncertain: boolean,
  named: boolean,
): CompactIssue => {
  const quote =
    uncertain && !named
      ? undefined
      : failureMessage(
          failure.message,
          uncertain ? "it may have started" : "startup failed",
          QUOTED_TEXT_LIMIT,
        );
  const detail = launchFailureDetail(failure, quote);
  return {
    severity: uncertain ? "warning" : "error",
    code: `launch:${failure.index}:start-failed`,
    message:
      quote === undefined
        ? `${label} may have started`
        : named
          ? quote
          : `${label} couldn't start: ${quote}`,
    ...(detail && { detail }),
  };
};

/** A lone named launch's glyph says whether it started, so it counts only a batch. */
const startedCounter = (started: number, total: number, subject: string): string[] =>
  total === 1 && Str.trim(subject) ? [] : [`${started}/${total} started`];

export function summarizeStart(
  details: SubagentStartDetails,
  phase: CompactPhase,
  summary: CompactSummary,
  issues: CompactIssue[],
): CompactSummary {
  const started = Arr.countBy(details.startEntries, (entry) => entry.status === "started");
  const total = details.startEntries.length;
  summary.counters = startedCounter(started, total, summary.subject);
  const named = total === 1 && Str.isNonEmpty(Str.trim(summary.subject));
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
    issues.push(launchFailureIssue(failure, label, uncertain, named));
    const recovery = failure.admittedRun;
    if (!recovery) continue;
    const quarantined = recovery.cleanupDisposition === "quarantined";
    issues.push({
      severity: quarantined ? "warning" : "info",
      code: `run:${recovery.runId}:admitted-run`,
      message: `${label}: ${admittedRunMessage(recovery)}`,
      detail: Arr.join(
        [
          `Admitted as ${recovery.runId}${recovery.cleanupDisposition === "quarantined" ? "; its cleanup is unconfirmed" : ""}`,
          ...(recovery.nextCandidate ? [nextCandidateFact(recovery.nextCandidate)] : []),
          ...(recovery.failureFile ? [savedFileFact("Failure file", recovery.failureFile)] : []),
        ],
        "\n",
      ),
    });
    // The start result replaces the run's notice, so it carries the warning that notice would.
    if (recovery.warning)
      issues.push({
        severity: "warning",
        code: `run:${recovery.runId}:warning`,
        ...quoted(label, recovery.warning, "reported a warning"),
      });
  }
  if (compactIssueSeverity(issues) === "error") summary.outcome = "error";
  else if (phase === "settled" && started !== total) summary.outcome = "uncertain";
  return summary;
}
