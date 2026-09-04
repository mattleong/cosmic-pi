// Profile settings are a Promise-shaped Pi host UI boundary.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable } from "@earendil-works/pi-tui";
import { FullScreenKeymap, pageSteps } from "pi-cosmic-ui/manager/keymap";
import {
  PROFILE_IDS,
  sameProfileCandidate,
  type ProfileCandidate,
  type ProfileId,
} from "../profiles/model.ts";
import type { SubagentEffort } from "../domain/routing.ts";
import {
  declaredRouteForDraft,
  hasOwnProfileRouteDeclaration,
  inheritProjectDraft,
  inheritSessionDraft,
  profileWorkspaceScope,
  replaceRouteCandidate,
  resetGlobalDraft,
  type CandidateUpdate,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileSettingsScope,
  type ProfileWorkspaceTarget,
} from "./profile-route-editor.ts";
import {
  updateCandidateFromModelChoice,
  type CandidateModelPickerData,
} from "./profile-model-catalog.ts";
import { makeProfileModelPickerPage, type ProfileModelChoice } from "./ui/model-picker.ts";
import { isMovementMotion, movementOffset } from "pi-cosmic-ui/manager/list-navigation";
import {
  candidateFieldRows,
  draftKindLabel,
  profileRouteDraftSummary,
  targetProfileRouteDraft,
  type ProfileWorkspacePane,
  type SelectableCandidateField,
} from "./ui/profile-workspace-model.ts";
import {
  applyProfileWorkspaceDraftAction,
  profileWorkspaceConfirmation,
  type ProfileWorkspaceDraftAction,
} from "./ui/profile-workspace-actions.ts";
import { renderProfileWorkspace } from "./ui/profile-workspace-render.ts";
import {
  makeCandidateFieldSelector,
  makeProfileSearchSelector,
  makeRouteActionsSelector,
} from "./ui/profile-workspace-selectors.ts";
import {
  SearchableSelectPage,
  type SearchableSelectHostOptions,
} from "pi-cosmic-ui/manager/searchable-select";

export type ProfileWorkspaceSaveResult =
  | {
      readonly inspection: ProfileSettingsInspection;
      readonly conflictMessage?: string | undefined;
    }
  | { readonly refreshError: string };

export type ProfileWorkspaceCloseResult =
  | false
  | { readonly action: "sets"; readonly profile: ProfileId };

export interface ProfileWorkspaceOptions extends SearchableSelectHostOptions {
  readonly theme: Theme;
  readonly inspection: ProfileSettingsInspection;
  readonly projectTrusted: boolean;
  readonly target: ProfileWorkspaceTarget;
  readonly initialProfile?: ProfileId | undefined;
  readonly preferredPiModel: () => string | undefined;
  readonly parentModel?: string | undefined;
  readonly parentEffort: SubagentEffort;
  readonly close: (result: ProfileWorkspaceCloseResult) => void;
  readonly saveDraft: (
    target: ProfileWorkspaceTarget,
    profile: ProfileId,
    draft: ProfileRouteDraft,
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
}

type PendingAction = Extract<ProfileWorkspaceDraftAction, "remove" | "disable" | "reset">;
type WorkspaceMessage = {
  readonly kind: "info" | "success" | "warning" | "error";
  readonly text: string;
};

const targetSaveLabel = (target: ProfileWorkspaceTarget): string =>
  target.kind === "session"
    ? "Current Session"
    : `${target.set.scope === "project" ? "Project" : "Global"}/${target.set.name}`;

export class ProfileWorkspaceComponent implements Component, Focusable {
  private inspection: ProfileSettingsInspection;
  private readonly scope: ProfileSettingsScope;
  private pane: ProfileWorkspacePane = "profiles";
  private profileIndex: number;
  private candidateIndex = 0;
  private fieldIndex = 0;
  private advancedExpanded = false;
  private optimisticDraft: ProfileRouteDraft | undefined;
  private optimisticProfile: ProfileId | undefined;
  private busy = false;
  private refreshBlocked = false;
  private message: WorkspaceMessage | undefined;
  private pendingAction: PendingAction | undefined;
  private catalogLoad: AbortController | undefined;
  private modelPicker: ReturnType<typeof makeProfileModelPickerPage> | undefined;
  private selectPage: SearchableSelectPage<string> | undefined;
  private _focused = false;
  private disposed = false;
  private readonly keymap = new FullScreenKeymap();
  private readonly options: ProfileWorkspaceOptions;

