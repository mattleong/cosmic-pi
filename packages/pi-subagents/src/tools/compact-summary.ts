import * as Predicate from "effect/Predicate";
import type { CompactSummary, CompactSummaryProvider } from "pi-code-previews";
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
  type SubagentRunCard,
  type SubagentStartDetails,
  type SubagentAwaitDetails,
  type CompactSubagentToolDetails,
} from "./details-schema.ts";
import { compactRunNotices } from "./compact-run-notices.ts";
import { compactWorkspaceSummary } from "./compact-workspace-summary.ts";
import { failedStartRecoveryAction, formatFailedStartRecovery } from "./format.ts";

function cardCounters(cards: readonly SubagentRunCard[], singleTarget = false): string[] {
  if (cards.length === 1 && singleTarget) return [cards[0]!.state];
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(card.state, (counts.get(card.state) ?? 0) + 1);
  return [[...counts].map(([state, count]) => `${count} ${state}`).join(", ")].filter(Boolean);
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
  const summary: CompactSummary = { subject, counters, metadata: [] };
  if (operation !== action) summary.action = operation;
  return summary;
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
  if (phase !== "settled" && details.action !== "start" && details.action !== "await") {
    summary.metadata = [];
    summary.counters = lanes.counters ?? [];
  }
}

/** Decoded domain summaries own collapsed attention; original evidence stays on expansion. */
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
    return summary;
  };
}

type Notices = NonNullable<CompactSummary["notices"]>[number][];
type Phase = Parameters<CompactSummaryProvider>[0]["phase"];
const appendNotice =
  (notices: Notices) =>
  (text: string, kind: "warning" | "error" | "recovery" = "recovery") =>
    notices.push({ kind, text });

function summarizeStart(
  details: SubagentStartDetails,
  phase: Phase,
  summary: CompactSummary,
  notices: Notices,
): CompactSummary {
  const add = appendNotice(notices);
  const started = details.startEntries.filter((entry) => entry.status === "started").length;
  summary.counters = [`${started}/${details.startEntries.length} started`];
  summary.metadata = [];
  for (const entry of details.startEntries) {
    if (entry.routeStatus === "selected" && entry.warning) add(entry.warning, "warning");
    if (entry.status === "failed")
      add(`${entry.name}: launch failed; inspect expanded launch evidence.`, "error");
  }
  for (const failure of details.startFailures ?? []) {
    add(failure.message, "error");
    const recovery = failure.admittedRun;
    if (recovery) {
      add(formatFailedStartRecovery(recovery));
      add(
        recovery.cleanupDisposition === "confirmed"
          ? failedStartRecoveryAction(recovery)
          : "Do not retry or launch a replacement while cleanup is pending or quarantined. Inspect full subagent_status and confirm process and writer cleanup before recovery.",
      );
    } else {
      add(
        "Inspect full launch details and status for ownership and cleanup before recovery. Missing retry data does not establish eligibility.",
      );
    }
  }
  if (notices.some((notice) => notice.kind === "error")) summary.outcome = "error";
  else if (phase === "settled" && started !== details.startEntries.length)
    summary.outcome = "uncertain";
  return summary;
}

