import { compactIssueSeverity, firstLineMessage } from "pi-code-previews";
import * as Predicate from "effect/Predicate";
import type { CompactIssue, CompactSummary, CompactSummaryProvider } from "pi-code-previews";
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
  type SubagentRunCard,
  type SubagentStartDetails,
  type SubagentAwaitDetails,
  type CompactSubagentToolDetails,
} from "./details-schema.ts";
import { compactRunIssues } from "./compact-run-issues.ts";
import { compactWorkspaceSummary } from "./compact-workspace-summary.ts";
import { progressDetail, summarizeStart } from "./compact-start-summary.ts";

function compactRunState(state: SubagentRunCard["state"], count = 1): string {
  return state === "waiting_for_parent" ? `${count === 1 ? "needs" : "need"} reply` : state;
}

function cardCounters(cards: readonly SubagentRunCard[], singleTarget = false): string[] {
  if (cards.length === 1 && singleTarget) return [compactRunState(cards[0]!.state)];
  const counts = new Map<SubagentRunCard["state"], number>();
  for (const card of cards) counts.set(card.state, (counts.get(card.state) ?? 0) + 1);
  return [
    [...counts].map(([state, count]) => `${count} ${compactRunState(state, count)}`).join(", "),
  ].filter(Boolean);
}

interface SummaryArguments {
  action?: unknown;
  runId?: unknown;
  runIds?: unknown;
  workspaceId?: unknown;
  agents?: unknown;
  profile?: unknown;
  paths?: unknown;
}

function requestedRunIds(input: SummaryArguments): string[] | undefined {
  return Array.isArray(input.runIds) && input.runIds.every(Predicate.isString)
    ? input.runIds
    : undefined;
}

function startSubject(input: SummaryArguments): string {
  if (!Array.isArray(input.agents) || input.agents.length !== 1) return "";
  const agent: unknown = input.agents[0];
  if (!Predicate.isObject(agent)) return "";
  if ("name" in agent && Predicate.isString(agent.name)) return agent.name;
  return "profile" in agent && Predicate.isString(agent.profile) ? agent.profile : "";
}

function claimCounters(
  details: Exclude<CompactSubagentToolDetails, { action: "models" }>,
): string[] | undefined {
  const counts = details.cards.map((card) => card.writeClaimCount ?? card.writeClaims?.length);
  if (!counts.length || !counts.every((count) => count !== undefined)) return undefined;
  const total = counts.reduce((sum, count) => sum + count, 0);
  const count = `${total} file ${total === 1 ? "claim" : "claims"}`;
  return [
    details.runCount > details.cards.length
      ? `${details.cards.length}/${details.runCount} shown, ${count}`
      : count,
  ];
}

function argumentSummary(
  input: SummaryArguments,
  action: string,
  operation: string,
): CompactSummary {
  const ids = requestedRunIds(input);
  let subject =
    action === "workspace" && Predicate.isString(input.workspaceId)
      ? input.workspaceId
      : Predicate.isString(input.runId)
        ? input.runId
        : ids?.length === 1
          ? ids[0]!
          : "";
  if (action === "start") subject = startSubject(input);
  if (action === "models" && Predicate.isString(input.profile)) subject = input.profile;
  const counters =
    action === "claims" && Array.isArray(input.paths)
      ? [`${input.paths.length} file ${input.paths.length === 1 ? "claim" : "claims"} requested`]
      : Array.isArray(input.agents)
        ? [`${input.agents.length} requested`]
        : ids && ids.length > 1
          ? [`${ids.length} targets`]
          : [];
  const summary: CompactSummary = {
    subject,
    counters,
    metadata: [],
    compactSubject: compactArgumentSubject(input, action, subject),
  };
  if (operation !== action) summary.action = operation;
  return summary;
}

function compactArgumentSubject(input: SummaryArguments, action: string, subject: string): string {
  if (action === "workspace") return "Proposed changes";
  return input.runId === subject || requestedRunIds(input)?.includes(subject) ? "Worker" : subject;
}

function compactProjectedSubject(
  input: SummaryArguments,
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
  subject: string,
): string {
  if ("cards" in details && details.cards.some((card) => card.id === subject)) return "Worker";
  return compactArgumentSubject(input, details.action, subject);
}