  constructor(options: ProfileWorkspaceOptions) {
    this.options = options;
    this.inspection = options.inspection;
    this.scope = profileWorkspaceScope(options.target);
    this.profileIndex = Math.max(0, PROFILE_IDS.indexOf(options.initialProfile ?? "generalist"));
    this.reconcile();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    if (this.disposed) return;
    this._focused = value;
    if (this.modelPicker) this.modelPicker.focused = value;
    if (this.selectPage) this.selectPage.focused = value;
  }

  private profile(): ProfileId {
    return PROFILE_IDS[this.profileIndex] ?? PROFILE_IDS[0];
  }

  private draft(): ProfileRouteDraft {
    const profile = this.profile();
    if (this.optimisticDraft && this.optimisticProfile === profile) return this.optimisticDraft;
    return targetProfileRouteDraft(this.inspection, this.options.target, profile);
  }

  private rows() {
    const candidate = this.draft().candidates[this.candidateIndex];
    if (!candidate)
      return [
        { field: "actions" as const, label: "Actions", value: "add or fix profile", fixed: false },
      ];
    return candidateFieldRows(
      candidate,
      this.profile(),
      this.options.parentEffort,
      this.options.parentModel,
      this.advancedExpanded,
      { index: this.candidateIndex, count: this.draft().candidates.length },
    );
  }

  private reconcile(): void {
    this.profileIndex = Math.max(0, Math.min(PROFILE_IDS.length - 1, this.profileIndex));
    const candidates = this.draft().candidates;
    this.candidateIndex = Math.max(
      0,
      Math.min(Math.max(0, candidates.length - 1), this.candidateIndex),
    );
    this.fieldIndex = Math.max(0, Math.min(Math.max(0, this.rows().length - 1), this.fieldIndex));
  }

  private renderSoon(): void {
    if (this.disposed) return;
    this.reconcile();
    this.options.requestRender();
  }

  private setMessage(kind: WorkspaceMessage["kind"], text: string): void {
    this.message = { kind, text };
  }

  private resetSelectionForProfile(): void {
    this.candidateIndex = 0;
    this.fieldIndex = 0;
    this.advancedExpanded = false;
    this.pendingAction = undefined;
    this.message = undefined;
  }

  private persist(
    next: ProfileRouteDraft,
    description: string,
    preferredCandidateIndex = this.candidateIndex,
    optimisticDraft: ProfileRouteDraft = next,
  ): void {
    if (this.busy) return;
    if (this.refreshBlocked) {
      this.setMessage(
        "error",
        "Profiles could not be refreshed. Close and reopen the editor before making changes.",
      );
      this.renderSoon();
      return;
    }
    const declaration = declaredRouteForDraft(next);
    if (!declaration.valid) {
      this.setMessage("error", declaration.error);
      this.renderSoon();
      return;
    }
    const profile = this.profile();
    this.optimisticDraft = optimisticDraft;
    this.optimisticProfile = profile;
    this.candidateIndex = preferredCandidateIndex;
    this.busy = true;
    this.pendingAction = undefined;
    this.setMessage(
      "info",
      `Saving ${targetSaveLabel(this.options.target)} · ${profile} · ${description}`,
    );
    this.renderSoon();
    void this.options
      .saveDraft(this.options.target, profile, next)
      .then((result) => {
        if (this.disposed) return;
        this.busy = false;
        this.candidateIndex = preferredCandidateIndex;
        if ("refreshError" in result) {
          this.refreshBlocked = true;
          this.setMessage("error", result.refreshError);
        } else {
          this.inspection = result.inspection;
          this.optimisticDraft = undefined;
          this.optimisticProfile = undefined;
          this.setMessage(
            result.conflictMessage ? "warning" : "success",
            result.conflictMessage ??
              `Saved ${targetSaveLabel(this.options.target)} · ${profile} · ${description}`,
          );
        }
        this.renderSoon();
      })
      .catch((error) => {
        if (this.disposed) return;
        this.optimisticDraft = undefined;
        this.optimisticProfile = undefined;
        this.busy = false;
        this.refreshBlocked = true;
        const detail = error instanceof Error ? error.message : "Could not save profile settings.";
        this.setMessage("error", `${detail} Close and reopen the editor before another edit.`);
        this.renderSoon();
      });
  }

