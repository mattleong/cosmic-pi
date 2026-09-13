// Fixed-target Pi editor. State, saves, and cancellable pickers have separate owners.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import { pageSteps, type FullScreenResolution } from "pi-cosmic-ui/manager/keymap";
import { isMovementMotion, movementOffset } from "pi-cosmic-ui/manager/list-navigation";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../profiles/model.ts";
import type { SubagentEffort } from "../domain/routing.ts";
import {
  hasOwnProfileRouteDeclaration,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileWorkspaceTarget,
} from "./profile-route-editor.ts";
import type { CandidateModelPickerData } from "./profile-model-catalog.ts";
import type { ProfileWorkspacePane, ProfileWorkspaceField } from "./ui/profile-workspace-model.ts";
import { profileWorkspaceConfirmation } from "./ui/profile-workspace-actions.ts";
import {
  renderProfileWorkspace,
  profileWorkspaceHelpLines,
} from "./ui/profile-workspace-render.ts";
import {
  PROFILE_WORKSPACE_SHORTCUTS,
  isWorkspaceNavigationKey,
} from "./ui/profile-workspace-keys.ts";
import { makeRouteActionsSelector } from "./ui/profile-workspace-selectors.ts";
import { ProfileWorkspacePickers } from "./profile-workspace-pickers.ts";
import type { ProfileWorkspaceSelectionMemory } from "./profile-workspace-state.ts";
import type {
  ProfileEditVisit,
  ProfileEditRestore,
  ProfileEditCommitReceipt,
} from "./profile-edit-visit.ts";

export type ProfileWorkspaceSaveResult =
  | {
      readonly inspection: ProfileSettingsInspection;
      readonly conflictMessage?: string | undefined;
      readonly receipt?: ProfileEditCommitReceipt | undefined;
    }
  | { readonly refreshError: string };

export type ProfileWorkspaceCloseResult =
  | false
  | {
      readonly action: "sets" | "select-target" | "save-session" | "use-current";
      readonly profile: ProfileId;
      readonly field?: ProfileWorkspaceField | undefined;
      readonly candidateIndex?: number | undefined;
      readonly pane?: ProfileWorkspacePane | undefined;
      readonly advancedExpanded?: boolean | undefined;
    };

export interface ProfileWorkspaceOptions extends SearchableSelectHostOptions {
  readonly theme: Theme;
  readonly inspection: ProfileSettingsInspection;
  readonly projectTrusted: boolean;
  readonly target: ProfileWorkspaceTarget;
  readonly initialProfile?: ProfileId | undefined;
  readonly initialField?: ProfileWorkspaceField | undefined;
  readonly initialCandidateIndex?: number | undefined;
  readonly initialFocus?: ProfileWorkspacePane | undefined;
  readonly initialAdvancedExpanded?: boolean | undefined;
  readonly initialSelections?: ReadonlyArray<ProfileWorkspaceSelectionMemory> | undefined;
  readonly preferredPiModel: () => string | undefined;
  readonly parentModel?: string | undefined;
  readonly parentEffort: SubagentEffort;
  readonly close: (result: ProfileWorkspaceCloseResult) => void;
  readonly saveDraft: (
    target: ProfileWorkspaceTarget,
    profile: ProfileId,
    draft: ProfileRouteDraft,
    restore?: ProfileEditRestore,
  ) => Promise<ProfileWorkspaceSaveResult>;
  readonly loadModelPicker: (
    profile: ProfileId,
    candidateIndex: number,
    candidate: ProfileCandidate,
    signal?: AbortSignal,
  ) => Promise<CandidateModelPickerData>;
  readonly supportedPiEfforts: (
    candidate: ProfileCandidate,
  ) => ReadonlyArray<SubagentEffort> | undefined;
  readonly fastModeAvailable: (candidate: ProfileCandidate) => boolean;
  readonly onDispose?: (() => void) | undefined;
  readonly editVisit?: ProfileEditVisit | undefined;
  readonly backLabel?: string | undefined;
  readonly onInspection?: ((inspection: ProfileSettingsInspection) => void) | undefined;
}

