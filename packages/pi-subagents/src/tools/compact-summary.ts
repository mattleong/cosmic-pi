import { compactIssueSeverity } from "pi-code-previews";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { countLabel } from "pi-cosmic-core/display";
import { runCleanupAttention } from "../run/attention.ts";
import { runStateLabel } from "../ui/run-state.ts";
import type {
  CompactIssue,
  CompactPhase,
  CompactSummary,
  CompactSummaryProvider,
} from "pi-code-previews";
import {
  type AwaitAgentMessagesCard,
  type SubagentProfileCandidateCard,
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
import { profileRow } from "./render-management.ts";
import { cardShowsError } from "./render-run-cards.ts";
import { formatRunRoute } from "../ui/run-presentation.ts";

function cardCounters(
  cards: readonly SubagentRunCard[],
  singleTarget = false,
  action = "",
): string[] {
  // A stop found a finished run already ended; plain "finished" reads as the stop's result.
  const label = (card: SubagentRunCard) =>
    action === "stop" && (card.state === "completed" || card.state === "failed")
      ? `already ${runStateLabel(card.state)}`
      : runStateLabel(card.state);
  const [only] = cards;
  if (cards.length === 1 && singleTarget && only) return [label(only)];
  const counts = new Map<string, number>();
  for (const card of cards) {
    counts.set(label(card), (counts.get(label(card)) ?? 0) + 1);
  }
  return Arr.filter(
    [
      Fn.pipe(
        [...counts],
        Arr.map(([state, count]) => `${count} ${state}`),
        Arr.join(", "),
      ),
    ],
    Boolean,
  );
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
  if (cards.length === 1 && total === 1 && Str.trim(subject) && only)
    return runStateLabel(only.state);
  const count = (states: readonly SubagentRunCard["state"][]) =>
    Arr.filter(cards, (card) => states.includes(card.state)).length;
  const failed = count(["failed"]);
  const stopped = count(["stopped"]);
  return Arr.join(
    [
      `${count(["completed"])}/${total} finished`,
      ...(failed ? [`${failed} failed`] : []),
      ...(stopped ? [`${stopped} stopped`] : []),
    ],
    ", ",
  );
}

const senderLabel = ({ id, name }: AwaitAgentMessagesCard["senders"][number]): string =>
  name !== id ? Fn.pipe(name, Str.slice(0, 48)) : id === "main" ? "the main agent" : "an agent";

/** Agent messages that reached the caller during the wait, which may have returned for them. */
function agentMessageIssue(
  messages: AwaitAgentMessagesCard,
  summary: CompactSummary,
): CompactIssue {
  // The recorded outcome: the cards can't show every question, or targets without a card.
  const waitEnded = messages.endedWait === true;
  const [only] = messages.senders;
  const one = messages.count === 1 && only !== undefined;
  const from = Arr.join(
    Arr.map(messages.senders, ({ id, name }) => (name === id ? id : `${id} (${name})`)),
    ", ",
  );
  const arrived = one
    ? `an agent message from ${from}`
    : `${countLabel(messages.count, "agent message")} from ${from}`;
  if (waitEnded && summary.outcome === "success") summary.outcome = "returned";
  return {
    severity: "info",
    code: "await-agent-message",
    message: waitEnded
      ? `Stopped waiting to read ${one ? `a message from ${senderLabel(only)}` : countLabel(messages.count, "agent message")}; subagents keep running`
      : one
        ? `A message from ${senderLabel(only)} arrived with these results`
        : `${countLabel(messages.count, "agent message")} arrived with these results`,
    detail: `${waitEnded ? "The wait ended for" : "These results also note"} ${arrived}.`,
  };
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
    });
    if (summary.outcome === "success") summary.outcome = "uncertain";
  }
  if (details.contextOmitted)
    issues.push({
      severity: "info",
      code: "descendant-context",
      message: "Descendant subagents are shown for context only",
      detail: "This wait summarizes the subagents it was asked about.",
    });
  if (details.cancelled && details.endedByUserInput) {
    // The wait ended for the user, not because the targets succeeded.
    if (summary.outcome === "success") summary.outcome = "returned";
    issues.push({
      severity: "info",
      code: "await-user-input",
      message: "Stopped waiting to read your message; subagents keep running",
    });
  } else if (details.cancelled && details.timedOutSeconds !== undefined) {
    summary.outcome = "warning";
    issues.push({
      severity: "warning",
      code: "await-timed-out",
      message: `Stopped waiting after ${details.timedOutSeconds}s; subagents keep running`,
    });
  } else if (details.agentMessages) {
    issues.push(agentMessageIssue(details.agentMessages, summary));
  } else if (details.cancelled) {
    summary.outcome = "cancelled";
    const unconfirmed = details.cancellationCleanup === "unconfirmed";
    issues.push({
      severity: "warning",
      code: "await-cancelled",
      message: unconfirmed
        ? "Waiting was cancelled; subagents were not stopped and wait cleanup is unconfirmed"
        : "Waiting was cancelled; subagents were not stopped",
      ...(unconfirmed && {
        detail:
          "The wait's claims on completions may remain until their cleanup is confirmed, so a new wait may briefly conflict with them.",
      }),
    });
  }
  if (
    details.attentionRequired &&
    asking.length === 0 &&
    !Arr.some(
      cards,
      (card) =>
        isAsking(card) || runCleanupAttention(card) !== undefined || card.state === "paused",
    )
  )
    issues.push({
      severity: "warning",
      code: "parent-action",
      message: "A subagent needs attention before it can continue",
    });
  if (details.attentionRequired && !details.cancelled) {
    // A problem outranks every outcome; a question or a held run outranks only routine ones.
    const outcome = parentActionOutcome([...cards, ...asking]);
    if (outcome === "warning" || summary.outcome === "success" || summary.outcome === "returned")
      summary.outcome = outcome;
  }
}

