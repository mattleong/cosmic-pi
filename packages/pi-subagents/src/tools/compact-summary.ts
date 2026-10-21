import { compactIssueSeverity } from "pi-code-previews";
import * as Predicate from "effect/Predicate";
import { countLabel } from "pi-cosmic-core";
import { hasUnresolvedSteeringDelivery } from "../run/model.ts";
import { runCleanupAttention } from "../run/attention.ts";
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
import { SUBAGENT_TOOL_NAME, type SubagentToolName } from "../run/tool-policy.ts";
import { decodeSubagentOutcomeDetails, hasSubagentToolFailure } from "./outcome.ts";
import { actionFailureIssues } from "./compact-action-failures.ts";
import {
  applyArgumentLanes,
  argumentSummary,
  projectedSubject,
  rejectedCall,
  requestedRunIds,
  type SummaryArguments,
} from "./compact-heading.ts";
import {
  compactAttentionIssues,
  compactRunIssues,
  hasChangesToReview,
} from "./compact-run-issues.ts";
import { compactWorkspaceSummary } from "./compact-workspace-summary.ts";
import { summarizeStart } from "./compact-start-summary.ts";

function cardCounters(cards: readonly SubagentRunCard[], singleTarget = false): string[] {
  const [only] = cards;
  if (cards.length === 1 && singleTarget && only) return [runStateLabel(only.state)];
  const counts = new Map<string, number>();
  for (const card of cards) {
    const label = runStateLabel(card.state);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [[...counts].map(([label, count]) => `${count} ${label}`).join(", ")].filter(Boolean);
}

const TOOL_ACTIONS: Readonly<Record<SubagentToolName, string>> = {
  [SUBAGENT_TOOL_NAME.models]: "models",
  [SUBAGENT_TOOL_NAME.start]: "start",
  [SUBAGENT_TOOL_NAME.await]: "await",
  [SUBAGENT_TOOL_NAME.lifecycle]: "lifecycle",
  [SUBAGENT_TOOL_NAME.workspace]: "workspace",
};

export function createSubagentCompactSummary(toolName: SubagentToolName): CompactSummaryProvider {
  const action = TOOL_ACTIONS[toolName];
  return ({ phase, args, result, context }) => {
    if (!Predicate.isObject(args)) return undefined;
    const input: SummaryArguments = args;
    const operation = Predicate.isString(input.action) ? input.action : action;
    const lanes = argumentSummary(input, action, operation);
    if (!result) return context.isError || phase === "settled" ? undefined : lanes;
    if (action === "workspace" && !context.isError)
      return compactWorkspaceSummary(result, operation);
    const details =
      action === "workspace" ? undefined : decodeSubagentOutcomeDetails(operation, result);
    if (!details)
      return context.isError && phase === "settled"
        ? rejectedCall(input, action, operation, lanes, result)
        : undefined;
    if (context.isError && !hasSubagentToolFailure(details)) return undefined;
    return summarizeReceipt(details, input, phase, lanes);
  };
}

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
    projectedSubject(details, input, lanes.subject, targets),
    targets,
    requestedRunIds(input),
  );
  applyArgumentLanes(summary, details, phase, lanes);
  return summary;
}