export class ProfileWorkspaceComponent
  extends ProfileWorkspacePickers
  implements Component, Focusable
{
  protected openActions(): void {
    this.selectPage = makeRouteActionsSelector({
      theme: this.options.theme,
      profile: this.profile(),
      candidateIndex: this.candidateIndex,
      draft: this.draft(),
      scope: this.scope,
      hasOwnDeclaration: hasOwnProfileRouteDeclaration(
        this.inspection,
        this.options.target,
        this.profile(),
      ),
      canUndo: !(
        "error" in this.editVisit.undoDraft(this.options.target, this.profile(), this.inspection)
      ),
      target: this.options.target,
      getHeight: this.options.getHeight,
      requestRender: this.options.requestRender,
      matchesKeybinding: this.options.matchesKeybinding,
      keybindingLabel: this.options.keybindingLabel,
      select: (action, destructive) => {
        this.selectPage = undefined;
        if (destructive && (action === "remove" || action === "reset")) this.arm(action);
        else this.performDraftAction(action);
      },
      cancel: () => {
        this.selectPage = undefined;
        this.message = undefined;
        this.renderSoon();
      },
    });
    this.selectPage.focused = this._focused;
    this.renderSoon();
  }

  protected arm(action: "remove" | "reset"): void {
    if (this.busy) return;
    this.pendingAction = action;
    this.renderSoon();
  }

  protected confirmPending(): void {
    if (this.pendingAction) this.performDraftAction(this.pendingAction);
  }

  protected openSelectedField(): void {
    const row = this.rows()[this.fieldIndex];
    if (!row || this.busy) return;
    if (row.field === "save-session") {
      this.saveSession();
      return;
    }
    if (row.field === "actions") {
      this.openActions();
      return;
    }
    if (row.field === "advanced") {
      this.advancedExpanded = !this.advancedExpanded;
      this.selectField("advanced");
      this.renderSoon();
      return;
    }
    const candidate = this.draft().candidates[this.candidateIndex];
    if (!candidate) {
      if (row.field === "model") this.performDraftAction("add");
      return;
    }
    if (row.fixed) {
      this.setMessage(
        "info",
        row.fixedReason ?? `${row.label.trim()} cannot be changed for this selection.`,
      );
      this.renderSoon();
      return;
    }
    const field = row.field;
    if (field === "move-up" || field === "move-down") {
      this.performDraftAction(field);
      return;
    }
    if (field === "remove") {
      this.arm("remove");
      return;
    }
    if (field === "model") {
      this.openModelPicker(candidate);
      return;
    }
    if (field === "effort" && candidate.runtime !== "pi") {
      this.openCapabilityPicker(candidate, "effort");
      return;
    }
    if (field === "openaiFastMode") {
      this.openCapabilityPicker(candidate, "openaiFastMode");
      return;
    }
    this.showFieldPicker(
      candidate,
      field,
      candidate.runtime === "pi" ? this.options.supportedPiEfforts(candidate) : undefined,
    );
  }

  protected back(): void {
    this.message = undefined;
    this.pendingAction = undefined;
    this.keymap.resetChord();
    if (this.pane === "fields") this.pane = "profiles";
    else this.options.close(false);
    this.renderSoon();
  }

  protected forward(): void {
    this.message = undefined;
    if (this.pane === "profiles") this.pane = "fields";
    else this.openSelectedField();
    this.keymap.resetChord();
    this.renderSoon();
  }

  /** Endpoint jumps set the raw pane index without clearing the message or resetting panes. */
  protected moveToEndpoint(action: "first" | "last"): void {
    const last = action === "last";
    if (this.pane === "profiles") {
      this.rememberSelection();
      this.profileIndex = last ? PROFILE_IDS.length - 1 : 0;
      this.resetSelectionForProfile();
    } else this.moveRow(last ? this.rows().length - 1 : 0);
  }

  protected saveSession(): void {
    if (this.options.target.kind !== "session") return;
    this.options.close({
      action: "save-session",
      profile: this.profile(),
      candidateIndex: this.candidateIndex,
      field: this.rows()[this.fieldIndex]?.field,
      pane: this.pane,
      advancedExpanded: this.advancedExpanded,
    });
  }

  /** One Shortcut press; returns whether it fully consumed the input. */
  protected handleShortcutKey(key: string): boolean {
    if (key === "s") {
      this.saveSession();
      return true;
    }
    if (key === "j" || key === "k") {
      this.pane = key === "j" ? "fields" : "profiles";
    } else if (key === "m" || key === "e" || key === "r") {
      this.selectField(key === "m" ? "model" : key === "e" ? "effort" : "runWith");
      this.pane = "fields";
      this.openSelectedField();
    } else if (key === "a") this.openActions();
    else if (key === "+") this.performDraftAction("add");
    else if (key === "[" || key === "]")
      this.selectCandidate(this.candidateIndex + (key === "[" ? -1 : 1));
    else if (key === "/" && this.pane === "profiles") this.openProfileSearch();
    return false;
  }

  /** Confirmation and busy-mode keys; both modes consume the input unconditionally. */
  protected handleModalInput(data: string): void {
    if (isWorkspaceNavigationKey(data)) return;
    if (this.pendingAction) {
      const resolution = this.keymap.resolve(data, {
        mode: "confirmation",
        matchesKeybinding: this.options.matchesKeybinding,
      });
      if (resolution?._tag === "Action" && resolution.action === "cancel") {
        this.pendingAction = undefined;
        this.message = undefined;
        this.renderSoon();
      } else if (resolution?._tag === "Action" && resolution.action === "confirm")
        this.confirmPending();
      return;
    }
    const resolution = this.keymap.resolve(data, {
      mode: "busy",
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (this.catalogLoad && resolution?._tag === "Action" && resolution.action === "cancel")
      this.cancelCatalogLoad();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    // Shared selectors treat Right as confirmation; profile edits require Enter.
    if ((this.modelPicker || this.selectPage) && matchesKey(data, "right")) return;
    if (this.modelPicker) {
      this.modelPicker.handleInput(data);
      return;
    }
    if (this.selectPage) {
      this.selectPage.handleInput(data);
      return;
    }
    if (this.pendingAction || this.busy) {
      this.handleModalInput(data);
      return;
    }
    const resolution = this.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: isWorkspaceNavigationKey(data)
        ? undefined
        : this.options.matchesKeybinding,
      reservedKeys: PROFILE_WORKSPACE_SHORTCUTS,
    });
    if (!resolution) return;
    if (this.helpOpen) {
      this.handleHelpInput(resolution);
      return;
    }
    if (resolution._tag === "Shortcut") {
      if (this.handleShortcutKey(resolution.key)) return;
      this.renderSoon();
      return;
    }
    const steps = pageSteps(this.options.getHeight() - 8);
    const move = (offset: number): void => {
      if (this.pane === "profiles") {
        this.rememberSelection();
        this.profileIndex = Math.max(
          0,
          Math.min(PROFILE_IDS.length - 1, this.profileIndex + offset),
        );
        this.resetSelectionForProfile();
      } else this.moveRow(this.fieldIndex + offset);
      this.message = undefined;
    };
    if (isMovementMotion(resolution.action)) {
      move(movementOffset(resolution.action, steps));
      this.renderSoon();
      return;
    }
    if (this.handleNavigationAction(resolution.action)) this.renderSoon();
  }

  protected handleHelpInput(resolution: FullScreenResolution): void {
    if (resolution._tag === "Action" && isMovementMotion(resolution.action)) {
      this.helpScroll = Math.max(
        0,
        Math.min(
          this.helpMaximum,
          this.helpScroll +
            movementOffset(resolution.action, pageSteps(this.options.getHeight() - 3)),
        ),
      );
      this.renderSoon();
    } else if (
      resolution._tag === "Action" &&
      (resolution.action === "first" || resolution.action === "last")
    ) {
      this.helpScroll = resolution.action === "first" ? 0 : this.helpMaximum;
      this.renderSoon();
    } else if (
      resolution._tag === "Action" &&
      ["help", "cancel", "back", "quit", "confirm"].includes(resolution.action)
    ) {
      this.helpOpen = false;
      this.renderSoon();
    }
  }

  /** Non-movement navigation actions; returns whether the input only needs a re-render. */
  protected handleNavigationAction(action: string): boolean {
    switch (action) {
      case "cancel":
      case "quit":
        this.back();
        return false;
      case "back":
        this.pane = "profiles";
        return true;
      case "confirm":
        this.forward();
        return false;
      case "forward":
        this.pane = "fields";
        return true;
      case "first":
      case "last":
        this.moveToEndpoint(action);
        return true;
      case "search":
        if (this.pane === "profiles") this.openProfileSearch();
        return false;
      case "help":
        this.helpOpen = true;
        return true;
      case "next-pane":
      case "previous-pane":
        // The dashboard owns tab switching; standalone editors have no tab target.
        return false;
      case "pending-first":
        return true;
    }
    return false;
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    if (this.modelPicker) return this.modelPicker.render(width);
    if (this.selectPage) return this.selectPage.render(width);
    this.reconcile();
    this.helpMaximum = Math.max(
      0,
      profileWorkspaceHelpLines(this.options.keybindingLabel, width - 2).length -
        Math.max(1, this.options.getHeight() - 3),
    );
    const profile = this.profile();
    const draft = this.draft();
    const pendingConfirmation =
      this.pendingAction === "reset"
        ? {
            title: `Undo changes to ${profile}?`,
            detail:
              "Restore this profile to the start of this editing visit. Other profiles and active runs are not changed.",
          }
        : this.pendingAction
          ? profileWorkspaceConfirmation({
              action: this.pendingAction,
              profile,
              candidateIndex: this.candidateIndex,
              candidateCount: draft.candidates.length,
              scope: this.scope,
            })
          : undefined;
    return renderProfileWorkspace(
      {
        inspection: this.inspection,
        target: this.options.target,
        scope: this.scope,
        projectTrusted: this.options.projectTrusted,
        parentEffort: this.options.parentEffort,
        parentModel: this.options.parentModel,
        pane: this.pane,
        profileIndex: this.profileIndex,
        candidateIndex: this.candidateIndex,
        fieldIndex: this.fieldIndex,
        draft,
        advancedExpanded: this.advancedExpanded,
        expandedCandidates: this.selection().expanded,
        helpOpen: this.helpOpen,
        helpScroll: this.helpScroll,
        backLabel: this.options.backLabel,
        editedProfiles: new Set(
          PROFILE_IDS.filter((id) =>
            this.editVisit.isEdited(this.options.target, id, this.inspection),
          ),
        ),
        busy: this.busy,
        cancellableBusy: this.catalogLoad !== undefined,
        message: this.message,
        pendingConfirmation,
      },
      {
        theme: this.options.theme,
        width,
        height: this.options.getHeight(),
        keybindingLabel: this.options.keybindingLabel,
      },
    );
  }

  invalidate(): void {
    if (this.disposed) return;
    this.modelPicker?.invalidate();
    this.selectPage?.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.catalogLoad?.abort();
    this.catalogLoad = undefined;
    this.modelPicker = undefined;
    this.selectPage = undefined;
    try {
      this.options.onDispose?.();
    } catch {
      // Host disposal is best effort and cannot reactivate a closed settings surface.
    }
  }
}