function awaitNotices(
  details: SubagentAwaitDetails,
  summary: CompactSummary,
  notices: Notices,
  cards: readonly SubagentRunCard[],
  targets: readonly string[],
  _phase: Phase,
): void {
  const add = appendNotice(notices);
  const finished = cards.filter((card) =>
    ["reported", "completed", "failed", "stopped"].includes(card.state),
  ).length;
  const settledMetadata: string[] = [];
  summary.expandedResultOwnsCall = true;
  summary.counters = [`${finished}/${targets.length} finished`];
  summary.metadata = settledMetadata;
  if (cards.length < targets.length) {
    add(
      "Some requested targets have no projected state; inspect subagent_status before acting.",
      "warning",
    );
    if (summary.outcome === "success") summary.outcome = "uncertain";
  }
  if (details.contextOmitted)
    add(
      "Descendants are context only; this await summarizes requested targets. Inspect subagent_list or subagent_status for descendant state.",
    );
  if (details.cancelled) {
    summary.outcome = "cancelled";
    add(
      "Await cancelled; child runs were NOT stopped. Inspect status or await the requested targets again.",
    );
  }
  if (details.timedOut && !details.cancelled) {
    summary.outcome = "warning";
    add("Await timed out; unfinished children continue. Inspect status or await again.");
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
    add(
      "Parent action required; inspect full target subagent_status for the question, pause capabilities, or claim containment before acting.",
    );
  if (details.attentionRequired && !details.cancelled) summary.outcome = "warning";
}

function runNotices(
  details: Exclude<CompactSubagentToolDetails, { action: "models" }>,
  summary: CompactSummary,
  notices: Notices,
  cards: readonly SubagentRunCard[],
): void {
  const add = appendNotice(notices);
  if (details.runCount > details.cards.length) {
    summary.counters = [
      `${details.cards.length}/${details.runCount} shown, ${cardCounters(cards).join(", ")}`,
    ];
    add(
      "Bounded projection, not complete fleet counts. Use subagent_status for omitted runs and their recovery.",
      "warning",
    );
  }
  for (const failure of details.actionFailures ?? []) {
    add(`${failure.id}: ${failure.message}`, "error");
    add(
      "Inspect expanded failure details and full subagent_status for safe recovery and cleanup disposition before retrying or replacing a run.",
    );
  }
}

function summarizeModels(
  details: Extract<CompactSubagentToolDetails, { action: "models" }>,
  summary: CompactSummary,
  notices: Notices,
): CompactSummary {
  const add = appendNotice(notices);

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
      add(
        `${profile.id}: ${invalid ? "invalid profile configuration" : "no statically eligible candidates"}; inspect expanded discovery.`,
        "warning",
      );
    } else if (profile.candidates.length === 0) disabled++;
  }
  const counters = [`${eligibleOptions} statically eligible`];

  if (disabled) counters.push(`${disabled} disabled profiles`);
  if (unavailable) counters.push(`${unavailable} unavailable profiles`);
  summary.counters = [counters.join(", ")];
  summary.metadata = [];
  if (summary.outcome === "success" && notices.some((notice) => notice.kind === "warning"))
    summary.outcome = "warning";
  return summary;
}

function appendRunHistory(
  summary: CompactSummary,
  notices: Notices,
  cards: readonly SubagentRunCard[],
  phase: Phase,
  reportsOnlyOmitted: boolean,
): void {
  const quietHistory = phase === "settled" && summary.outcome === "success" && notices.length === 0;
  const { notices: cardNotices } = compactRunNotices(cards, reportsOnlyOmitted, quietHistory);
  notices.push(...cardNotices);
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
  const notices: NonNullable<CompactSummary["notices"]>[number][] = [];
  const summary: CompactSummary = { subject, metadata: [], notices, detailsOnExpand: true };
  if (phase === "settled") summary.outcome = "success";
  const add = appendNotice(notices);
  if (details.action === "start") return summarizeStart(details, phase, summary, notices);
  if (details.contentOmitted && !("reportsOnlyOmitted" in details && details.reportsOnlyOmitted)) {
    add(
      "Bounded projection: details were omitted. Inspect expanded details and subagent_status for full target state, attention, and recovery before acting.",
      "warning",
    );
    summary.outcome = "uncertain";
  }
  if (details.action === "models") return summarizeModels(details, summary, notices);
  const cards = targets ? details.cards.filter((card) => targets.includes(card.id)) : details.cards;
  summary.metadata = [];
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
  if (details.action === "await") awaitNotices(details, summary, notices, cards, targets!, phase);
  else runNotices(details, summary, notices, cards);
  appendRunHistory(summary, notices, cards, phase, details.reportsOnlyOmitted === true);
  if (notices.some((notice) => notice.kind === "error")) summary.outcome = "error";
  else if (summary.outcome === "success" && notices.some((notice) => notice.kind === "warning"))
    summary.outcome = "warning";
  return summary;
}