function awaitCounter(cards: readonly SubagentRunCard[], total: number, subject: string): string {
  const [only] = cards;
  if (cards.length === 1 && total === 1 && subject.trim() && only) return runStateLabel(only.state);
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
  asking: readonly SubagentRunCard[],
): void {
  summary.counters = [awaitCounter(cards, targets.length, summary.subject)];
  if (cards.length < targets.length) {
    issues.push({
      severity: "warning",
      code: "targets-omitted",
      message: "Some requested subagents have no available status",
      detail:
        "Some requested targets have no projected state; inspect them with agent_read before acting.",
    });
    if (summary.outcome === "success") summary.outcome = "uncertain";
  }
  if (details.contextOmitted)
    issues.push({
      severity: "info",
      code: "descendant-context",
      message: "Descendant subagents are shown for context only",
      detail:
        "Descendants are context only; this await summarizes requested targets. Inspect descendants with agent_read.",
    });
  if (details.cancelled && details.endedByUserInput) {
    // The wait ended for the user, not because the targets succeeded.
    if (summary.outcome === "success") summary.outcome = "returned";
    issues.push({
      severity: "info",
      code: "await-user-input",
      message: "Stopped waiting to read your message; subagents keep running",
      detail:
        "Await ended for new user input; child runs were NOT stopped. Await the requested targets again when their results are needed.",
    });
  } else if (details.cancelled && details.timedOutSeconds !== undefined) {
    summary.outcome = "warning";
    issues.push({
      severity: "warning",
      code: "await-timed-out",
      message: `Stopped waiting after ${details.timedOutSeconds}s; subagents keep running`,
      detail:
        "Await timed out; child runs were NOT stopped. Await the requested targets again or inspect them with agent_read.",
    });
  } else if (details.cancelled) {
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
        : "Await cancelled; child runs were NOT stopped. Await the requested targets again when needed.",
    });
  }
  if (
    details.attentionRequired &&
    asking.length === 0 &&
    !cards.some(
      (card) =>
        card.question !== undefined ||
        runCleanupAttention(card) !== undefined ||
        card.state === "paused" ||
        card.state === "waiting_for_parent",
    )
  )
    issues.push({
      severity: "warning",
      code: "parent-action",
      message: "A subagent needs attention before it can continue",
      detail:
        "Parent action required; inspect the targets with agent_read for the question or pause capabilities before acting.",
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
    if (summary.outcome === "success") summary.outcome = "uncertain";
    issues.push({
      severity: "warning",
      code: "runs-omitted",
      message: "Only some subagents are shown",
      detail:
        "Bounded projection, not complete fleet counts. Use agent_list and agent_read for omitted runs and their recovery.",
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
  const agents = details.agents ?? [];
  for (const agent of agents)
    if (agent.candidates.every((candidate) => candidate.status !== "eligible"))
      issues.push({
        severity: "warning",
        code: `agent:${agent.name}:unavailable`,
        message: `${agent.name} agent has no eligible options`,
        detail:
          "No statically eligible candidates after the agent's overrides; inspect expanded discovery.",
      });
  const invalidAgents = details.invalidAgents ?? [];
  if (invalidAgents.length > 0)
    issues.push({
      severity: "warning",
      code: "agents:invalid",
      message: "Some custom agents are invalid",
      detail: `${countLabel(invalidAgents.length, "invalid agent entry", "invalid agent entries")} fail closed; /subagents doctor lists the invalid fields.`,
    });
  const counters = [`${eligibleOptions} statically eligible`];

  if (disabled) counters.push(countLabel(disabled, "disabled profile"));
  if (unavailable) counters.push(countLabel(unavailable, "unavailable profile"));
  if (agents.length > 0) counters.push(countLabel(agents.length, "agent"));
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
  return requested?.length === 1 && cards.length === 1 && cards[0]?.id === requested[0];
}

function labelChangesToReview(summary: CompactSummary, cards: readonly SubagentRunCard[]): void {
  const reviewable = cards.filter(hasChangesToReview).length;
  if (reviewable === 0) return;
  const label =
    reviewable === 1 && cards.length === 1 ? "ready to apply" : `${reviewable} ready to apply`;
  const [counter, ...fallbacks] = summary.counters ?? [];
  if (counter === undefined) summary.metadata = [...(summary.metadata ?? []), label];
  else summary.counters = [`${counter} · ${label}`, counter, ...fallbacks];
}

function cardOutcome(
  action: string,
  cards: readonly SubagentRunCard[],
): NonNullable<CompactSummary["outcome"]> {
  if (cards.some((card) => card.state === "stopping" || hasUnresolvedSteeringDelivery(card)))
    return "uncertain";
  if (
    cards.some(
      (card) =>
        runCleanupAttention(card) !== undefined ||
        card.question !== undefined ||
        (card.state === "paused" && action !== "interrupt") ||
        card.state === "waiting_for_parent",
    )
  )
    return "warning";
  return action !== "stop" && cards.some((card) => card.state === "stopped")
    ? "cancelled"
    : "success";
}

function omissionIssue(
  details: SubagentAwaitDetails | CompactSubagentToolDetails,
  summary: CompactSummary,
  issues: CompactIssue[],
): void {
  if (!details.contentOmitted || ("reportsOnlyOmitted" in details && details.reportsOnlyOmitted))
    return;
  issues.push({
    severity: "warning",
    code: "evidence-omitted",
    message: "Some subagent details are unavailable in this view",
    detail:
      "Bounded projection: details were omitted. Inspect expanded details and agent_read for full target state, attention, and recovery before acting.",
  });
  summary.outcome = "uncertain";
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
  // An await also returns for parent attention from a run it did not target.
  const asking =
    details.action === "await" && targets
      ? details.cards.filter(
          (card) =>
            !targets.includes(card.id) &&
            (card.question !== undefined || runCleanupAttention(card) !== undefined),
        )
      : [];
  summary.counters = cardCounters(cards, isSingleRequestedRun(details, cards, requested));
  const requestedPause = details.action === "interrupt";
  if (summary.outcome === "success") summary.outcome = cardOutcome(details.action, cards);
  if (details.action === "await")
    awaitIssues(details, summary, issues, cards, targets ?? [], asking);
  else runIssues(details, summary, issues, cards);
  const quietHistory = phase === "settled" && summary.outcome === "success" && issues.length === 0;
  issues.push(...compactRunIssues(cards, { quietHistory, requestedPause }));
  issues.push(...compactAttentionIssues(asking));
  labelChangesToReview(summary, cards);
  const severity = compactIssueSeverity(issues);
  if (severity === "error") summary.outcome = "error";
  else if (summary.outcome === "success" && severity === "warning") summary.outcome = "warning";
  return summary;
}
