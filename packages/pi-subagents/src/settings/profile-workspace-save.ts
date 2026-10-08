// Serialized save boundary. No optimistic value is used as a commit receipt.
import { sameProfileCandidate, MAX_PROFILE_CANDIDATES } from "../profiles/model.ts";
import {
  CANDIDATE_LIMIT_REACHED,
  declaredRouteForDraft,
  defaultRouteCandidate,
  addRouteCandidate,
  replaceRouteCandidate,
  type CandidateUpdate,
  type ProfileRouteDraft,
} from "./profile-route-editor.ts";
import type { ProfileEditRestore } from "./profile-edit-visit.ts";
import {
  applyProfileWorkspaceDraftAction,
  type CandidateMenuAction,
} from "./ui/profile-workspace-actions.ts";
import { ProfileWorkspaceState } from "./profile-workspace-state.ts";

export abstract class ProfileWorkspaceSave extends ProfileWorkspaceState {
  protected performDraftAction(action: CandidateMenuAction | "add" | "reset"): void {
    if (action === "add") {
      if (this.refreshBlocked || this.draft().candidates.length >= MAX_PROFILE_CANDIDATES) {
        this.notice(
          "warning",
          this.refreshBlocked
            ? "Close and reopen the editor before making changes."
            : CANDIDATE_LIMIT_REACHED,
        );
        return;
      }
      this.addingCandidate = true;
      this.openModelPicker(
        this.draft().candidates[this.candidateIndex] ?? defaultRouteCandidate(this.profile()),
      );
      return;
    }
    if (action === "reset") {
      const plan = this.editVisit.undoDraft(this.options.target, this.profile(), this.inspection);
      this.pendingAction = undefined;
      if ("error" in plan) {
        this.notice("warning", plan.error);
      } else this.persist(plan.draft, 0, undefined, plan.restore);
      return;
    }
    const result = applyProfileWorkspaceDraftAction({
      action,
      draft: this.draft(),
      candidateIndex: this.candidateIndex,
    });
    if ("error" in result) {
      this.notice("warning", result.error);
    } else if ("unchanged" in result) {
      this.pendingAction = undefined;
      this.notice("info", "Nothing to change");
    } else {
      this.persist(result.draft, result.candidateIndex);
    }
  }

  protected persist(
    next: ProfileRouteDraft,
    preferredCandidateIndex = this.candidateIndex,
    successNotice?: string,
    restore?: ProfileEditRestore,
  ): void {
    if (this.busy) return;
    if (this.refreshBlocked) {
      this.notice("error", "Refresh failed. Close and reopen before editing.");
      return;
    }
    const declaration = declaredRouteForDraft(next);
    if (!declaration.valid) {
      this.notice("error", declaration.error);
      return;
    }
    const profile = this.profile();
    const beforeInspection = this.inspection;
    const field = this.rows()[this.fieldIndex]?.field ?? "model";
    this.remapSelection(this.draft(), next);
    this.optimisticDraft = next;
    this.optimisticProfile = profile;
    this.candidateIndex = preferredCandidateIndex;
    this.selectField(field);
    this.busy = true;
    this.pendingAction = undefined;
    this.notice("info", `Saving ${profile}…`);
    void Promise.resolve()
      .then(() =>
        restore
          ? this.options.saveDraft(this.options.target, profile, next, restore)
          : this.options.saveDraft(this.options.target, profile, next),
      )
      .then((result) => {
        if (this.disposed) return;
        this.busy = false;
        this.candidateIndex = preferredCandidateIndex;
        if ("refreshError" in result) {
          this.refreshBlocked = true;
          this.setMessage("error", result.refreshError);
        } else {
          if (result.conflictMessage) this.editVisit.reconcile(result.inspection);
          else
            this.editVisit.recordSave(
              this.options.target,
              profile,
              beforeInspection,
              result.inspection,
              next,
              result.receipt,
            );
          this.inspection = result.inspection;
          this.options.onInspection?.(result.inspection);
          this.optimisticDraft = undefined;
          this.optimisticProfile = undefined;
          this.setMessage(
            result.conflictMessage ? "warning" : successNotice ? "info" : "success",
            result.conflictMessage ?? (successNotice ? `Saved · ${successNotice}` : "Saved"),
          );
        }
        this.selectField(field);
        this.renderSoon();
      })
      .catch((error) => {
        if (this.disposed) return;
        this.optimisticDraft = undefined;
        this.optimisticProfile = undefined;
        this.busy = false;
        this.refreshBlocked = true;
        const detail = error instanceof Error ? error.message : "Could not save profile settings.";
        this.notice("error", `${detail} Close and reopen the editor before another edit.`);
      });
  }

  protected applyCandidateUpdate(update: CandidateUpdate | undefined): void {
    if (!update) return;
    if (update.error || !update.candidate) {
      this.addingCandidate = false;
      this.notice("warning", update.error ?? "That change could not be applied.");
      return;
    }
    if (this.addingCandidate) {
      this.addingCandidate = false;
      const draft = this.draft();
      const next = addRouteCandidate(draft, update.candidate);
      if (next) {
        this.pane = "fields";
        this.fieldIndex = 0;
        this.persist(next, draft.candidates.length, update.notices.join(" "));
      }
      return;
    }
    const current = this.draft().candidates[this.candidateIndex];
    if (current && sameProfileCandidate(current, update.candidate)) {
      this.notice("info", "Nothing to change");
      return;
    }
    const next = replaceRouteCandidate(this.draft(), this.candidateIndex, update.candidate);
    this.persist(next, this.candidateIndex, update.notices.join(" "));
  }
}