  private applyCandidateUpdate(update: CandidateUpdate | undefined, description: string): void {
    if (!update) return;
    if (update.error || !update.candidate) {
      this.setMessage("warning", update.error ?? "That change could not be applied.");
      this.renderSoon();
      return;
    }
    const current = this.draft().candidates[this.candidateIndex];
    if (current && sameProfileCandidate(current, update.candidate)) {
      this.setMessage("info", "No profile change was needed.");
      this.renderSoon();
      return;
    }
    const notice = update.notices.length > 0 ? ` · ${update.notices.join(" ")}` : "";
    this.persist(
      replaceRouteCandidate(this.draft(), this.candidateIndex, update.candidate),
      `${description}${notice}`,
    );
  }

  private beginCatalogLoad(message: string): AbortController {
    const controller = new AbortController();
    this.catalogLoad = controller;
    this.busy = true;
    this.setMessage("info", message);
    this.renderSoon();
    return controller;
  }

  private finishCatalogLoad(controller: AbortController): boolean {
    if (this.disposed || this.catalogLoad !== controller) return false;
    this.catalogLoad = undefined;
    this.busy = false;
    return true;
  }

  private cancelCatalogLoad(): void {
    const controller = this.catalogLoad;
    if (!controller) return;
    this.catalogLoad = undefined;
    this.busy = false;
    controller.abort();
    this.setMessage("info", "Stopped loading models.");
    this.renderSoon();
  }

  private selectorTargetLabel(): string {
    return this.options.target.kind === "session"
      ? "Current Session"
      : `Saved set · ${this.options.target.set.scope === "project" ? "Project" : "Global"}/${this.options.target.set.name} · Current Session unchanged`;
  }

  private showFieldPicker(
    candidate: ProfileCandidate,
    field: SelectableCandidateField,
    supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined,
    fastModeAvailable?: boolean | undefined,
    notice?: string | undefined,
  ): void {
    const candidateIndex = this.candidateIndex;
    const selectorBase = {
      theme: this.options.theme,
      profile: this.profile(),
      candidateIndex,
      candidate,
      field,
      target: this.options.target,
      piModel: this.options.preferredPiModel(),
      parentModel: this.options.parentModel,
      parentEffort: this.options.parentEffort,
      supportedEfforts,
      fastModeAvailable,
      getHeight: this.options.getHeight,
      requestRender: this.options.requestRender,
      matchesKeybinding: this.options.matchesKeybinding,
      keybindingLabel: this.options.keybindingLabel,
      select: (update: CandidateUpdate, description: string) => {
        this.selectPage = undefined;
        this.candidateIndex = candidateIndex;
        if (
          field === "runWith" &&
          update.candidate &&
          update.candidate.runtime !== candidate.runtime &&
          update.candidate.runtime !== "pi"
        ) {
          this.openModelPicker(
            update.candidate,
            true,
            "Run with and model changed",
            update.notices,
          );
          return;
        }
        this.applyCandidateUpdate(update, description);
      },
      cancel: (label: string) => {
        this.selectPage = undefined;
        this.setMessage("info", `${label} was not changed.`);
        this.renderSoon();
      },
    };
    this.selectPage = makeCandidateFieldSelector(
      notice ? { ...selectorBase, notice } : selectorBase,
    );
    this.selectPage.focused = this._focused;
    this.renderSoon();
  }

