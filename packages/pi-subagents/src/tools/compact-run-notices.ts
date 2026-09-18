import type { CompactNotice } from "pi-code-previews";
import type { SubagentRunCard } from "./details-schema.ts";

type AddNotice = (code: string | undefined, text: string, kind?: CompactNotice["kind"]) => void;

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
export function compactRunNotices(
  cards: readonly SubagentRunCard[],
  reportsOnlyOmitted = false,
  quietHistory = false,
  quietChildWarnings = false,
) {
  const notices: CompactNotice[] = [];
  let skipped = 0;
  for (const card of cards) {
    const noticeStart = notices.length;
    const id = JSON.stringify(card.id);
    const add: AddNotice = (code, text, kind = "recovery") => {
      const notice: CompactNotice = {
        kind,
        text: `${card.name === card.id ? card.id : `${card.name} (${card.id})`}: ${text}`,
      };
      if (code) notice.code = `${card.id}:${code}`;
      notices.push(notice);
    };
    if (card.writeViolationOffender) {
      const terminal = ["completed", "failed", "stopped"].includes(card.state);
      add(
        "containment-audit",
        "Claim containment. Review the full audit and shared tree with subagent_status; projected paths may be omitted. Do not use subagent_reply for containment.",
      );
      if (card.state !== "paused" && !terminal) {
        add(
          "containment-wait",
          "Wait for containment to reach paused or terminal, then inspect status. If still active, check again; do not issue a duplicate stop solely because pause has not published.",
        );
      }
      if (!terminal && card.capabilities.includes("resume")) {
        add(
          "containment-resume",
          `Once confirmed paused, if the full audit proves all writes workspace-relative, grant only reviewed, intended, conflict-free missing claims with subagent_claims. Then subagent_claims({ action: "resume_admission", runId: ${id} }), then subagent_lifecycle({ action: "resume", runIds: [${id}], message: "Continue only within the authoritative claims returned by subagent_claims." }), then subagent_await. If containment instead reaches terminal, confirm process and writer cleanup before reopening admission and launching and awaiting a corrected replacement. If any write is outside the workspace, stop and confirm process and writer cleanup before reopening admission and launching and awaiting a corrected replacement with exact safe claims.`,
        );
      } else {
        add(
          "containment-stop",
          `Once containment reaches paused or terminal, if paused, stop with subagent_lifecycle({ action: "stop", runIds: [${id}] }). Confirm process and writer cleanup before subagent_claims({ action: "resume_admission", runId: ${id} }); then launch a corrected replacement with reviewed exact workspace-relative claims and await its run ID.`,
        );
      }
    } else if (card.writeAdmissionPaused) {
      add(
        "peer-admission-paused",
        "Writer admission paused. Inspect subagent_list and the recorded offender's full subagent_status audit. Do not change this peer's claims. Contain or clean up every offender first; reopen admission only after confirmed pause or terminal cleanup, then continue or await this peer.",
      );
    } else if (card.state === "paused") {
      add(
        "paused-recovery",
        card.capabilities.includes("resume")
          ? `Paused. Review subagent_status, then subagent_lifecycle({ action: "resume", runIds: [${id}], message: "Continue with reviewed guidance." }), then subagent_await again.`
          : `Paused; this backend cannot resume. Stop with subagent_lifecycle({ action: "stop", runIds: [${id}] }), confirm cleanup, then launch a corrected replacement and await its run ID.`,
      );
    } else if (card.question) {
      add(
        "parent-question",
        `Question: ${card.question.message}\nRead the full question in expanded details if omitted. If this is a writer's request for additional file claims, review and grant only intended, conflict-free workspace-relative claims with subagent_claims before replying. Reply with subagent_reply({ runId: ${id}, message: "..." }), then subagent_await again.`,
      );
    } else if (card.state === "waiting_for_parent") {
      add(
        "question-unavailable",
        "Waiting for parent, but no question is projected. Inspect full subagent_status before choosing recovery; do not invent a reply.",
      );
    }
    evidenceNotices(card, add, reportsOnlyOmitted, quietChildWarnings);
    if (
      !quietHistory ||
      !["completed", "reported"].includes(card.state) ||
      notices.length !== noticeStart ||
      card.selection.skippedCandidates.some((skipped) => !staticSkipCodes.has(skipped.code))
    )
      for (const skipped of card.selection.skippedCandidates)
        add(
          `selection:${skipped.candidate}:${skipped.code}`,
          `${skipped.candidate}: ${skipped.reason}`,
          "warning",
        );
    else skipped += card.selection.skippedCandidates.length;
  }
  return { notices, skipped };
}

function evidenceNotices(
  card: SubagentRunCard,
  add: AddNotice,
  reportsOnlyOmitted: boolean,
  quietChildWarnings: boolean,
): void {
  if (card.error || card.state === "failed") {
    add(
      card.error ? undefined : "run-failed",
      card.error ?? "Run failed; inspect full status.",
      "error",
    );
    add(
      "failure-recovery",
      "Inspect expanded details and full subagent_status for cleanup and retry disposition. Do not retry when execution is uncertain or cleanup is unconfirmed; missing projected retry data does not establish eligibility.",
    );
  }
  if (card.state === "stopping")
    add(
      "cleanup-pending",
      "Stopping; cleanup is not yet confirmed. Inspect status before replacement or recovery.",
    );
  if (card.state === "stopped")
    add(
      "stopped-cleanup",
      "Stopped. Inspect full status for cleanup confirmation before replacement or recovery.",
    );
  const warning = quietChildWarnings
    ? (card.systemWarning ?? (card.warningSource === "child" ? undefined : card.warning))
    : card.warning;
  for (const notice of new Set([warning, card.selection.warning]))
    if (notice) add(undefined, notice, "warning");
  reportEvidenceNotices(card, add, reportsOnlyOmitted);
}

function reportEvidenceNotices(
  card: SubagentRunCard,
  add: AddNotice,
  reportsOnlyOmitted: boolean,
): void {
  if (
    (card.finalText || card.finalTextTruncated || card.state === "reported") &&
    card.writeIntent === "writer" &&
    (card.writerWorkspaceMode === "worktree" || card.workspaceId)
  )
    add("workspace-approval", "A report does not approve workspace integration.");
  const partialReport =
    card.finalTextTruncated && (!reportsOnlyOmitted || card.finalText !== undefined);
  if (card.writeClaimsOmitted || card.errorTruncated || partialReport)
    add(
      "evidence-omitted",
      "Details are bounded; inspect full subagent_status for omitted evidence.",
    );
  if (card.writeAudit?.violations.length && !card.writeViolationOffender)
    add(
      "write-audit",
      "Recorded write violations are available in expanded details. Inspect the full audit and current offender status before recovery.",
      "warning",
    );
}
