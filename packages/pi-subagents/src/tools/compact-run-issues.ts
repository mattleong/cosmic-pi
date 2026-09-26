import { firstLineMessage, type CompactIssue } from "pi-code-previews";
import type { SubagentRunCard } from "./details-schema.ts";

/** Card-scoped issue: the message names the worker; its expanded detail keeps the run ID. */
type AddIssue = (
  severity: CompactIssue["severity"],
  code: string,
  message: string,
  detail?: string,
) => void;

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

/** Card audits are bounded projections, never authority for granting paths. */
export function compactRunIssues(
  cards: readonly SubagentRunCard[],
  reportsOnlyOmitted: boolean,
  quietHistory: boolean,
): CompactIssue[] {
  const issues: CompactIssue[] = [];
  for (const card of cards) {
    const issueStart = issues.length;
    const label = (card.name === card.id ? "Worker" : card.name).slice(0, 60);
    const add: AddIssue = (severity, code, message, detail) =>
      issues.push({
        severity,
        code: `${card.id}:${code}`,
        message: `${label}: ${message}`,
        ...(detail && { detail: `${card.id}: ${detail}` }),
      });
    attentionIssues(card, add);
    evidenceIssues(card, add, reportsOnlyOmitted);
    const skipped = card.selection.skippedCandidates;
    if (!skipped.length) continue;
    // Clean terminal static skips are routine history: kept, but only on expansion.
    const quiet =
      quietHistory &&
      ["completed", "reported"].includes(card.state) &&
      issues.length === issueStart &&
      skipped.every((entry) => staticSkipCodes.has(entry.code));
    add(
      quiet ? "info" : "warning",
      "selection-skipped",
      skipped.length === 1
        ? "A configured worker option was skipped"
        : `${skipped.length} configured worker options were skipped`,
      skipped.map((entry) => `${entry.candidate}: ${entry.reason}`).join("\n"),
    );
  }
  return issues;
}

function attentionIssues(card: SubagentRunCard, add: AddIssue): void {
  const id = JSON.stringify(card.id);
  if (card.writeViolationOffender) {
    const terminal = ["completed", "failed", "stopped"].includes(card.state);
    add(
      "warning",
      "containment-audit",
      "A file-access violation was detected",
      "Claim containment. Review the full audit and shared tree with subagent_status; projected paths may be omitted. Do not use subagent_reply for containment.",
    );
    if (card.state !== "paused" && !terminal)
      add(
        "warning",
        "containment-wait",
        "The worker has not yet confirmed that it paused or stopped",
        "Wait for containment to reach paused or terminal, then inspect status. If still active, check again; do not issue a duplicate stop solely because pause has not published.",
      );
    if (!terminal && card.capabilities.includes("resume"))
      add(
        "info",
        "containment-resume",
        "The worker can resume only after its claims are reviewed",
        `Once confirmed paused, if the full audit proves all writes workspace-relative, grant only reviewed, intended, conflict-free missing claims with subagent_claims. Then subagent_claims({ action: "resume_admission", runId: ${id} }), then subagent_lifecycle({ action: "resume", runIds: [${id}], message: "Continue only within the authoritative claims returned by subagent_claims." }), then subagent_await. If containment instead reaches terminal, confirm process and writer cleanup before reopening admission and launching and awaiting a corrected replacement. If any write is outside the workspace, stop and confirm process and writer cleanup before reopening admission and launching and awaiting a corrected replacement with exact safe claims.`,
      );
    else
      add(
        "info",
        "containment-stop",
        "The worker must be stopped and replaced",
        `Once containment reaches paused or terminal, if paused, stop with subagent_lifecycle({ action: "stop", runIds: [${id}] }). Confirm process and writer cleanup before subagent_claims({ action: "resume_admission", runId: ${id} }); then launch a corrected replacement with reviewed exact workspace-relative claims and await its run ID.`,
      );
  } else if (card.writeAdmissionPaused)
    add(
      "warning",
      "peer-admission-paused",
      "New writing is paused while a file-access issue is resolved",
      "Writer admission paused. Inspect subagent_list and the recorded offender's full subagent_status audit. Do not change this peer's claims. Contain or clean up every offender first; reopen admission only after confirmed pause or terminal cleanup, then continue or await this peer.",
    );
  else if (card.state === "paused")
    add(
      "warning",
      "paused-recovery",
      "The worker is paused",
      card.capabilities.includes("resume")
        ? `Paused. Review subagent_status, then subagent_lifecycle({ action: "resume", runIds: [${id}], message: "Continue with reviewed guidance." }), then subagent_await again.`
        : `Paused; this backend cannot resume. Stop with subagent_lifecycle({ action: "stop", runIds: [${id}] }), confirm cleanup, then launch a corrected replacement and await its run ID.`,
    );
  else if (card.question)
    add(
      "warning",
      "parent-question",
      "The worker needs a reply",
      `Question: ${card.question.message}\nRead the full question in expanded details if omitted. If this is a writer's request for additional file claims, review and grant only intended, conflict-free workspace-relative claims with subagent_claims before replying. Reply with subagent_reply({ runId: ${id}, message: "..." }), then subagent_await again.`,
    );
  else if (card.state === "waiting_for_parent")
    add(
      "warning",
      "question-unavailable",
      "The worker needs a reply, but its question is unavailable",
      "Waiting for parent, but no question is projected. Inspect full subagent_status before choosing recovery; do not invent a reply.",
    );
}

