import { type CompactIssue } from "pi-code-previews";
import { runAttention } from "./attention.ts";
import type { SubagentRunCard } from "./details-schema.ts";
import { steeringDeliveryEvidence } from "./outcome.ts";
import { failureMessage, firstLineMessage, quoteText } from "pi-cosmic-core";

/**
 * Card-scoped issue. The message is one sentence that starts with the worker's name; the
 * expanded detail keeps the full text and agent guidance.
 */
type AddIssue = (
  severity: CompactIssue["severity"],
  code: string,
  message: string,
  detail?: string,
) => void;

/** Worker and system text shown collapsed is bounded tighter than producer copy. */
export const QUOTED_TEXT_LIMIT = 120;

// Only static alternative selection is routine history. Unknown launch evidence stays visible.
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

/** Producer copy that reads as a standalone sentence, continued after `name:`. */
export const continued = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** A collapsed name for a subagent whose card has no display name of its own. */
export const cardLabel = (card: Pick<SubagentRunCard, "id" | "name">) =>
  (card.name === card.id ? "Subagent" : card.name).slice(0, 60);

/** A reported writer's changes still need review before integration. */
export const hasChangesToReview = (card: SubagentRunCard): boolean =>
  (Boolean(card.finalText) || card.finalTextTruncated === true || card.state === "reported") &&
  card.writeIntent === "writer" &&
  (card.writerWorkspaceMode === "worktree" || Boolean(card.workspaceId));

const cardIssueAdder =
  (issues: CompactIssue[], card: SubagentRunCard): AddIssue =>
  (severity, code, message, detail) =>
    issues.push({ severity, code: `${card.id}:${code}`, message, ...(detail && { detail }) });

/** How a projection's issues read; each flag makes routine facts quieter. */
export interface RunIssueOptions {
  /** A clean settled view keeps routine selection history to expansion. */
  readonly quietHistory?: boolean | undefined;
  /** The caller asked for a pause, so a paused run is the expected result. */
  readonly requestedPause?: boolean | undefined;
}

const PROFILE_OPTION_KEY =
  /^([^/]+)\/([^/]+)\/(.+):([^:]+):[^:]+:[^:]+:openaiFastMode=(?:true|false):closeOnReport=(?:true|false)$/u;

/** A profile option key as people read a route: "local/pi · anthropic/claude-opus-4-7:high". */
export const profileOptionLabel = (key: string): string => {
  const match = PROFILE_OPTION_KEY.exec(key);
  return match ? `${match[1]}/${match[2]} · ${match[3]}:${match[4]}` : key;
};

/** Each skipped option by its route, with the reason in people's terms. */
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
  // A retry moves past the option that failed: the expected step, not a problem.
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

/** Card audits are bounded projections, never authority for granting paths. */
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
    // Clean terminal static skips are routine history: kept, but only on expansion.
    const quiet =
      options.quietHistory === true &&
      ["completed", "reported"].includes(card.state) &&
      issues.length === issueStart &&
      card.selection.skippedCandidates.every((entry) => staticSkipCodes.has(entry.code));
    selectionIssues(card, label, add, quiet);
  }
  return issues;
}

/**
 * Worker or system text quoted by its first line, after the worker's name. Text that opens with
 * an instruction is agent guidance, so the message says only that it exists.
 */
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

