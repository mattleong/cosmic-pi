import * as Predicate from "effect/Predicate";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import { pageSteps, type FullScreenAction } from "pi-cosmic-ui/manager/keymap";
import { listDetailMotionFromAction } from "pi-cosmic-ui/manager/list-detail";
import { isMovementMotion, movementOffset } from "pi-cosmic-ui/manager/list-navigation";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../profiles/model.ts";
import type { SubagentEffort } from "../domain/routing.ts";
import {
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileWorkspaceTarget,
} from "./profile-route-editor.ts";
import type { CandidateModelPickerData } from "./profile-model-catalog.ts";
import { sessionChangedProfiles } from "../profiles/session-overrides.ts";
import {
  type ProfileWorkspacePane,
  type ProfileWorkspaceField,
} from "./ui/profile-workspace-model.ts";
import { profileWorkspaceConfirmation } from "./ui/profile-workspace-actions.ts";
import {
  renderProfileWorkspace,
  type ProfileWorkspaceConfirmation,
} from "./ui/profile-workspace-render.ts";
import type { DashboardPrompt } from "./ui/profile-dashboard-render.ts";
import {
  PROFILE_WORKSPACE_SHORTCUTS,
  isWorkspaceNavigationKey,
} from "./ui/profile-workspace-keys.ts";
import { routeActionsSelector, selectHost } from "./ui/profile-workspace-selectors.ts";
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

export interface ProfileWorkspaceOptions extends SearchableSelectHostOptions {
  readonly theme: Theme;
  /** The whole surface's height, which with the width decides how panes are arranged. */
  readonly getFrameHeight?: (() => number) | undefined;
  readonly inspection: ProfileSettingsInspection;
  readonly target: ProfileWorkspaceTarget;
  readonly initialProfile?: ProfileId | undefined;
  readonly initialField?: ProfileWorkspaceField | undefined;
  readonly initialCandidateIndex?: number | undefined;
  readonly initialFocus?: ProfileWorkspacePane | undefined;
  readonly initialAdvancedExpanded?: boolean | undefined;
  readonly initialSelections?: ReadonlyMap<ProfileId, ProfileWorkspaceSelectionMemory> | undefined;
  readonly parentModel?: string | undefined;
  readonly parentEffort: SubagentEffort;
  readonly close: () => void;
  readonly saveSession?: (() => void) | undefined;
  readonly saveDraft: (
    target: ProfileWorkspaceTarget,
    profile: ProfileId,
    draft: ProfileRouteDraft,
    restore?: ProfileEditRestore,
  ) => Promise<ProfileWorkspaceSaveResult>;
  readonly loadModelPicker: (candidate: ProfileCandidate) => CandidateModelPickerData;
  readonly supportedPiEfforts: (
    candidate: ProfileCandidate,
  ) => ReadonlyArray<SubagentEffort> | undefined;
  readonly editVisit?: ProfileEditVisit | undefined;
  readonly onInspection?: ((inspection: ProfileSettingsInspection) => void) | undefined;
}