  private openFastModePicker(candidate: ProfileCandidate): void {
    const candidateIndex = this.candidateIndex;
    const controller = this.beginCatalogLoad("Checking fast mode…");
    void this.options
      .loadModelPicker(this.profile(), candidateIndex, candidate, controller.signal)
      .then((picker) => {
        if (!this.finishCatalogLoad(controller)) return;
        const current = picker.choices.find((choice) =>
          candidate.model === "parent"
            ? choice.choice.kind === "parent"
            : choice.choice.kind === "model" && choice.choice.selector === candidate.model,
        );
        this.candidateIndex = candidateIndex;
        this.showFieldPicker(
          candidate,
          "openaiFastMode",
          undefined,
          current?.fastModeAvailable ?? this.options.fastModeAvailable(candidate),
          picker.warning,
        );
      })
      .catch((error) => {
        if (!this.finishCatalogLoad(controller)) return;
        this.setMessage(
          "error",
          error instanceof Error ? error.message : "Could not check fast mode.",
        );
        this.renderSoon();
      });
  }

  private openNativeEffortPicker(candidate: ProfileCandidate): void {
    const candidateIndex = this.candidateIndex;
    const controller = this.beginCatalogLoad("Loading reasoning levels…");
    void this.options
      .loadModelPicker(this.profile(), candidateIndex, candidate, controller.signal)
      .then((picker) => {
        if (!this.finishCatalogLoad(controller)) return;
        const current = picker.choices.find(
          (choice) => choice.choice.kind === "model" && choice.choice.selector === candidate.model,
        );
        this.candidateIndex = candidateIndex;
        this.showFieldPicker(
          candidate,
          "effort",
          current?.supportedEfforts,
          undefined,
          picker.warning,
        );
      })
      .catch((error) => {
        if (!this.finishCatalogLoad(controller)) return;
        this.setMessage(
          "error",
          error instanceof Error ? error.message : "Could not load reasoning levels.",
        );
        this.renderSoon();
      });
  }

  private openModelPicker(
    candidate: ProfileCandidate,
    preferAdvertisedDefault = false,
    description = "Model changed",
    priorNotices: ReadonlyArray<string> = [],
  ): void {
    const candidateIndex = this.candidateIndex;
    const controller = this.beginCatalogLoad("Loading models…");
    void this.options
      .loadModelPicker(this.profile(), candidateIndex, candidate, controller.signal)
      .then((picker) => {
        if (!this.finishCatalogLoad(controller)) return;
        if (picker.choices.length === 0) {
          this.setMessage(
            "warning",
            picker.warning ?? "No models are available for this selection.",
          );
          this.renderSoon();
          return;
        }
        const pickerBase = {
          theme: this.options.theme,
          choices: picker.choices,
          scopedChoices: picker.scopedChoices,
          initialSelection: preferAdvertisedDefault
            ? (picker.defaultSelector ?? picker.current)
            : picker.current,
          context: picker.context,
          targetLabel: this.selectorTargetLabel(),
          getHeight: this.options.getHeight,
          requestRender: this.options.requestRender,
          matchesKeybinding: this.options.matchesKeybinding,
          keybindingLabel: this.options.keybindingLabel,
          select: (choice: ProfileModelChoice) => {
            this.modelPicker = undefined;
            this.candidateIndex = candidateIndex;
            const update = updateCandidateFromModelChoice(candidate, picker, choice);
            this.applyCandidateUpdate(
              update.candidate
                ? { ...update, notices: [...priorNotices, ...update.notices] }
                : update,
              description,
            );
          },
          cancel: () => {
            this.modelPicker = undefined;
            this.setMessage(
              "info",
              preferAdvertisedDefault
                ? "Run with settings were not changed because no model was selected."
                : "Model was not changed.",
            );
            this.renderSoon();
          },
        };
        this.modelPicker = makeProfileModelPickerPage(
          picker.warning ? { ...pickerBase, notice: picker.warning } : pickerBase,
        );
        this.modelPicker.focused = this._focused;
        this.renderSoon();
      })
      .catch((error) => {
        if (!this.finishCatalogLoad(controller)) return;
        this.setMessage("error", error instanceof Error ? error.message : "Could not load models.");
        this.renderSoon();
      });
  }

  private openProfileSearch(): void {
    this.selectPage = makeProfileSearchSelector({
      theme: this.options.theme,
      inspection: this.inspection,
      current: this.profile(),
      parentEffort: this.options.parentEffort,
      parentModel: this.options.parentModel,
      target: this.options.target,
      getHeight: this.options.getHeight,
      requestRender: this.options.requestRender,
      matchesKeybinding: this.options.matchesKeybinding,
      keybindingLabel: this.options.keybindingLabel,
      select: (profile: ProfileId) => {
        this.selectPage = undefined;
        this.profileIndex = PROFILE_IDS.indexOf(profile);
        this.resetSelectionForProfile();
        this.pane = "candidates";
        this.renderSoon();
      },
      cancel: () => {
        this.selectPage = undefined;
        this.setMessage("info", "Profile search canceled.");
        this.renderSoon();
      },
    });
    this.selectPage.focused = this._focused;
    this.renderSoon();
  }

