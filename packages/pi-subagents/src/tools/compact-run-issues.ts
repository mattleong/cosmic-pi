import * as Predicate from "effect/Predicate";
import { type CompactIssue } from "pi-code-previews";
import { skippedCandidateLabel } from "../profiles/model.ts";
import { runAttention, runCleanupAttention } from "../run/attention.ts";
import type { SubagentRunCard } from "./details-schema.ts";
import { steeringDeliveryEvidence } from "./outcome.ts";
import { cleanupRecoveryText, proposalChangeSummary, proposalDiffStatLines } from "./format.ts";
import { failureMessage, firstLineMessage, quoteText } from "pi-cosmic-core";

type AddIssue = (
  severity: CompactIssue["severity"],
  code: string,
  message: string,
  detail?: string,
) => void;

export const QUOTED_TEXT_LIMIT = 120;

const staticSkipCodes = new Set([
  "pi_model_unknown",
  "pi_model_ambiguous",
  "pi_effort_unsupported",
  "parent_model_missing",
  "parent_model_unavailable",
  "parent_model_ambiguous",
  "fast_mode_unsupported",
  "fork_context_unavailable",
]);

const continued = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

const cardLabel = (card: Pick<SubagentRunCard, "id" | "name">) =>
  (card.name === card.id ? "Subagent" : card.name).slice(0, 60);

export const hasChangesToReview = (card: SubagentRunCard): boolean =>
  card.workspaceOutcome?.status !== "auto-discarded" &&
  (Boolean(card.finalText) || card.finalTextTruncated === true) &&
  card.writeIntent === "writer" &&
  (card.writerWorkspaceMode === "worktree" || Boolean(card.workspaceId));

const cardIssueAdder =
  (issues: CompactIssue[], card: SubagentRunCard): AddIssue =>
  (severity, code, message, detail) =>
    issues.push({ severity, code: `${card.id}:${code}`, message, ...(detail && { detail }) });

interface RunIssueOptions {
  readonly quietHistory?: boolean | undefined;
  readonly requestedPause?: boolean | undefined;
}

type CardSkippedCandidate = SubagentRunCard["selection"]["skippedCandidates"][number]["candidate"];

/** Names a skipped option; cards persisted by earlier versions carry a label string instead. */
export const skippedOptionLabel = (candidate: CardSkippedCandidate): string =>
  Predicate.isString(candidate) ? candidate : skippedCandidateLabel(candidate);

const skippedOptionsDetail = (card: SubagentRunCard): string =>
  card.selection.skippedCandidates
    .map(
      (entry) =>
        `${skippedOptionLabel(entry.candidate)}: ${failureMessage(entry.reason, "skipped", QUOTED_TEXT_LIMIT)}`,
    )
    .join("\n");

function selectionIssues(
  card: SubagentRunCard,
  label: string,
  add: AddIssue,
  quiet: boolean,
): void {
  const skipped = card.selection.skippedCandidates;
  if (!skipped.length) return;
  const detail = skippedOptionsDetail(card);
  if (skipped.every((entry) => entry.code === "previous_run_failed")) {
    add("info", "selection-skipped", `${label} moved on to its next profile option`, detail);
    return;
  }
  add(
    quiet ? "info" : "warning",
    "selection-skipped",
    skipped.length === 1
      ? `${label}: a configured option was skipped`
      : `${label}: ${skipped.length} configured options were skipped`,
    detail,
  );
}

/** Only the attention issues of `cards`, for runs a call reports without targeting them. */
export function compactAttentionIssues(cards: readonly SubagentRunCard[]): CompactIssue[] {
  const issues: CompactIssue[] = [];
  for (const card of cards) {
    const add = cardIssueAdder(issues, card);
    attentionIssues(card, cardLabel(card), add, false);
    cleanupIssues(card, cardLabel(card), add);
  }
  return issues;
}

export function compactRunIssues(
  cards: readonly SubagentRunCard[],
  options: RunIssueOptions = {},
): CompactIssue[] {
  const issues: CompactIssue[] = [];
  for (const card of cards) {
    const issueStart = issues.length;
    const label = cardLabel(card);
    const add = cardIssueAdder(issues, card);
    attentionIssues(card, label, add, options.requestedPause === true);
    cleanupIssues(card, label, add);
    if (card.steeringDelivery) {
      const evidence = steeringDeliveryEvidence[card.steeringDelivery];
      add(
        card.steeringDelivery === "confirmed" ? "info" : "warning",
        "steering-delivery",
        `${label}: ${continued(evidence.message)}`,
        `steeringDelivery=${card.steeringDelivery}. ${evidence.detail}`,
      );
    }
    evidenceIssues(card, label, add);
    const quiet =
      options.quietHistory === true &&
      card.state === "completed" &&
      issues.length === issueStart &&
      card.selection.skippedCandidates.every((entry) => staticSkipCodes.has(entry.code));
    selectionIssues(card, label, add, quiet);
  }
  return issues;
}

export function quoted(
  label: string,
  text: string,
  fallback: string,
): Pick<CompactIssue, "message" | "detail"> {
  const { line, detail } = quoteText(text, { limit: QUOTED_TEXT_LIMIT });
  return {
    message: line ? `${label}: ${line}` : `${label} ${fallback}`,
    ...(detail && { detail }),
  };
}

function quote(add: AddIssue, label: string, code: string, text: string, fallback: string): void {
  const { message, detail } = quoted(label, text, fallback);
  add("warning", code, message, detail);
}