export class ProfileWorkspaceComponent
  extends ProfileWorkspacePickers
  implements Component, Focusable
{
  /** A transient message for the host's status row, such as `Updating scout…`. */
  get status() {
    return this.message;
  }

  /** Lets a finished message go, as when its tab is left; a pending write or a block stays. */
  dismissStatus(): void {
    if (!this.busy && !this.refreshBlocked) this.message = undefined;
  }

  protected openActions(): void {
    if (!this.draft().candidates[this.candidateIndex]) return;
    this.showSelectPage(
      routeActionsSelector({
        ...selectHost(this.options),
        profile: this.profile(),
        candidateIndex: this.candidateIndex,
        draft: this.draft(),
        target: this.options.target,
        select: (action) => {
          this.selectPage = undefined;
          if (action === "remove") this.arm(action);
          else this.performDraftAction(action);
        },
        cancel: () => this.closeSelectPage(),
      }),
    );
  }

  protected arm(action: "remove" | "reset"): void {
    if (this.busy) return;
    this.pendingAction = action;
    this.renderSoon();
  }

  /** Whether `u` can undo the selected profile's changes from this visit. */
  protected canUndo(): boolean {
    return this.editVisit.isEdited(this.options.target, this.profile(), this.inspection);
  }

  protected undo(): void {
    if (this.canUndo()) this.arm("reset");
    else this.notice("info", `No changes to ${this.profile()} to undo.`);
  }

  protected openSelectedField(): void {
    const row = this.rows()[this.fieldIndex];
    if (!row || this.busy) return;
    if (row.fixed) {
      this.notice("info", row.fixedReason ?? "Nothing to change");
      return;
    }
    if (row.field === "advanced") {
      this.advancedExpanded = !this.advancedExpanded;
      this.selectField("advanced");
      this.renderSoon();
      return;
    }
    const candidate =
      row.scope === "candidate" ? this.draft().candidates[this.candidateIndex] : undefined;
    if (candidate) this.openCandidateField(candidate, row.field);
    else this.performDraftAction("add");
  }

  private openCandidateField(
    candidate: ProfileCandidate,
    field: Exclude<ProfileWorkspaceField, "advanced">,
  ): void {
    if (field === "model") this.openModelPicker(candidate);
    else if (field === "openaiFastMode") this.openFastModePicker(candidate);
    else this.showFieldPicker(candidate, field, this.options.supportedPiEfforts(candidate));
  }

  protected back(): void {
    this.message = undefined;
    this.pendingAction = undefined;
    this.keymap.resetChord();
    if (this.pane === "fields") this.focusPane("profiles");
    else this.options.close();
    this.renderSoon();
  }

  protected forward(): void {
    this.message = undefined;
    if (this.pane === "profiles") this.focusPane("fields");
    else this.openSelectedField();
    this.keymap.resetChord();
    this.renderSoon();
  }

  protected saveSession(): void {
    if (this.options.target.kind === "session") this.options.saveSession?.();
  }

  protected handleShortcutKey(key: string): boolean {
    if (key === "s") {
      this.saveSession();
      return true;
    }
    if (key === "m" || key === "e") {
      this.selectField(key === "m" ? "model" : "effort");
      this.focusPane("fields");
      this.openSelectedField();
    } else if (key === "a") this.openActions();
    else if (key === "u") this.undo();
    else if (key === "+") this.performDraftAction("add");
    else if (key === "[" || key === "]")
      this.selectCandidate(this.candidateIndex + (key === "[" ? -1 : 1));
    else if (key === "/" && this.pane === "profiles") this.openProfileSearch();
    return false;
  }

  protected handleModalInput(data: string): void {
    if (isWorkspaceNavigationKey(data)) return;
    if (this.pendingAction) {
      const resolution = this.keymap.resolve(data, {
        mode: "confirmation",
        matchesKeybinding: this.options.matchesKeybinding,
      });
      const action = Predicate.isTagged(resolution, "Action") ? resolution.action : undefined;
      if (action === "cancel") {
        this.pendingAction = undefined;
        this.message = undefined;
        this.renderSoon();
      } else if (action === "confirm") this.performDraftAction(this.pendingAction);
    }
  }

  handleInput(data: string): void {
    if (this.disposed) return;
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
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: PROFILE_WORKSPACE_SHORTCUTS,
    });
    if (!resolution) return;
    if (Predicate.isTagged(resolution, "Shortcut")) {
      if (!this.handleShortcutKey(resolution.key)) this.renderSoon();
      return;
    }
    if (this.handleNavigationAction(resolution.action)) this.renderSoon();
  }

  /** The fields pane moves its own cursor; the shell moves the profile selection and focus. */
  protected handleNavigationAction(action: FullScreenAction): boolean {
    if (action === "help") {
      this.hintsExpanded = !this.hintsExpanded;
      return true;
    }
    if (action === "confirm") {
      this.forward();
      return false;
    }
    if (action === "cancel" || action === "quit") {
      this.back();
      return false;
    }
    if (this.pane === "fields" && isMovementMotion(action)) {
      this.moveRow(
        this.fieldIndex + movementOffset(action, pageSteps(this.options.getHeight() - 8)),
      );
      this.message = undefined;
      return true;
    }
    if (this.pane === "fields" && (action === "first" || action === "last")) {
      this.moveRow(action === "last" ? this.rows().length - 1 : 0);
      return true;
    }
    const motion = listDetailMotionFromAction(action);
    if (!motion) return action === "pending-first";
    const result = this.shell.applyMotion(motion, {
      rowCount: PROFILE_IDS.length,
      hasSelection: true,
    });
    if (!Predicate.isTagged(result, "Update")) return false;
    if (result.movedSelection) {
      this.selectProfileRow(result.state.selected);
      this.message = undefined;
    }
    return true;
  }

  private confirmation(): ProfileWorkspaceConfirmation | undefined {
    const profile = this.profile();
    if (this.pendingAction === "reset")
      return {
        title: `Undo changes to ${profile}?`,
        detail:
          "Restores it to how it was when you opened the dashboard. Other profiles and active runs are not changed.",
        verb: "Undo",
      };
    return this.pendingAction
      ? profileWorkspaceConfirmation({
          profile,
          candidateIndex: this.candidateIndex,
          candidateCount: this.draft().candidates.length,
          scope: this.scope,
        })
      : undefined;
  }

  /** Changes the session makes to the set it is based on, which `s` can save as a set. */
  private changedProfiles(): ReadonlySet<ProfileId> {
    return this.options.target.kind === "session"
      ? new Set(sessionChangedProfiles(this.inspection.session))
      : new Set();
  }

  render(width: number): string[] {
    return this.renderWithPrompt(width);
  }

  /** Draws the editor; a host's `prompt`, such as a confirmation, takes a band above the border. */
  renderWithPrompt(width: number, prompt?: DashboardPrompt): string[] {
    if (this.disposed) return [];
    if (this.modelPicker) return this.modelPicker.render(width);
    this.reconcile();
    return renderProfileWorkspace(
      {
        inspection: this.inspection,
        target: this.options.target,
        parentEffort: this.options.parentEffort,
        parentModel: this.options.parentModel,
        shell: this.shell,
        candidateIndex: this.candidateIndex,
        fieldIndex: this.fieldIndex,
        draft: this.draft(),
        expandedCandidates: this.selection().expanded,
        hintsExpanded: this.hintsExpanded,
        changedProfiles: this.changedProfiles(),
        canUndo: !this.busy && this.canUndo(),
        busy: this.busy,
        choices: this.selectPage,
        confirmation: this.confirmation(),
        prompt,
      },
      {
        theme: this.options.theme,
        width,
        height: this.options.getHeight(),
        frameHeight: this.options.getFrameHeight?.() ?? this.options.getHeight(),
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
    this.modelPicker = undefined;
    this.selectPage = undefined;
  }
}