function projectedSubject(
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
  input: SummaryArguments,
  phase: Phase,
  subject: string,
  targets?: readonly string[],
): string {
  if (details.action === "models" && Predicate.isString(input.profile)) return input.profile;
  const requested =
    targets ?? (Predicate.isString(input.runId) ? [input.runId] : requestedRunIds(input));
  if (requested?.length === 1 && "cards" in details)
    return details.cards.find((card) => card.id === requested[0])?.name ?? requested[0]!;
  if (subject || phase !== "settled" || requestedRunIds(input)?.length) return subject;
  if ((details.action === "list" || details.action === "status") && details.cards.length === 1)
    return details.cards[0]!.name;
  return subject;
}

function applyArgumentLanes(
  summary: CompactSummary,
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
  phase: Phase,
  lanes: CompactSummary,
): void {
  if (details.action === "claims")
    summary.counters = claimCounters(details) ?? summary.counters ?? [];
  if (phase === "settled" && (details.action === "send" || details.action === "reply")) {
    // runCount counts accepted operations, not failures or only the bounded visible cards.
    const receipt = details.action === "send" ? "sent" : "replied";
    const count = details.runCount === 1 ? receipt : `${details.runCount} ${receipt}`;
    summary.counters = [
      details.runCount > details.cards.length
        ? `${count}, ${details.cards.length}/${details.runCount} shown`
        : count,
    ];
  }
  if (lanes.action) summary.action = lanes.action;
  if (phase !== "settled" && details.action !== "start" && details.action !== "await")
    summary.counters = lanes.counters ?? [];
}

/** Decoded domain summaries classify attention; original evidence stays on expansion. */
export function createSubagentCompactSummary(
  toolName: string,
): CompactSummaryProvider<unknown, unknown, unknown> {
  return ({ phase, args, result, context }) => {
    if (context.isError) return undefined;
    const action = toolName.replace(/^subagent_/, "");
    if (!Predicate.isObject(args)) return undefined;
    // SAFETY: Pi owns partial arguments; display fields are narrowed before use.
    const input = args as SummaryArguments;
    const operation = Predicate.isString(input.action) ? input.action : action;
    const lanes = argumentSummary(input, action, operation);
    if (!result) return phase === "settled" ? undefined : lanes;
    if (action === "workspace") return compactWorkspaceSummary(result.details, operation);
    const details =
      decodeStartAwaitCardDetails(result.details) ?? decodeCompactToolDetails(result.details);
    if (!details || details.action !== (action === "claims" ? "claims" : operation))
      return undefined;
    const requestedTargets = requestedRunIds(input);
    const targets =
      details.action === "await" ? (requestedTargets ?? details.awaitedRunIds) : undefined;
    if (details.action === "await" && !targets?.length) return undefined;
    const summary = summarizeDetails(
      details,
      phase,
      projectedSubject(details, input, phase, lanes.subject, targets),
      targets,
      Predicate.isString(input.runId) ? [input.runId] : requestedTargets,
    );
    applyArgumentLanes(summary, details, phase, lanes);
    summary.compactSubject = compactProjectedSubject(input, details, summary.subject);
    return summary;
  };
}

type Phase = Parameters<CompactSummaryProvider>[0]["phase"];

