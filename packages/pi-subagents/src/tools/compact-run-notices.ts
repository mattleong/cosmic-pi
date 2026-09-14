import type { CompactNotice } from "pi-code-previews";
import type { SubagentRunCard } from "./details-schema.ts";

type AddNotice = (text: string, kind?: CompactNotice["kind"]) => void;

/** Card audits are bounded projections, never authority for granting paths. */
export function compactRunNotices(
  cards: readonly SubagentRunCard[],
  reportsOnlyOmitted = false,
): CompactNotice[] {
  const notices: CompactNotice[] = [];
  for (const card of cards) {
    const id = JSON.stringify(card.id);
    const add = (text: string, kind: CompactNotice["kind"] = "recovery") =>
      notices.push({
        kind,
        text: `${card.name === card.id ? card.id : `${card.name} (${card.id})`}: ${text}`,
      });
    if (card.writeViolationOffender) {
      const terminal = ["completed", "failed", "stopped"].includes(card.state);
      add(
        "Claim containment. Review the full audit and shared tree with subagent_status; projected paths may be omitted. Do not use subagent_reply for containment.",
      );
      if (card.state !== "paused" && !terminal) {
        add(
          "Wait for containment to reach paused or terminal, then inspect status. If still active, check again; do not issue a duplicate stop solely because pause has not published.",
        );
      }
      if (!terminal && card.capabilities.includes("resume")) {
        add(
          `Once confirmed paused, if the full audit proves all writes workspace-relative, grant only reviewed, intended, conflict-free missing claims with subagent_claims. Then subagent_claims({ action: "resume_admission", runId: ${id} }), then subagent_lifecycle({ action: "resume", runIds: [${id}], message: "Continue only within the authoritative claims returned by subagent_claims." }), then subagent_await. If containment instead reaches terminal, confirm process and writer cleanup before reopening admission and launching and awaiting a corrected replacement. If any write is outside the workspace, stop and confirm process and writer cleanup before reopening admission and launching and awaiting a corrected replacement with exact safe claims.`,
        );
      } else {
        add(
          `Once containment reaches paused or terminal, if paused, stop with subagent_lifecycle({ action: "stop", runIds: [${id}] }). Confirm process and writer cleanup before subagent_claims({ action: "resume_admission", runId: ${id} }); then launch a corrected replacement with reviewed exact workspace-relative claims and await its run ID.`,
        );
      }
    } else if (card.writeAdmissionPaused) {
      add(
        "Writer admission paused. Inspect subagent_list and the recorded offender's full subagent_status audit. Do not change this peer's claims. Contain or clean up every offender first; reopen admission only after confirmed pause or terminal cleanup, then continue or await this peer.",
      );
    } else if (card.state === "paused") {
      add(
        card.capabilities.includes("resume")
          ? `Paused. Review subagent_status, then subagent_lifecycle({ action: "resume", runIds: [${id}], message: "Continue with reviewed guidance." }), then subagent_await again.`
          : `Paused; this backend cannot resume. Stop with subagent_lifecycle({ action: "stop", runIds: [${id}] }), confirm cleanup, then launch a corrected replacement and await its run ID.`,
      );
    } else if (card.question) {
      add(
        `Question: ${card.question.message}\nRead the full question in expanded details if omitted. If this is a writer's request for additional file claims, review and grant only intended, conflict-free workspace-relative claims with subagent_claims before replying. Reply with subagent_reply({ runId: ${id}, message: "..." }), then subagent_await again.`,
      );
    } else if (card.state === "waiting_for_parent") {
      add(
        "Waiting for parent, but no question is projected. Inspect full subagent_status before choosing recovery; do not invent a reply.",
      );
    }
    evidenceNotices(card, add, reportsOnlyOmitted);
  }
  return notices;
}

function evidenceNotices(card: SubagentRunCard, add: AddNotice, reportsOnlyOmitted: boolean): void {
  if (card.error || card.state === "failed") {
    add(card.error ?? "Run failed; inspect full status.", "error");
    add(
      "Inspect expanded details and full subagent_status for cleanup and retry disposition. Do not retry when execution is uncertain or cleanup is unconfirmed; missing projected retry data does not establish eligibility.",
    );
  }
  if (card.state === "stopping")
    add("Stopping; cleanup is not yet confirmed. Inspect status before replacement or recovery.");
  if (card.state === "stopped")
    add("Stopped. Inspect full status for cleanup confirmation before replacement or recovery.");
  for (const warning of new Set([card.warning, card.selection.warning]))
    if (warning) add(warning, "warning");
  for (const skipped of card.selection.skippedCandidates)
    add(`${skipped.candidate}: ${skipped.reason}`, "warning");
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
    add("A report does not approve workspace integration.");
  const partialReport =
    card.finalTextTruncated && (!reportsOnlyOmitted || card.finalText !== undefined);
  if (card.writeClaimsOmitted || card.errorTruncated || partialReport)
    add("Details are bounded; inspect full subagent_status for omitted evidence.");
  if (card.writeAudit?.violations.length && !card.writeViolationOffender)
    add(
      "Recorded write violations are available in expanded details. Inspect the full audit and current offender status before recovery.",
      "warning",
    );
}
