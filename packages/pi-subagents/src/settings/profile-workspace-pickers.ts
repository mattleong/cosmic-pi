// Cancellable full-page selectors. Runtime and model changes commit together.
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../profiles/model.ts";
import type { SubagentEffort } from "../domain/routing.ts";
import type { CandidateUpdate } from "./profile-route-editor.ts";
import { updateCandidateFromModelChoice } from "./profile-model-catalog.ts";
import { makeProfileModelPickerPage, type ProfileModelChoice } from "./ui/model-picker.ts";
import type { SelectableCandidateField } from "./ui/profile-workspace-model.ts";
import {
  makeCandidateFieldSelector,
  makeProfileSearchSelector,
} from "./ui/profile-workspace-selectors.ts";
import { ProfileWorkspaceSave } from "./profile-workspace-save.ts";
export abstract class ProfileWorkspacePickers extends ProfileWorkspaceSave {
  protected beginCatalogLoad(message: string): AbortController {
    const controller = new AbortController();
    this.catalogLoad = controller;
    this.busy = true;
    this.setMessage("info", message);
    this.renderSoon();
    return controller;
  }

  protected finishCatalogLoad(controller: AbortController): boolean {
    if (this.disposed || this.catalogLoad !== controller) return false;
    this.catalogLoad = undefined;
    this.busy = false;
    this.message = undefined;
    return true;
  }

  protected cancelCatalogLoad(): void {
    const controller = this.catalogLoad;
    if (!controller) return;
    this.catalogLoad = undefined;
    this.busy = false;
    this.addingCandidate = false;
    controller.abort();
    this.setMessage("info", "Stopped loading models.");
    this.renderSoon();
  }

  protected selectorTargetLabel(): string {
    return this.options.target.kind === "session"
      ? "Session"
      : `${this.options.target.set.scope === "project" ? "Project" : "Global"}/${this.options.target.set.name}`;
  }

  protected showFieldPicker(
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
          update.candidate.runtime !== candidate.runtime
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
      cancel: () => {
        this.selectPage = undefined;
        this.message = undefined;
        this.renderSoon();
      },
    };
    this.selectPage = makeCandidateFieldSelector(
      notice ? { ...selectorBase, notice } : selectorBase,
    );
    this.selectPage.focused = this._focused;
    this.renderSoon();
  }

  protected openCapabilityPicker(
    candidate: ProfileCandidate,
    field: "openaiFastMode" | "effort",
  ): void {
    const candidateIndex = this.candidateIndex;
    const fastMode = field === "openaiFastMode";
    const controller = this.beginCatalogLoad(
      fastMode ? "Checking fast mode…" : "Loading reasoning levels…",
    );
    void this.options
      .loadModelPicker(this.profile(), candidateIndex, candidate, controller.signal)
      .then((picker) => {
        if (!this.finishCatalogLoad(controller)) return;
        const current = picker.choices.find((choice) =>
          fastMode && candidate.model === "parent"
            ? choice.choice.kind === "parent"
            : choice.choice.kind === "model" && choice.choice.selector === candidate.model,
        );
        this.candidateIndex = candidateIndex;
        this.showFieldPicker(
          candidate,
          field,
          fastMode ? undefined : current?.supportedEfforts,
          fastMode
            ? (current?.fastModeAvailable ?? this.options.fastModeAvailable(candidate))
            : undefined,
          picker.warning,
        );
      })
      .catch((error) => {
        if (!this.finishCatalogLoad(controller)) return;
        this.setMessage(
          "error",
          error instanceof Error
            ? error.message
            : fastMode
              ? "Could not check fast mode."
              : "Could not load reasoning levels.",
        );
        this.renderSoon();
      });
  }

  protected openModelPicker(
    candidate: ProfileCandidate,
    preferAdvertisedDefault = false,
    description = "Model changed",
    priorNotices: ReadonlyArray<string> = [],
  ): void {
    const candidateIndex = this.addingCandidate
      ? this.draft().candidates.length
      : this.candidateIndex;
    const controller = this.beginCatalogLoad(
      this.addingCandidate ? "Choose a model for the new fallback…" : "Loading models…",
    );
    void this.options
      .loadModelPicker(this.profile(), candidateIndex, candidate, controller.signal)
      .then((picker) => {
        if (!this.finishCatalogLoad(controller)) return;
        if (picker.choices.length === 0) {
          this.addingCandidate = false;
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
            if (!this.addingCandidate) this.candidateIndex = candidateIndex;
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
            this.addingCandidate = false;
            this.message = undefined;
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
        this.addingCandidate = false;
        this.setMessage("error", error instanceof Error ? error.message : "Could not load models.");
        this.renderSoon();
      });
  }

  protected openProfileSearch(): void {
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
        this.rememberSelection();
        this.profileIndex = PROFILE_IDS.indexOf(profile);
        this.resetSelectionForProfile();
        this.pane = "fields";
        this.renderSoon();
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
}