function awaitIssues(
  details: SubagentAwaitDetails,
  summary: CompactSummary,
  issues: CompactIssue[],
  cards: readonly SubagentRunCard[],
  targets: readonly string[],
): void {
  const finished = cards.filter((card) =>
    ["reported", "completed", "failed", "stopped"].includes(card.state),
  ).length;
  summary.counters = [progressDetail(finished, targets.length, "finished", summary.subject)];
  if (cards.length < targets.length) {
    issues.push({
      severity: "warning",
      code: "targets-omitted",
      message: "Some requested workers have no available status",
      detail:
        "Some requested targets have no projected state; inspect subagent_status before acting.",
    });
    if (summary.outcome === "success") summary.outcome = "uncertain";
  }
  if (details.contextOmitted)
    issues.push({
      severity: "info",
      code: "descendant-context",
      message: "Descendant workers are shown for context only",
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
        ? "Waiting was cancelled; workers were not stopped and wait cleanup is unconfirmed"
        : "Waiting was cancelled; workers were not stopped",
      detail: unconfirmed
        ? "Local await cancelled; child runs were NOT stopped. Root completion-claim cleanup is unconfirmed; claims may remain and an immediate replacement await may fail with completion_claim_conflict."
        : "Await cancelled; child runs were NOT stopped. Wait cleanup is complete; await the requested targets again when needed.",
    });
  }
  if (details.timedOut && !details.cancelled) {
    summary.outcome = "warning";
    issues.push({
      severity: "warning",
      code: "await-timeout",
      message: "Timed out waiting; unfinished workers continue running",
      detail: "Await timed out; unfinished children continue. Inspect status or await again.",
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
      message: "A worker needs attention before it can continue",
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
    issues.push({
      severity: "warning",
      code: "runs-omitted",
      message: "Only some workers are shown",
      detail:
        "Bounded projection, not complete fleet counts. Use subagent_status for omitted runs and their recovery.",
    });
  }
  for (const failure of details.actionFailures ?? []) {
    // Failed targets are usually absent from the visible cards; raw text keeps their identity.
    const name = details.cards.find((card) => card.id === failure.id)?.name.slice(0, 60);
    const message =
      failure.code === "SubagentNotFoundError"
        ? "A requested worker was not found"
        : firstLineMessage(failure.message, "The action failed");
    issues.push(
      {
        severity: "error",
        code: `run:${failure.id}:action-failed`,
        message: name ? `${name}: ${message}` : message,
        detail: `${failure.id}: ${failure.code ? `[${failure.code}] ` : ""}${failure.message}`,
      },
      {
        severity: "info",
        code: `run:${failure.id}:action-recovery`,
        message: "Check status before retrying or replacing the worker",
        detail:
          "Inspect expanded failure details and full subagent_status for safe recovery and cleanup disposition before retrying or replacing a run.",
      },
    );
  }
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
        message: `${profile.id}: ${invalid ? "The worker profile has invalid settings" : "The worker profile has no eligible options"}`,
        detail: `${invalid ? "Invalid profile configuration" : "No statically eligible candidates"}; inspect expanded discovery.`,
      });
    } else if (profile.candidates.length === 0) disabled++;
  }
  const counters = [`${eligibleOptions} statically eligible`];

  if (disabled) counters.push(`${disabled} disabled profiles`);
  if (unavailable) counters.push(`${unavailable} unavailable profiles`);
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
    ? requested.length === 1 && cards[0]?.id === requested[0]
    : details.action === "list" || details.action === "status";
}

function summarizeDetails(
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
  phase: Phase,
  subject: string,
  targets?: readonly string[],
  requested?: readonly string[],
): CompactSummary {
  const issues: CompactIssue[] = [];
  const summary: CompactSummary = { subject, metadata: [], issues };
  if (phase === "settled") summary.outcome = "success";
  if (details.action === "start") return summarizeStart(details, phase, summary, issues);
  if (details.contentOmitted && !("reportsOnlyOmitted" in details && details.reportsOnlyOmitted)) {
    issues.push({
      severity: "warning",
      code: "evidence-omitted",
      message: "Some worker details are unavailable in this view",
      detail:
        "Bounded projection: details were omitted. Inspect expanded details and subagent_status for full target state, attention, and recovery before acting.",
    });
    summary.outcome = "uncertain";
  }
  if (details.action === "models") return summarizeModels(details, summary, issues);
  const cards = targets ? details.cards.filter((card) => targets.includes(card.id)) : details.cards;
  summary.counters = cardCounters(cards, isSingleRequestedRun(details, cards, requested));
  if (summary.outcome === "success") {
    if (cards.some((card) => card.state === "stopping")) summary.outcome = "uncertain";
    else if (
      cards.some(
        (card) =>
          card.writeAdmissionPaused ||
          card.question ||
          card.state === "paused" ||
          card.state === "waiting_for_parent",
      )
    )
      summary.outcome = "warning";
    else if (cards.some((card) => card.state === "stopped")) summary.outcome = "cancelled";
  }
  if (details.action === "await") awaitIssues(details, summary, issues, cards, targets!);
  else runIssues(details, summary, issues, cards);
  const quietHistory = phase === "settled" && summary.outcome === "success" && issues.length === 0;
  issues.push(...compactRunIssues(cards, details.reportsOnlyOmitted === true, quietHistory));
  const severity = compactIssueSeverity(issues);
  if (severity === "error") summary.outcome = "error";
  else if (summary.outcome === "success" && severity === "warning") summary.outcome = "warning";
  return summary;
}
