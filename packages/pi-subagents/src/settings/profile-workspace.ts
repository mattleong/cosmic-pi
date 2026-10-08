// Fixed-target Pi editor. State, saves, and cancellable pickers have separate owners.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import { pageSteps, type FullScreenResolution } from "pi-cosmic-ui/manager/keymap";
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
import { makeRouteActionsSelector, selectHost } from "./ui/profile-workspace-selectors.ts";
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
  readonly inspection: ProfileSettingsInspection;
  readonly target: ProfileWorkspaceTarget;
  readonly initialProfile?: ProfileId | undefined;
  readonly initialField?: ProfileWorkspaceField | undefined;
  readonly initialCandidateIndex?: number | undefined;
  readonly initialFocus?: ProfileWorkspacePane | undefined;
  readonly initialSaveFocused?: boolean | undefined;
  readonly initialAdvancedExpanded?: boolean | undefined;
  readonly initialSelections?: ReadonlyArray<ProfileWorkspaceSelectionMemory> | undefined;
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
  readonly loadModelPicker: (
    profile: ProfileId,
    candidateIndex: number,
    candidate: ProfileCandidate,
    signal?: AbortSignal,
    modelPending?: boolean,
  ) => Promise<CandidateModelPickerData>;
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
  protected openActions(): void {
    if (this.pane === "profiles" && this.saveFocused) return;
    if (!this.draft().candidates[this.candidateIndex]) return;
    if (this.pane === "fields" && this.rows()[this.fieldIndex]?.scope !== "candidate") return;
    this.showSelectPage(
      makeRouteActionsSelector({
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

  protected openSelectedField(): void {
    const row = this.rows()[this.fieldIndex];
    if (!row || this.busy) return;
    if (row.field === "reset") {
      if (this.editVisit.isEdited(this.options.target, this.profile(), this.inspection))
        this.arm("reset");
      else this.notice("info", "No undoable changes from this visit.");
      return;
    }
    if (row.fixed) {
      this.notice("info", row.fixedReason ?? "Nothing to change");
      return;
    }
    if (row.field === "add") {
      this.performDraftAction("add");
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
    const field = row.field;
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
    else this.options.close();
    this.renderSoon();
  }

  protected forward(): void {
    this.message = undefined;
    if (this.pane === "profiles" && this.saveFocused) this.saveSession();
    else if (this.pane === "profiles") this.pane = "fields";
    else this.openSelectedField();
    this.keymap.resetChord();
    this.renderSoon();
  }

  /** Endpoint jumps set the raw pane index without clearing the message or resetting panes. */
  protected moveToEndpoint(action: "first" | "last"): void {
    const last = action === "last";
    if (this.pane === "profiles") {
      this.selectProfileRow(last ? PROFILE_IDS.length : 0);
    } else this.moveRow(last ? this.rows().length - 1 : 0);
  }

  protected saveSession(): void {
    if (this.options.target.kind === "session") this.options.saveSession?.();
  }

  /** One Shortcut press; returns whether it fully consumed the input. */
  protected handleShortcutKey(key: string): boolean {
    if (key === "s") {
      this.saveSession();
      return true;
    }
    if (key === "m" || key === "e" || key === "r") {
      this.saveFocused = false;
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
        this.performDraftAction(this.pendingAction);
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
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: PROFILE_WORKSPACE_SHORTCUTS,
    });
    if (!resolution) return;
    if (this.helpOpen) {
      this.handleHelpInput(resolution);
      return;
    }
    if (resolution._tag === "Shortcut") {
      if (!this.handleShortcutKey(resolution.key)) this.renderSoon();
      return;
    }
    const steps = pageSteps(this.options.getHeight() - 8);
    const move = (offset: number): void => {
      if (this.pane === "profiles") {
        this.selectProfileRow((this.saveFocused ? PROFILE_IDS.length : this.profileIndex) + offset);
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
    if (resolution._tag !== "Action") return;
    if (isMovementMotion(resolution.action)) {
      this.helpScroll = Math.max(
        0,
        Math.min(
          this.helpMaximum,
          this.helpScroll +
            movementOffset(resolution.action, pageSteps(this.options.getHeight() - 3)),
        ),
      );
      this.renderSoon();
    } else if (resolution.action === "first" || resolution.action === "last") {
      this.helpScroll = resolution.action === "first" ? 0 : this.helpMaximum;
      this.renderSoon();
    } else if (["help", "cancel", "back", "quit", "confirm"].includes(resolution.action)) {
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
      case "help":
        this.helpOpen = true;
        return true;
      case "pending-first":
        return true;
    }
    return false; // The dashboard owns next-pane/previous-pane tab switching.
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
        parentEffort: this.options.parentEffort,
        parentModel: this.options.parentModel,
        pane: this.pane,
        profileIndex: this.profileIndex,
        saveFocused: this.saveFocused,
        candidateIndex: this.candidateIndex,
        fieldIndex: this.fieldIndex,
        draft,
        expandedCandidates: this.selection().expanded,
        helpOpen: this.helpOpen,
        helpScroll: this.helpScroll,
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
  }
}