  private openActions(): void {
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
      target: this.options.target,
      getHeight: this.options.getHeight,
      requestRender: this.options.requestRender,
      matchesKeybinding: this.options.matchesKeybinding,
      keybindingLabel: this.options.keybindingLabel,
      select: (action, destructive) => {
        this.selectPage = undefined;
        if (destructive && (action === "remove" || action === "disable" || action === "reset"))
          this.arm(action);
        else this.performDraftAction(action);
      },
      cancel: () => {
        this.selectPage = undefined;
        this.setMessage("info", "Actions closed.");
        this.renderSoon();
      },
    });
    this.selectPage.focused = this._focused;
    this.renderSoon();
  }

  private performDraftAction(action: ProfileWorkspaceDraftAction): void {
    const result = applyProfileWorkspaceDraftAction({
      action,
      draft: this.draft(),
      profile: this.profile(),
      candidateIndex: this.candidateIndex,
      scope: this.scope,
      inspection: this.inspection,
      hasOwnDeclaration: hasOwnProfileRouteDeclaration(
        this.inspection,
        this.options.target,
        this.profile(),
      ),
    });
    if ("error" in result) {
      this.setMessage("warning", result.error);
      this.renderSoon();
    } else if ("unchanged" in result) {
      this.pendingAction = undefined;
      this.setMessage("info", "No profile change was needed.");
      this.renderSoon();
    } else {
      if (action !== "move-up" && action !== "move-down") {
        this.fieldIndex = 0;
        this.advancedExpanded = false;
      }
      const restoringInvalidLowerRoute =
        action === "reset" && this.scope !== "global" && result.draft.kind === "invalid";
      this.persist(
        restoringInvalidLowerRoute
          ? { kind: "inherit", candidates: result.draft.candidates }
          : result.draft,
        result.description,
        result.candidateIndex,
        result.draft,
      );
    }
  }

  private arm(action: PendingAction): void {
    if (this.busy) return;
    this.pendingAction = action;
    this.renderSoon();
  }

  private confirmPending(): void {
    if (this.pendingAction) this.performDraftAction(this.pendingAction);
  }

  private openSelectedField(): void {
    const row = this.rows()[this.fieldIndex];
    if (!row || this.busy) return;
    if (row.field === "actions") {
      this.openActions();
      return;
    }
    if (row.field === "advanced") {
      this.advancedExpanded = !this.advancedExpanded;
      this.fieldIndex = this.rows().findIndex((entry) => entry.field === "advanced");
      this.renderSoon();
      return;
    }
    const candidate = this.draft().candidates[this.candidateIndex];
    if (!candidate) return;
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
      this.openNativeEffortPicker(candidate);
      return;
    }
    if (field === "openaiFastMode") {
      this.openFastModePicker(candidate);
      return;
    }
    this.showFieldPicker(
      candidate,
      field,
      candidate.runtime === "pi" ? this.options.supportedPiEfforts(candidate) : undefined,
    );
  }

  private back(): void {
    this.message = undefined;
    this.pendingAction = undefined;
    this.keymap.resetChord();
    if (this.pane === "fields") this.pane = "candidates";
    else if (this.pane === "candidates") this.pane = "profiles";
    else this.options.close(false);
  }

  private forward(): void {
    this.message = undefined;
    if (this.pane === "profiles") this.pane = "candidates";
    else if (this.pane === "candidates") {
      this.pane = "fields";
      this.fieldIndex = 0;
      this.advancedExpanded = false;
    } else this.openSelectedField();
    this.keymap.resetChord();
  }

  /** Endpoint jumps set the raw pane index without clearing the message or resetting panes. */
  private moveToEndpoint(action: "first" | "last"): void {
    const last = action === "last";
    if (this.pane === "profiles") this.profileIndex = last ? PROFILE_IDS.length - 1 : 0;
    else if (this.pane === "candidates")
      this.candidateIndex = last ? Math.max(0, this.draft().candidates.length - 1) : 0;
    else this.fieldIndex = last ? Math.max(0, this.rows().length - 1) : 0;
  }

  /** One Shortcut press; returns whether it fully consumed the input. */
  private handleShortcutKey(key: string): boolean {
    if (key === "p") {
      this.options.close({ action: "sets", profile: this.profile() });
      return true;
    }
    if (key === "/" && this.pane === "profiles") this.openProfileSearch();
    return false;
  }

  /** Confirmation and busy-mode keys; both modes consume the input unconditionally. */
  private handleModalInput(data: string): void {
    if (this.pendingAction) {
      const resolution = this.keymap.resolve(data, {
        mode: "confirmation",
        matchesKeybinding: this.options.matchesKeybinding,
      });
      if (resolution?._tag === "Action" && resolution.action === "cancel") {
        this.pendingAction = undefined;
        this.setMessage("info", "Confirmation canceled.");
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
      reservedKeys: new Set(["/", "p"]),
    });
    if (!resolution) return;
    if (resolution._tag === "Shortcut") {
      if (this.handleShortcutKey(resolution.key)) return;
      this.renderSoon();
      return;
    }
    const steps = pageSteps(this.options.getHeight() - 8);
    const move = (offset: number): void => {
      if (this.pane === "profiles") {
        this.profileIndex = Math.max(
          0,
          Math.min(PROFILE_IDS.length - 1, this.profileIndex + offset),
        );
        this.resetSelectionForProfile();
      } else if (this.pane === "candidates") {
        this.candidateIndex = Math.max(
          0,
          Math.min(Math.max(0, this.draft().candidates.length - 1), this.candidateIndex + offset),
        );
        this.fieldIndex = 0;
        this.advancedExpanded = false;
      } else {
        this.fieldIndex = Math.max(0, Math.min(this.rows().length - 1, this.fieldIndex + offset));
      }
      this.message = undefined;
    };
    if (isMovementMotion(resolution.action)) {
      move(movementOffset(resolution.action, steps));
      this.renderSoon();
      return;
    }
    if (this.handleNavigationAction(resolution.action)) this.renderSoon();
  }

  /** Non-movement navigation actions; returns whether the input only needs a re-render. */
  private handleNavigationAction(action: string): boolean {
    switch (action) {
      case "cancel":
      case "quit":
      case "back":
        this.back();
        return false;
      case "confirm":
      case "forward":
        this.forward();
        return false;
      case "first":
      case "last":
        this.moveToEndpoint(action);
        return true;
      case "search":
        if (this.pane === "profiles") this.openProfileSearch();
        return false;
      case "help":
      case "next-pane":
      case "previous-pane":
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
    const profile = this.profile();
    const draft = this.draft();
    const resetDraft =
      this.scope === "global"
        ? resetGlobalDraft(profile)
        : this.scope === "project"
          ? inheritProjectDraft(this.inspection, profile)
          : inheritSessionDraft(this.inspection, profile);
    const resetCurrent = `${draftKindLabel(draft, this.scope)} · ${profileRouteDraftSummary(profile, draft, this.options.parentEffort, this.options.parentModel)}`;
    const resetSummary = profileRouteDraftSummary(
      profile,
      resetDraft,
      this.options.parentEffort,
      this.options.parentModel,
    );
    const resetAfter =
      this.scope === "global"
        ? `built-in · ${resetSummary}`
        : this.scope === "project"
          ? `next available default · ${resetSummary}`
          : resetSummary;
    const confirmationBase = this.pendingAction
      ? {
          action: this.pendingAction,
          profile,
          candidateIndex: this.candidateIndex,
          candidateCount: draft.candidates.length,
          scope: this.scope,
        }
      : undefined;
    const confirmationInput =
      confirmationBase && this.pendingAction === "reset"
        ? { ...confirmationBase, currentSummary: resetCurrent, afterSummary: resetAfter }
        : confirmationBase;
    const pendingConfirmation = confirmationInput
      ? profileWorkspaceConfirmation(confirmationInput)
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
