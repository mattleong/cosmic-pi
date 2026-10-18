import { type CompactIssue } from "pi-code-previews";
import { skippedCandidateLabel } from "../profiles/model.ts";
import { runAttention, runCleanupAttention } from "../run/attention.ts";
import type { SubagentRunCard } from "./details-schema.ts";
import { steeringDeliveryEvidence } from "./outcome.ts";
import { cleanupRecoveryText, proposalDiffStatLines, proposalGuidance } from "./format.ts";
import { countLabel, failureMessage, firstLineMessage, quoteText } from "pi-cosmic-core";

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

const skippedOptionsDetail = (card: SubagentRunCard): string =>
  card.selection.skippedCandidates
    .map(
      (entry) =>
        `${skippedCandidateLabel(entry.candidate)}: ${failureMessage(entry.reason, "skipped", QUOTED_TEXT_LIMIT)}`,
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
          ? `Paused. Review it with agent_read, then resume it with agent_send({ to: ${id}, message: "Continue with reviewed guidance." }), then agent_await again.`
          : `Paused; this backend cannot resume. Stop with agent_lifecycle({ action: "stop", runIds: [${id}] }), then launch a corrected replacement and await its run ID.`,
      );
      return;
    case "question":
      add(
        "warning",
        "parent-question",
        `${label} asks: ${firstLineMessage(attention.message, "a question", QUOTED_TEXT_LIMIT)}`,
        `Question: ${attention.message}\nRead the full question in expanded details if omitted. Answer with agent_send({ to: ${id}, message: "..." }), then agent_await again.`,
      );
      return;
    case "question-unavailable":
      add(
        "warning",
        "question-unavailable",
        `${label} is waiting for a reply, but its question is unavailable`,
        "Waiting for parent, but no question is projected. Inspect the run with agent_read before choosing recovery; do not invent a reply.",
      );
  }
}

function cleanupIssues(card: SubagentRunCard, label: string, add: AddIssue): void {
  const attention = runCleanupAttention(card);
  if (attention === undefined) return;
  const messages = {
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
    "Inspect the run with agent_read for retry disposition; don't retry when execution is uncertain.";
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
      `${label}: no changes; workspace discarded`,
      "The writer changed no files, so its workspace was discarded. Nothing needs review.",
    );
    return;
  }
  if (outcome === undefined && !hasChangesToReview(card)) return;
  add(
    "info",
    "workspace-outcome",
    outcome
      ? `${label}: ready to apply (${countLabel(outcome.changedFileCount, "file")})`
      : `${label}: ready to apply`,
    [
      ...(outcome ? proposalDiffStatLines(outcome) : []),
      card.workspaceId
        ? proposalGuidance(card.workspaceId, outcome)
        : "Apply it with agent_worktree apply and its workspaceId from agent_list.",
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
      "Details are bounded; inspect the run with agent_read for omitted evidence.",
    );
}