function runIssues(
  details: Exclude<CompactSubagentToolDetails, { action: "models" }>,
  summary: CompactSummary,
  issues: CompactIssue[],
  cards: readonly SubagentRunCard[],
): void {
  if (details.runCount > details.cards.length) {
    summary.counters = [
      `${details.cards.length}/${details.runCount} shown, ${Arr.join(cardCounters(cards), ", ")}`,
    ];
    if (summary.outcome === "success") summary.outcome = "uncertain";
    issues.push({
      severity: "warning",
      code: "runs-omitted",
      message: "Only some subagents are shown",
      detail: "This view is bounded, so its counts cover only the subagents it shows.",
    });
  }
  actionFailureIssues(details.action, details.actionFailures ?? [], details.cards, summary, issues);
}

/** A skipped candidate per line with its reason, as a route issue's detail. */
const skippedReasons = (candidates: ReadonlyArray<SubagentProfileCandidateCard>): string =>
  Arr.join(
    Arr.map(
      Arr.filter(candidates, (candidate) => candidate.status === "skipped"),
      (candidate) => `${formatRunRoute(candidate)}: ${candidate.reason}`,
    ),
    "\n",
  );

function summarizeModels(
  details: Extract<CompactSubagentToolDetails, { action: "models" }>,
  summary: CompactSummary,
  issues: CompactIssue[],
): CompactSummary {
  let disabled = 0;
  let unavailable = 0;

  for (const profile of details.profiles) {
    const invalid = profile.source === "global-invalid" || profile.source === "project-invalid";
    const options = invalid
      ? 0
      : Arr.filter(profile.candidates, (candidate) => candidate.status === "eligible").length;

    if (invalid || (profile.candidates.length > 0 && options === 0)) {
      unavailable++;
      const detail = invalid
        ? "Its configuration is invalid, so it fails closed. /subagents doctor lists the invalid fields."
        : skippedReasons(profile.candidates);
      issues.push({
        severity: "warning",
        code: `profile:${profile.id}:unavailable`,
        message: `${profile.id} profile has ${invalid ? "invalid settings" : "no eligible options"}`,
        ...(detail && { detail }),
      });
    } else if (profile.candidates.length === 0) disabled++;
  }
  const agents = details.agents ?? [];
  for (const agent of agents)
    if (Arr.every(agent.candidates, (candidate) => candidate.status !== "eligible")) {
      const detail = skippedReasons(agent.candidates);
      issues.push({
        severity: "warning",
        code: `agent:${agent.name}:unavailable`,
        message: `${agent.name} agent has no eligible options`,
        ...(detail && { detail }),
      });
    }
  const invalidAgents = details.invalidAgents ?? [];
  if (invalidAgents.length > 0)
    issues.push({
      severity: "warning",
      code: "agents:invalid",
      message: "Some custom agents are invalid",
      detail: `${countLabel(invalidAgents.length, "invalid agent entry", "invalid agent entries")} ${invalidAgents.length === 1 ? "fails" : "fail"} closed; /subagents doctor lists the invalid fields.`,
    });
  const [only] = details.profiles;
  // One requested profile reads as the model its launch would take.
  const counters = [
    only && details.profiles.length === 1
      ? profileRow(only).route
      : countLabel(details.profiles.length, "profile"),
  ];
  if (disabled) counters.push(`${disabled} disabled`);
  if (unavailable) counters.push(`${unavailable} unavailable`);
  if (agents.length > 0) counters.push(countLabel(agents.length, "custom agent"));
  summary.counters = [Arr.join(counters, ", ")];
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
  const reviewable = Arr.filter(cards, hasChangesToReview).length;
  if (reviewable === 0) return;
  const label =
    reviewable === 1 && cards.length === 1 ? "ready to apply" : `${reviewable} ready to apply`;
  const [counter, ...fallbacks] = summary.counters ?? [];
  if (counter === undefined) summary.metadata = [...(summary.metadata ?? []), label];
  else summary.counters = [`${counter} · ${label}`, counter, ...fallbacks];
}

