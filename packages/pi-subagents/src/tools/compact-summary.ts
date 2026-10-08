import { compactIssueSeverity } from "pi-code-previews";
import * as Predicate from "effect/Predicate";
import { countLabel } from "pi-cosmic-core";
import { hasUnresolvedSteeringDelivery } from "../run/model.ts";
import { runStateLabel } from "../ui/run-state.ts";
import type {
  CompactIssue,
  CompactPhase,
  CompactSummary,
  CompactSummaryProvider,
} from "pi-code-previews";
import {
  type SubagentRunCard,
  type SubagentStartDetails,
  type SubagentAwaitDetails,
  type CompactSubagentToolDetails,
} from "./details-schema.ts";
import { decodeSubagentOutcomeDetails, hasSubagentToolFailure } from "./outcome.ts";
import { actionFailureIssues } from "./compact-action-failures.ts";
import {
  applyArgumentLanes,
  argumentSummary,
  projectedSubject,
  rejectedCall,
  requestedRunIds,
  requestedTargets,
  type SummaryArguments,
} from "./compact-heading.ts";
import { compactRunIssues, hasChangesToReview } from "./compact-run-issues.ts";
import { compactWorkspaceSummary } from "./compact-workspace-summary.ts";
import { summarizeStart } from "./compact-start-summary.ts";