function evidenceIssues(card: SubagentRunCard, add: AddIssue, reportsOnlyOmitted: boolean): void {
  if (card.error) {
    // Unrecognised worker prose: its first line explains the failure; the full text stays below.
    const message = firstLineMessage(card.error, "The worker reported an error");
    add("error", "error", message, card.error.trim() === message ? undefined : card.error);
  } else if (card.state === "failed")
    add("error", "run-failed", "The worker failed", "Run failed; inspect full status.");
  if (card.error || card.state === "failed")
    add(
      "info",
      "failure-recovery",
      "Confirm cleanup before retrying",
      "Inspect expanded details and full subagent_status for cleanup and retry disposition. Do not retry when execution is uncertain or cleanup is unconfirmed; missing projected retry data does not establish eligibility.",
    );
  if (card.state === "stopping")
    add(
      "warning",
      "cleanup-pending",
      "The worker is stopping; cleanup is not yet confirmed",
      "Stopping; cleanup is not yet confirmed. Inspect status before replacement or recovery.",
    );
  if (card.state === "stopped")
    add(
      "warning",
      "stopped-cleanup",
      "The worker stopped; its cleanup status needs confirmation",
      "Stopped. Inspect full status for cleanup confirmation before replacement or recovery.",
    );
  // Source identity, not prose, determines whether the system slot repeats the current warning.
  if (card.warningSource === "system") {
    if (card.warning) add("warning", "warning", "A system warning needs review", card.warning);
    // Inconsistent historical projections cannot establish that these are one event.
    if (card.systemWarning && card.systemWarning !== card.warning)
      add(
        "warning",
        "system-warning",
        card.warning ? "Another system warning needs review" : "A system warning needs review",
        card.systemWarning,
      );
  } else {
    if (card.warning) add("warning", "warning", "The worker reported a warning", card.warning);
    if (card.systemWarning)
      add("warning", "system-warning", "A system warning needs review", card.systemWarning);
  }
  if (card.selection.warning)
    add(
      "warning",
      "selection-warning",
      "A worker option produced a warning",
      card.selection.warning,
    );
  reportEvidenceIssues(card, add, reportsOnlyOmitted);
}

function reportEvidenceIssues(
  card: SubagentRunCard,
  add: AddIssue,
  reportsOnlyOmitted: boolean,
): void {
  if (
    (card.finalText || card.finalTextTruncated || card.state === "reported") &&
    card.writeIntent === "writer" &&
    (card.writerWorkspaceMode === "worktree" || card.workspaceId)
  )
    add(
      "warning",
      "workspace-approval",
      "The proposed changes have not been approved for integration",
      "A report does not approve workspace integration.",
    );
  const partialReport =
    card.finalTextTruncated && (!reportsOnlyOmitted || card.finalText !== undefined);
  if (card.writeClaimsOmitted || card.errorTruncated || partialReport)
    add(
      "warning",
      "evidence-omitted",
      "Some worker details are unavailable in this view",
      "Details are bounded; inspect full subagent_status for omitted evidence.",
    );
  if (card.writeAudit?.violations.length && !card.writeViolationOffender)
    add(
      "warning",
      "write-audit",
      "File-access violations were recorded",
      "Recorded write violations are available in expanded details. Inspect the full audit and current offender status before recovery.",
    );
}
