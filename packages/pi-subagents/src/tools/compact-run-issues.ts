import { type CompactIssue } from "pi-code-previews";
import { isOffenderOnlyContainment, runAttention, runCleanupAttention } from "../run/attention.ts";
import { isTerminalRunState } from "../run/model.ts";
import type { SubagentRunCard } from "./details-schema.ts";
import { steeringDeliveryEvidence } from "./outcome.ts";
import { cleanupRecoveryText, OUTSIDE_WORKSPACE_RESUME_GUIDANCE } from "./format.ts";
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

const PROFILE_OPTION_KEY =
  /^([^/]+)\/([^/]+)\/(.+):([^:]+):[^:]+:[^:]+:openaiFastMode=(?:true|false):closeOnReport=(?:true|false)$/u;

export const profileOptionLabel = (key: string): string => {
  const match = PROFILE_OPTION_KEY.exec(key);
  if (!match) return key;
  const [, host, runtime, model, effort] = match;
  return host !== undefined && runtime !== undefined && model !== undefined && effort !== undefined
    ? `${host}/${runtime} · ${model}:${effort}`
    : key;
};

const skippedOptionsDetail = (card: SubagentRunCard): string =>
  card.selection.skippedCandidates
    .map(
      (entry) =>
        `${profileOptionLabel(entry.candidate)}: ${failureMessage(entry.reason, "skipped", QUOTED_TEXT_LIMIT)}`,
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

function outsideClaims(card: SubagentRunCard): string {
  const paths = [...new Set(card.writeAudit?.violations.map((violation) => violation.path))];
  const first = paths[0];
  if (first === undefined) return "outside its file claims";
  const shown = first.length > 60 ? `…${first.slice(-59)}` : first;
  return `${shown}${paths.length > 1 ? ` and ${paths.length - 1} more` : ""} outside its file claims`;
}

function offenderOnlyContainmentIssues(
  card: SubagentRunCard,
  label: string,
  id: string,
  add: AddIssue,
): void {
  const terminal = isTerminalRunState(card.state);
  const pausing = card.state !== "paused" && !terminal;
  add(
    "warning",
    "containment-audit",
    `${label} wrote outside the workspace${card.state === "paused" ? "; paused" : pausing ? "; waiting for it to pause" : ""}`,
    [
      "Containment applies only to this writer; its peers and writer admission are unaffected. Review the full audit with subagent_status; projected paths may be omitted. Do not use subagent_reply or resume_admission for this containment.",
      ...(pausing
        ? [
            "Wait for containment to reach paused or terminal, then inspect status. If still active, check again; do not issue a duplicate stop solely because pause has not published.",
          ]
        : []),
    ].join("\n"),
  );
  if (terminal || runCleanupAttention(card) !== undefined) return;
  if (card.capabilities.includes("resume"))
    add(
      "info",
      "containment-resume",
      `${label} can resume with guidance or be stopped`,
      `Once confirmed paused, review the audit, then subagent_lifecycle({ action: "resume", runIds: [${id}], message: ${JSON.stringify(OUTSIDE_WORKSPACE_RESUME_GUIDANCE)} }) and subagent_await again, or stop it with subagent_lifecycle({ action: "stop", runIds: [${id}] }).`,
    );
  else
    add(
      "info",
      "containment-stop",
      `${label} is being stopped by containment`,
      `This backend cannot resume, so containment is stopping it. Confirm it reaches terminal with subagent_status({ runIds: [${id}] }); if still active, check again rather than issuing a duplicate stop. If the work is still needed, launch a corrected replacement with exact workspace-relative claims and await its run ID.`,
    );
}

function containmentIssues(card: SubagentRunCard, label: string, id: string, add: AddIssue): void {
  if (isOffenderOnlyContainment(card)) {
    offenderOnlyContainmentIssues(card, label, id, add);
    return;
  }
  const terminal = isTerminalRunState(card.state);
  const pausing = card.state !== "paused" && !terminal;
  add(
    "warning",
    "containment-audit",
    `${label} wrote to ${outsideClaims(card)}${card.state === "paused" ? "; paused" : pausing ? "; waiting for it to pause" : ""}`,
    [
      "Claim containment. Review the full audit and shared tree with subagent_status; projected paths may be omitted. Do not use subagent_reply for containment.",
      ...(pausing
        ? [
            "Wait for containment to reach paused or terminal, then inspect status. If still active, check again; do not issue a duplicate stop solely because pause has not published.",
          ]
        : []),
    ].join("\n"),
  );
  if (runCleanupAttention(card) !== undefined) {
    add(
      "info",
      "containment-await-cleanup",
      `${label}: file-access review is blocked by unconfirmed cleanup`,
      "Claim containment and cleanup quarantine are independent. Review the full write audit, but resolve cleanup before reopening claim admission or replacing the offender.",
    );
    return;
  }
  if (!terminal && card.capabilities.includes("resume"))
    add(
      "info",
      "containment-resume",
      `${label} can resume once its claims are reviewed`,
      `Once confirmed paused, review the full audit and grant only reviewed, intended, conflict-free missing workspace-relative claims with subagent_claims; never claim outside-workspace or absolute paths. Then subagent_claims({ action: "resume_admission", runId: ${id} }), then subagent_lifecycle({ action: "resume", runIds: [${id}], message: "Continue only within the authoritative claims returned by subagent_claims." }), then subagent_await. If the audit includes outside-workspace writes, resume with the message ${JSON.stringify(OUTSIDE_WORKSPACE_RESUME_GUIDANCE)} instead. If containment instead reaches terminal, confirm process and writer cleanup before reopening admission and launching and awaiting a corrected replacement.`,
    );
  else
    add(
      "info",
      "containment-stop",
      `${label} must be stopped and replaced`,
      `Once containment reaches paused or terminal, if paused, stop with subagent_lifecycle({ action: "stop", runIds: [${id}] }). Confirm process and writer cleanup before subagent_claims({ action: "resume_admission", runId: ${id} }); then launch a corrected replacement with reviewed exact workspace-relative claims and await its run ID.`,
    );
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
    case "containment":
      containmentIssues(card, label, id, add);
      return;
    case "admission-paused":
      add(
        "warning",
        "peer-admission-paused",
        `${label}: new writes are paused while another worker's file access is reviewed`,
        "Writer admission paused. Inspect subagent_list and the recorded offender's full subagent_status audit. Do not change this peer's claims. Contain or clean up every offender first; reopen admission only after confirmed pause or terminal cleanup, then continue or await this peer.",
      );
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
        `Question: ${attention.message}\nRead the full question in expanded details if omitted. If this is a writer's request for additional file claims, review and grant only intended, conflict-free workspace-relative claims with subagent_claims before replying. Reply with subagent_reply({ runId: ${id}, message: "..." }), then subagent_await again.`,
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

function reportEvidenceIssues(card: SubagentRunCard, label: string, add: AddIssue): void {
  if (hasChangesToReview(card))
    add(
      "info",
      "workspace-approval",
      `${label}: changes are ready for review`,
      "A report does not approve workspace integration.",
    );
  const clipped =
    (card.finalTextTruncated === true && card.finalText !== undefined) ||
    (card.errorTruncated === true && card.error !== undefined);
  if (card.writeClaimsOmitted || clipped)
    add(
      "warning",
      "evidence-omitted",
      `${label}: some details are unavailable in this view`,
      "Details are bounded; inspect full subagent_status for omitted evidence.",
    );
  if (card.writeAudit?.violations.length && !card.writeViolationOffender)
    add(
      "warning",
      "write-audit",
      `${label} wrote to ${outsideClaims(card)}`,
      "Recorded write violations are available in expanded details. Inspect the full audit and current offender status before recovery.",
    );
}