/** Run states in the words the run rows use: "2 running, 1 finished". */
function cardCounters(cards: readonly SubagentRunCard[], singleTarget = false): string[] {
  if (cards.length === 1 && singleTarget) return [runStateLabel(cards[0]!.state)];
  const counts = new Map<string, number>();
  for (const card of cards) {
    const label = runStateLabel(card.state);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [[...counts].map(([label, count]) => `${count} ${label}`).join(", ")].filter(Boolean);
}

/** Decoded domain summaries classify attention; original evidence stays on expansion. */
export function createSubagentCompactSummary(
  toolName: string,
): CompactSummaryProvider<unknown, unknown, unknown> {
  const action = toolName.replace(/^subagent_/, "");
  return ({ phase, args, result, context }) => {
    if (!Predicate.isObject(args)) return undefined;
    // SAFETY: Pi owns partial arguments; display fields are narrowed before use.
    const input = args as SummaryArguments;
    const operation = Predicate.isString(input.action) ? input.action : action;
    const lanes = argumentSummary(input, action, operation);
    if (!result) return context.isError || phase === "settled" ? undefined : lanes;
    if (action === "workspace" && !context.isError)
      return compactWorkspaceSummary(result.details, operation);
    // Workspace receipts are not run receipts; a failed workspace call is only its rejection.
    const details =
      action === "workspace"
        ? undefined
        : decodeSubagentOutcomeDetails(action === "claims" ? "claims" : operation, result.details);
    if (!details)
      return context.isError && phase === "settled"
        ? rejectedCall(input, action, operation, lanes, result)
        : undefined;
    if (context.isError && !hasSubagentToolFailure(details)) return undefined;
    return summarizeReceipt(details, input, phase, lanes);
  };
}

/** A decoded receipt's summary under the heading its arguments and cards give it. */
function summarizeReceipt(
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
  input: SummaryArguments,
  phase: CompactPhase,
  lanes: CompactSummary,
): CompactSummary | undefined {
  const targets =
    details.action === "await" ? (requestedRunIds(input) ?? details.awaitedRunIds) : undefined;
  if (details.action === "await" && !targets?.length) return undefined;
  const summary = summarizeDetails(
    details,
    phase,
    projectedSubject(details, input, phase, lanes.subject, targets),
    targets,
    requestedTargets(input),
  );
  applyArgumentLanes(summary, details, phase, lanes);
  return summary;
}

/**
 * A sole named target shows its state; otherwise finished targets are counted apart from
 * failed and stopped ones, in the run rows' words.
 */
function awaitCounter(cards: readonly SubagentRunCard[], total: number, subject: string): string {
  if (cards.length === 1 && total === 1 && subject.trim()) return runStateLabel(cards[0]!.state);
  const count = (states: readonly SubagentRunCard["state"][]) =>
    cards.filter((card) => states.includes(card.state)).length;
  const failed = count(["failed"]);
  const stopped = count(["stopped"]);
  return [
    `${count(["completed"])}/${total} finished`,
    ...(failed ? [`${failed} failed`] : []),
    ...(stopped ? [`${stopped} stopped`] : []),
  ].join(", ");
}

function awaitIssues(
  details: SubagentAwaitDetails,
  summary: CompactSummary,
  issues: CompactIssue[],
  cards: readonly SubagentRunCard[],
  targets: readonly string[],
): void {
  summary.counters = [awaitCounter(cards, targets.length, summary.subject)];
  if (cards.length < targets.length) {
    issues.push({
      severity: "warning",
      code: "targets-omitted",
      message: "Some requested subagents have no available status",
      detail:
        "Some requested targets have no projected state; inspect subagent_status before acting.",
    });
    if (summary.outcome === "success") summary.outcome = "uncertain";
  }
  if (details.contextOmitted)
    issues.push({
      severity: "info",
      code: "descendant-context",
      message: "Descendant subagents are shown for context only",
      detail:
        "Descendants are context only; this await summarizes requested targets. Inspect subagent_list or subagent_status for descendant state.",
    });
  if (details.cancelled) {
    summary.outcome = "cancelled";
    const unconfirmed = details.cancellationCleanup === "unconfirmed";
    issues.push({
      severity: "warning",
      code: "await-cancelled",
      message: unconfirmed
        ? "Waiting was cancelled; subagents were not stopped and wait cleanup is unconfirmed"
        : "Waiting was cancelled; subagents were not stopped",
      detail: unconfirmed
        ? "Local await cancelled; child runs were NOT stopped. Root completion-claim cleanup is unconfirmed; claims may remain and an immediate replacement await may fail with completion_claim_conflict."
        : "Await cancelled; child runs were NOT stopped. Wait cleanup is complete; await the requested targets again when needed.",
    });
  }
  if (
    details.attentionRequired &&
    !cards.some(
      (card) =>
        card.question ||
        card.writeAdmissionPaused ||
        card.state === "paused" ||
        card.state === "waiting_for_parent",
    )
  )
    issues.push({
      severity: "warning",
      code: "parent-action",
      message: "A subagent needs attention before it can continue",
      detail:
        "Parent action required; inspect full target subagent_status for the question, pause capabilities, or claim containment before acting.",
    });
  if (details.attentionRequired && !details.cancelled) summary.outcome = "warning";
}

function runIssues(
  details: Exclude<CompactSubagentToolDetails, { action: "models" }>,
  summary: CompactSummary,
  issues: CompactIssue[],
  cards: readonly SubagentRunCard[],
): void {
  if (details.runCount > details.cards.length) {
    summary.counters = [
      `${details.cards.length}/${details.runCount} shown, ${cardCounters(cards).join(", ")}`,
    ];
    // A bounded projection cannot confirm counts it does not show.
    if (summary.outcome === "success") summary.outcome = "uncertain";
    issues.push({
      severity: "warning",
      code: "runs-omitted",
      message: "Only some subagents are shown",
      detail:
        "Bounded projection, not complete fleet counts. Use subagent_status for omitted runs and their recovery.",
    });
  }
  actionFailureIssues(details.action, details.actionFailures ?? [], details.cards, summary, issues);
}

function summarizeModels(
  details: Extract<CompactSubagentToolDetails, { action: "models" }>,
  summary: CompactSummary,
  issues: CompactIssue[],
): CompactSummary {
  let disabled = 0;
  let unavailable = 0;
  let eligibleOptions = 0;

  for (const profile of details.profiles) {
    const invalid = profile.source === "global-invalid" || profile.source === "project-invalid";
    // Invalid configuration cannot establish eligibility, even if a historical card says so.
    const options = invalid
      ? 0
      : profile.candidates.filter((candidate) => candidate.status === "eligible").length;
    eligibleOptions += options;

    if (invalid || (profile.candidates.length > 0 && options === 0)) {
      unavailable++;
      issues.push({
        severity: "warning",
        code: `profile:${profile.id}:unavailable`,
        message: `${profile.id} profile has ${invalid ? "invalid settings" : "no eligible options"}`,
        detail: `${invalid ? "Invalid profile configuration" : "No statically eligible candidates"}; inspect expanded discovery.`,
      });
    } else if (profile.candidates.length === 0) disabled++;
  }
  const counters = [`${eligibleOptions} statically eligible`];

  if (disabled) counters.push(`${countLabel(disabled, "disabled profile")}`);
  if (unavailable) counters.push(`${countLabel(unavailable, "unavailable profile")}`);
  summary.counters = [counters.join(", ")];
  if (summary.outcome === "success" && compactIssueSeverity(issues) === "warning")
    summary.outcome = "warning";
  return summary;
}

function isSingleRequestedRun(
  details: SubagentAwaitDetails | Exclude<CompactSubagentToolDetails, { action: "models" }>,
  cards: readonly SubagentRunCard[],
  requested: readonly string[] | undefined,
): boolean {
  if (details.action === "await" || details.runCount !== 1) return false;
  return requested?.length
    ? requested.length === 1 &&
        cards.length === 1 &&
        (cards[0]?.id === requested[0] || details.action === "retry")
    : details.action === "list" || details.action === "status";
}

/** Reported changes awaiting review are routine: a heading label, never a warning. */
function labelChangesToReview(summary: CompactSummary, cards: readonly SubagentRunCard[]): void {
  const reviewable = cards.filter(hasChangesToReview).length;
  if (reviewable === 0) return;
  const label =
    reviewable === 1 && cards.length === 1
      ? "changes ready for review"
      : `${reviewable} with changes to review`;
  // Collapsed rows show one routine detail, so the label joins the counter while it fits.
  const [counter, ...fallbacks] = summary.counters ?? [];
  if (counter === undefined) summary.metadata = [...(summary.metadata ?? []), label];
  else summary.counters = [`${counter} · ${label}`, counter, ...fallbacks];
}

/** What the observed runs make of a successful call: uncertain, needing attention, or ended. */
function cardOutcome(
  action: string,
  cards: readonly SubagentRunCard[],
): NonNullable<CompactSummary["outcome"]> {
  if (cards.some((card) => card.state === "stopping" || hasUnresolvedSteeringDelivery(card)))
    return "uncertain";
  if (
    cards.some(
      (card) =>
        card.writeAdmissionPaused ||
        card.question ||
        (card.state === "paused" && action !== "interrupt") ||
        card.state === "waiting_for_parent",
    )
  )
    return "warning";
  return action !== "stop" && cards.some((card) => card.state === "stopped")
    ? "cancelled"
    : "success";
}

/** Report text a view leaves out: one routine note for a list, uncertainty elsewhere. */
function omissionIssue(
  details: SubagentAwaitDetails | CompactSubagentToolDetails,
  summary: CompactSummary,
  issues: CompactIssue[],
): void {
  if (!details.contentOmitted || ("reportsOnlyOmitted" in details && details.reportsOnlyOmitted))
    return;
  // A list never carries report or error text, so leaving it out is one routine note.
  const listed = details.action === "list";
  issues.push({
    severity: listed ? "info" : "warning",
    code: "evidence-omitted",
    message: listed
      ? "Reports and some details are left out of this list"
      : "Some subagent details are unavailable in this view",
    detail:
      "Bounded projection: details were omitted. Inspect expanded details and subagent_status for full target state, attention, and recovery before acting.",
  });
  if (!listed) summary.outcome = "uncertain";
}

function summarizeDetails(
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
  phase: CompactPhase,
  subject: string,
  targets?: readonly string[],
  requested?: readonly string[],
): CompactSummary {
  const issues: CompactIssue[] = [];
  const summary: CompactSummary = { subject, metadata: [], issues };
  if (phase === "settled") summary.outcome = "success";
  if (details.action === "start") return summarizeStart(details, phase, summary, issues);
  omissionIssue(details, summary, issues);
  if (details.action === "models") return summarizeModels(details, summary, issues);
  const cards = targets ? details.cards.filter((card) => targets.includes(card.id)) : details.cards;
  summary.counters = cardCounters(cards, isSingleRequestedRun(details, cards, requested));
  // A pause or stop the call asked for is its result, not attention or a cancellation.
  const requestedPause = details.action === "interrupt";
  if (summary.outcome === "success") summary.outcome = cardOutcome(details.action, cards);
  if (details.action === "await") awaitIssues(details, summary, issues, cards, targets!);
  else runIssues(details, summary, issues, cards);
  const quietHistory = phase === "settled" && summary.outcome === "success" && issues.length === 0;
  issues.push(...compactRunIssues(cards, { quietHistory, requestedPause }));
  labelChangesToReview(summary, cards);
  const severity = compactIssueSeverity(issues);
  if (severity === "error") summary.outcome = "error";
  else if (summary.outcome === "success" && severity === "warning") summary.outcome = "warning";
  return summary;
}