function attentionIssues(
  card: SubagentRunCard,
  label: string,
  add: AddIssue,
  requestedPause: boolean,
): void {
  const id = JSON.stringify(card.id);
  const attention = runAttention(card);
  switch (attention?.kind) {
    case undefined:
      return;
    case "paused":
      if (runCleanupAttention(card) !== undefined) return;
      add(
        requestedPause ? "info" : "warning",
        "paused-recovery",
        `${label} is paused`,
        attention.canResume
          ? `Paused. Review subagent_status, then subagent_lifecycle({ action: "resume", runIds: [${id}], message: "Continue with reviewed guidance." }), then subagent_await again.`
          : `Paused; this backend cannot resume. Stop with subagent_lifecycle({ action: "stop", runIds: [${id}] }), confirm cleanup, then launch a corrected replacement and await its run ID.`,
      );
      return;
    case "question":
      add(
        "warning",
        "parent-question",
        `${label} asks: ${firstLineMessage(attention.message, "a question", QUOTED_TEXT_LIMIT)}`,
        `Question: ${attention.message}\nRead the full question in expanded details if omitted. Answer with subagent_send({ runIds: [${id}], message: "..." }), then subagent_await again.`,
      );
      return;
    case "question-unavailable":
      add(
        "warning",
        "question-unavailable",
        `${label} is waiting for a reply, but its question is unavailable`,
        "Waiting for parent, but no question is projected. Inspect full subagent_status before choosing recovery; do not invent a reply.",
      );
  }
}

function cleanupIssues(card: SubagentRunCard, label: string, add: AddIssue): void {
  const attention = runCleanupAttention(card);
  if (attention === undefined) return;
  const messages = {
    pending: "cleanup verification is pending",
    quarantined: "cleanup remains unconfirmed",
    "pool-quarantined": "writer admission is blocked by cleanup quarantine",
  };
  add(
    "warning",
    `cleanup-${attention}`,
    `${label}: ${messages[attention]}`,
    cleanupRecoveryText(card).join("\n"),
  );
}

function evidenceIssues(card: SubagentRunCard, label: string, add: AddIssue): void {
  const retryGuidance =
    "Inspect expanded details and full subagent_status for cleanup and retry disposition. Do not retry when execution is uncertain or cleanup is unconfirmed; missing projected retry data does not establish eligibility.";
  if (card.error) {
    const { line, detail } = quoteText(card.error, { limit: QUOTED_TEXT_LIMIT, failure: true });
    add(
      "error",
      "error",
      line ? `${label}: ${line}` : `${label} reported an error`,
      [detail, retryGuidance].filter(Boolean).join("\n"),
    );
  } else if (card.state === "failed")
    add(
      "error",
      "run-failed",
      `${label} failed`,
      `Run failed; inspect full status.\n${retryGuidance}`,
    );
  if (card.state === "stopping" && card.cleanup === undefined)
    add(
      "warning",
      "cleanup-pending",
      `${label} is stopping; cleanup isn't confirmed yet`,
      "Stopping; cleanup is not yet confirmed. Inspect status before replacement or recovery.",
    );
  if (card.state === "stopped")
    add(
      "info",
      "stopped-cleanup",
      `${label} stopped`,
      card.cleanup?.disposition === "confirmed"
        ? "This run’s process cleanup and writer ownership release are confirmed; a shared pool may still hold other members."
        : "Task state is stopped; inspect full status for cleanup verification before replacement or recovery.",
    );
  const systemSourced = card.warningSource === "system";
  const fallback = systemSourced ? "reported a system warning" : "reported a warning";
  if (card.warning) quote(add, label, "warning", card.warning, fallback);
  if (card.systemWarning && !(systemSourced && card.systemWarning === card.warning))
    quote(add, label, "system-warning", card.systemWarning, "reported a system warning");
  if (card.selection.warning)
    quote(add, label, "selection-warning", card.selection.warning, "has a launch option warning");
  reportEvidenceIssues(card, label, add);
}

function workspaceOutcomeIssue(card: SubagentRunCard, label: string, add: AddIssue): void {
  const outcome = card.workspaceOutcome;
  if (outcome?.status === "auto-discarded") {
    add(
      "info",
      "workspace-outcome",
      `${label}: workspace discarded automatically, no changes`,
      "The writer changed no files, so its workspace was discarded after cleanup. Nothing needs review.",
    );
    return;
  }
  if (outcome === undefined && !hasChangesToReview(card)) return;
  const workspace = card.workspaceId ? ` workspaceId=${card.workspaceId}` : "";
  add(
    "info",
    outcome ? "workspace-outcome" : "workspace-approval",
    outcome
      ? `${label}: ${proposalChangeSummary(outcome)}${outcome.uncapturedFileCount ? ` (+${outcome.uncapturedFileCount} uncaptured)` : ""} proposed; apply or review`
      : `${label}: changes are ready for review`,
    [
      ...(outcome ? proposalDiffStatLines(outcome) : []),
      `Apply small or trusted changes with subagent_workspace action=apply${workspace}; for risky ones, review every page, prepare, test, then apply the exact revisionId and preparationId. A report does not approve workspace integration.`,
      ...(outcome?.uncapturedFileCount
        ? [
            "Uncaptured files, such as .env or vendored code, are not part of the proposal and stay in the worker tree.",
          ]
        : []),
    ].join("\n"),
  );
}

function reportEvidenceIssues(card: SubagentRunCard, label: string, add: AddIssue): void {
  workspaceOutcomeIssue(card, label, add);
  const clipped =
    (card.finalTextTruncated === true && card.finalText !== undefined) ||
    (card.errorTruncated === true && card.error !== undefined);
  if (clipped)
    add(
      "warning",
      "evidence-omitted",
      `${label}: some details are unavailable in this view`,
      "Details are bounded; inspect full subagent_status for omitted evidence.",
    );
}
