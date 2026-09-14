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

function cardMetadata(cards: readonly SubagentRunCard[], subject: string): string[] {
  const metadata: string[] = [];
  if (cards.length === 1) {
    const card = cards[0]!;
    if (card.id !== subject) metadata.push(card.id);
    if (card.name !== card.id && card.name !== subject) metadata.push(card.name);
  }
  return metadata.concat(cardWriterMetadata(cards));
}

function cardCounters(cards: readonly SubagentRunCard[]): string[] {
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(card.state, (counts.get(card.state) ?? 0) + 1);
  return [...counts].map(([state, count]) => `${count} ${state}`);
}

function cardWriterMetadata(cards: readonly SubagentRunCard[]): string[] {
  const metadata: string[] = [];
  if (cards.length === 1) {
    const card = cards[0]!;
    if (card.writeIntent === "writer") metadata.push(card.writerWorkspaceMode ?? "writer");
    const claimCount = card.writeClaimCount ?? card.writeClaims?.length;
    if (claimCount !== undefined) metadata.push(`${claimCount} file claims`);
    else if (card.writeIntent === "writer")
      metadata.push(card.writeClaimsOmitted ? "claims omitted" : "exclusive writer");
  }
  if (cards.length > 1) {
    for (const card of cards.filter((card) => card.writeIntent === "writer")) {
      metadata.push(
        `${card.id}: ${card.writerWorkspaceMode ?? "writer"}, ${card.writeClaimCount ?? card.writeClaims?.length ?? "unprojected"} file claims`,
      );
    }
  }
  return metadata;
}

interface SummaryArguments {
  action?: unknown;
  runId?: unknown;
  runIds?: unknown;
  workspaceId?: unknown;
  agents?: unknown;
  profile?: unknown;
}

function argumentMetadata(input: SummaryArguments): string[] {
  const metadata: string[] = [];
  if (Predicate.isString(input.profile)) metadata.push(input.profile);
  return metadata;
}

function requestedRunIds(input: SummaryArguments): string[] | undefined {
  return Array.isArray(input.runIds) && input.runIds.every(Predicate.isString)
    ? input.runIds
    : undefined;
}

function argumentSummary(
  input: SummaryArguments,
  action: string,
  operation: string,
): CompactSummary {
  const ids = requestedRunIds(input);
  const subject =
    action === "workspace" && Predicate.isString(input.workspaceId)
      ? input.workspaceId
      : Predicate.isString(input.runId)
        ? input.runId
        : ids?.length === 1
          ? ids[0]!
          : "";
  const counters = Array.isArray(input.agents)
    ? [`${input.agents.length} requested`]
    : ids && ids.length > 1
      ? [`${ids.length} targets`]
      : [];
  const summary: CompactSummary = { subject, counters, metadata: argumentMetadata(input) };
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
  if (targets?.length === 1) return targets[0]!;
  if (subject || phase !== "settled" || requestedRunIds(input)?.length) return subject;
  if ((details.action === "list" || details.action === "status") && details.cards.length === 1)
    return details.cards[0]!.id;
  return subject;
}

/** Decoded domain summaries own collapsed attention; original evidence stays on expansion. */
export function createSubagentCompactSummary(
  toolName: string,
): CompactSummaryProvider<unknown, unknown, unknown> {
  return ({ phase, args, result, context }) => {
    if (context.isError) return undefined;
    const action = toolName.replace(/^subagent_/, "");
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
      details.action === "await" ? (details.awaitedRunIds ?? requestedTargets) : undefined;
    if (details.action === "await" && !targets?.length) return undefined;
    const summary = summarizeDetails(
      details,
      phase,
      projectedSubject(details, input, phase, lanes.subject, targets),
      targets,
    );
    if (lanes.action) summary.action = lanes.action;
    if (phase !== "settled" && details.action !== "start" && details.action !== "await") {
      summary.metadata = argumentMetadata(input);
      summary.counters = lanes.counters ?? [];
    }
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
  phase: Phase,
): void {
  const add = appendNotice(notices);
  const finished = cards.filter((card) =>
    ["reported", "completed", "failed", "stopped"].includes(card.state),
  ).length;
  const settledMetadata = phase === "settled" ? cardMetadata(cards, summary.subject) : [];
  summary.expandedResultOwnsCall = true;
  summary.counters = [`${finished}/${targets.length} finished`];
  summary.metadata = settledMetadata;
  if (phase === "settled" && details.cards.length > cards.length)
    summary.metadata = [
      ...summary.metadata,
      `${details.cards.length - cards.length} descendants in context`,
    ];
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
      `${details.cards.length}/${details.runCount} shown`,
      ...cardCounters(cards),
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

function appendReportMetadata(
  summary: CompactSummary,
  cards: readonly SubagentRunCard[],
  details: { contentOmitted?: true; reportsOnlyOmitted?: true },
): void {
  const metadata = [...(summary.metadata ?? [])];
  const reports = cards.filter((card) => card.finalText).length;
  if (reports) metadata.push(`${reports} ${reports === 1 ? "report" : "reports"}`);
  if (details.contentOmitted && details.reportsOnlyOmitted)
    metadata.push("reports via subagent_status");
  summary.metadata = metadata;
}

function summarizeDetails(
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
  phase: Phase,
  subject: string,
  targets?: readonly string[],
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
  if (details.action === "models") {
    summary.counters = [`${details.profiles.length} profiles`];
    for (const profile of details.profiles)
      for (const candidate of profile.candidates) {
        if (candidate.status !== "eligible") add(`${profile.id}: ${candidate.reason}`, "warning");
      }
    return summary;
  }
  const cards = targets ? details.cards.filter((card) => targets.includes(card.id)) : details.cards;
  summary.metadata = cardMetadata(cards, summary.subject);
  summary.counters = cardCounters(cards);
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
  notices.push(...compactRunNotices(cards, details.reportsOnlyOmitted === true));
  if (details.action === "await") awaitNotices(details, summary, notices, cards, targets!, phase);
  else runNotices(details, summary, notices, cards);
  if (phase === "settled") appendReportMetadata(summary, cards, details);
  if (notices.some((notice) => notice.kind === "error")) summary.outcome = "error";
  else if (summary.outcome === "success" && notices.some((notice) => notice.kind === "warning"))
    summary.outcome = "warning";
  return summary;
}