/** The recorded out-of-claim writes, by their first path. */
function outsideClaims(card: SubagentRunCard): string {
  const paths = [...new Set(card.writeAudit?.violations.map((violation) => violation.path))];
  const first = paths[0];
  if (first === undefined) return "outside its file claims";
  const shown = first.length > 60 ? `…${first.slice(-59)}` : first;
  return `${shown}${paths.length > 1 ? ` and ${paths.length - 1} more` : ""} outside its file claims`;
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
    case "containment": {
      const terminal = ["completed", "failed", "stopped"].includes(card.state);
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
      if (!terminal && card.capabilities.includes("resume"))
        add(
          "info",
          "containment-resume",
          `${label} can resume once its claims are reviewed`,
          `Once confirmed paused, if the full audit proves all writes workspace-relative, grant only reviewed, intended, conflict-free missing claims with subagent_claims. Then subagent_claims({ action: "resume_admission", runId: ${id} }), then subagent_lifecycle({ action: "resume", runIds: [${id}], message: "Continue only within the authoritative claims returned by subagent_claims." }), then subagent_await. If containment instead reaches terminal, confirm process and writer cleanup before reopening admission and launching and awaiting a corrected replacement. If any write is outside the workspace, stop and confirm process and writer cleanup before reopening admission and launching and awaiting a corrected replacement with exact safe claims.`,
        );
      else
        add(
          "info",
          "containment-stop",
          `${label} must be stopped and replaced`,
          `Once containment reaches paused or terminal, if paused, stop with subagent_lifecycle({ action: "stop", runIds: [${id}] }). Confirm process and writer cleanup before subagent_claims({ action: "resume_admission", runId: ${id} }); then launch a corrected replacement with reviewed exact workspace-relative claims and await its run ID.`,
        );
      return;
    }
    case "admission-paused":
      add(
        "warning",
        "peer-admission-paused",
        `${label}: new writes are paused while another worker's file access is reviewed`,
        "Writer admission paused. Inspect subagent_list and the recorded offender's full subagent_status audit. Do not change this peer's claims. Contain or clean up every offender first; reopen admission only after confirmed pause or terminal cleanup, then continue or await this peer.",
      );
      return;
    case "paused":
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
      return;
    default:
      return;
  }
}

function evidenceIssues(card: SubagentRunCard, label: string, add: AddIssue): void {
  // Retry guidance belongs with the failure it follows, not on a line of its own.
  const retryGuidance =
    "Inspect expanded details and full subagent_status for cleanup and retry disposition. Do not retry when execution is uncertain or cleanup is unconfirmed; missing projected retry data does not establish eligibility.";
  if (card.error) {
    // Unrecognised worker prose: common service failures get a short name; the full text stays.
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
  if (card.state === "stopping")
    add(
      "warning",
      "cleanup-pending",
      `${label} is stopping; cleanup isn't confirmed yet`,
      "Stopping; cleanup is not yet confirmed. Inspect status before replacement or recovery.",
    );
  // A stop is routine: the stopped status already says it. Cleanup guidance stays expanded.
  if (card.state === "stopped")
    add(
      "info",
      "stopped-cleanup",
      `${label} stopped`,
      "Inspect full status for cleanup confirmation before replacement or recovery.",
    );
  // Source identity, not prose, determines whether the system slot repeats the current warning.
  if (card.warningSource === "system") {
    if (card.warning) quote(add, label, "warning", card.warning, "reported a system warning");
    // Inconsistent historical projections cannot establish that these are one event.
    if (card.systemWarning && card.systemWarning !== card.warning)
      quote(add, label, "system-warning", card.systemWarning, "reported a system warning");
  } else {
    if (card.warning) quote(add, label, "warning", card.warning, "reported a warning");
    if (card.systemWarning)
      quote(add, label, "system-warning", card.systemWarning, "reported a system warning");
  }
  if (card.selection.warning)
    quote(add, label, "selection-warning", card.selection.warning, "has a launch option warning");
  reportEvidenceIssues(card, label, add);
}

function reportEvidenceIssues(card: SubagentRunCard, label: string, add: AddIssue): void {
  // Reviewing reported changes is the normal next step, not a problem.
  if (hasChangesToReview(card))
    add(
      "info",
      "workspace-approval",
      `${label}: changes are ready for review`,
      "A report does not approve workspace integration.",
    );
  // Text this view leaves out entirely is one note for the whole view; only clipped text or
  // claims are this run's own gap.
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