const ROUTINE_OR_WAITING: ReadonlyArray<CompactSummary["outcome"]> = [
  "success",
  "returned",
  "attention",
];

const isAsking = (card: SubagentRunCard): boolean =>
  card.question !== undefined || card.state === "waiting_for_parent";

function cardOutcome(
  action: string,
  cards: readonly SubagentRunCard[],
): NonNullable<CompactSummary["outcome"]> {
  if (Arr.some(cards, (card) => card.state === "stopping")) return "uncertain";
  if (Arr.some(cards, (card) => runCleanupAttention(card) !== undefined)) return "warning";
  if (Arr.some(cards, isAsking)) return "attention";
  if (action !== "stop" && Arr.some(cards, (card) => card.state === "stopped")) return "cancelled";
  // A pause the caller didn't request is a held state: the call returned, nothing went wrong.
  return action !== "interrupt" && Arr.some(cards, (card) => card.state === "paused")
    ? "returned"
    : "success";
}

/** Why an await returned for its parent: a problem, a question, or only a held run. */
function parentActionOutcome(
  cards: readonly SubagentRunCard[],
): NonNullable<CompactSummary["outcome"]> {
  if (Arr.some(cards, (card) => runCleanupAttention(card) !== undefined)) return "warning";
  if (Arr.some(cards, isAsking)) return "attention";
  return Arr.some(cards, (card) => card.state === "paused") ? "returned" : "warning";
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
    detail: "This view is bounded, so some details were left out.",
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
  const cards = targets
    ? Arr.filter(details.cards, (card) => targets.includes(card.id))
    : details.cards;
  // An await also returns for parent attention from a run it did not target.
  const asking =
    details.action === "await" && targets
      ? Arr.filter(
          details.cards,
          (card) =>
            !targets.includes(card.id) &&
            (card.question !== undefined || runCleanupAttention(card) !== undefined),
        )
      : [];
  summary.counters = cardCounters(
    cards,
    isSingleRequestedRun(details, cards, requested),
    details.action,
  );
  if (summary.outcome === "success") summary.outcome = cardOutcome(details.action, cards);
  if (details.action === "await")
    awaitIssues(details, summary, issues, cards, targets ?? [], asking);
  else runIssues(details, summary, issues, cards);
  const quietHistory = phase === "settled" && summary.outcome === "success" && issues.length === 0;
  issues.push(
    ...compactRunIssues(cards, {
      quietHistory,
      // An await draws each target's words: its report, failure, or question.
      ...(details.action === "await" && { showsError: cardShowsError, questionsNoticed: true }),
    }),
  );
  issues.push(...compactAttentionIssues(asking, { questionsNoticed: true }));
  labelChangesToReview(summary, cards);
  const severity = compactIssueSeverity(issues);
  if (severity === "error") summary.outcome = "error";
  // A problem outranks a question or a held run, which outrank only success.
  else if (severity === "warning" && Arr.contains(ROUTINE_OR_WAITING, summary.outcome))
    summary.outcome = "warning";
  else if (severity === "attention" && summary.outcome === "success") summary.outcome = "attention";
  return summary;
}
