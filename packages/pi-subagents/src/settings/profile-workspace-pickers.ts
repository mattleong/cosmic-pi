import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { SearchableSelectPage } from "pi-cosmic-ui/manager/searchable-select";
import { PROFILE_IDS, type ProfileCandidate } from "../profiles/model.ts";
import type { SubagentEffort } from "../domain/routing.ts";
import { updateCandidateModel } from "./profile-route-editor.ts";
import { profileModelPickerPage } from "./ui/model-picker.ts";
import {
  candidateFastModeAvailable,
  type SelectableCandidateField,
} from "./ui/profile-workspace-model.ts";
import {
  candidateFieldSelector,
  profileSearchSelector,
  selectHost,
  shortTargetLabel,
} from "./ui/profile-workspace-selectors.ts";
import { ProfileWorkspaceSave } from "./profile-workspace-save.ts";
export abstract class ProfileWorkspacePickers extends ProfileWorkspaceSave {
  protected beginCatalogLoad(message: string): AbortController {
    const controller = new AbortController();
    this.catalogLoad = controller;
    this.busy = true;
    this.notice("info", message);
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
    this.notice("info", "Stopped loading models.");
  }

  protected showSelectPage(page: SearchableSelectPage<string>): void {
    this.selectPage = page;
    page.focused = this.focusState;
    this.renderSoon();
  }

  protected closeSelectPage(): void {
    this.selectPage = undefined;
    this.message = undefined;
    this.renderSoon();
  }

  protected showFieldPicker(
    candidate: ProfileCandidate,
    field: SelectableCandidateField,
    supportedEfforts?: ReadonlyArray<SubagentEffort>,
    fastModeAvailable?: boolean,
    notice?: string,
  ): void {
    const candidateIndex = this.candidateIndex;
    this.showSelectPage(
      candidateFieldSelector({
        ...selectHost(this.options),
        profile: this.profile(),
        candidateIndex,
        candidate,
        field,
        target: this.options.target,
        parentModel: this.options.parentModel,
        parentEffort: this.options.parentEffort,
        supportedEfforts,
        fastModeAvailable,
        notice,
        select: (update) => {
          this.selectPage = undefined;
          this.candidateIndex = candidateIndex;
          this.applyCandidateUpdate(update);
        },
        cancel: () => this.closeSelectPage(),
      }),
    );
  }

  protected openFastModePicker(candidate: ProfileCandidate): void {
    const candidateIndex = this.candidateIndex;
    const controller = this.beginCatalogLoad("Checking fast mode…");
    void this.options
      .loadModelPicker(this.profile(), candidateIndex, candidate, controller.signal)
      .then((picker) => {
        if (!this.finishCatalogLoad(controller)) return undefined;
        const current = Option.getOrUndefined(
          Arr.findFirst(picker.choices, (option) => option.selector === candidate.model),
        );
        this.candidateIndex = candidateIndex;
        this.showFieldPicker(
          candidate,
          "openaiFastMode",
          undefined,
          current?.fastModeAvailable ??
            candidateFastModeAvailable(candidate, this.options.parentModel),
          picker.warning,
        );
        return undefined;
      })
      .catch((cause: unknown) => {
        if (!this.finishCatalogLoad(controller)) return;
        this.notice("error", cause instanceof Error ? cause.message : "Could not check fast mode.");
      });
  }

  protected openModelPicker(candidate: ProfileCandidate): void {
    const candidateIndex = this.addingCandidate
      ? this.draft().candidates.length
      : this.candidateIndex;
    const controller = this.beginCatalogLoad(
      this.addingCandidate ? "Choose a model for the new fallback…" : "Loading models…",
    );
    void this.options
      .loadModelPicker(this.profile(), candidateIndex, candidate, controller.signal)
      .then((picker) => {
        if (!this.finishCatalogLoad(controller)) return undefined;
        if (picker.choices.length === 0) {
          this.addingCandidate = false;
          this.notice("warning", picker.warning ?? "No models are available for this selection.");
          return undefined;
        }
        this.modelPicker = profileModelPickerPage({
          ...selectHost(this.options),
          choices: picker.choices,
          scopedChoices: picker.scopedChoices,
          initialSelection: picker.current,
          context: picker.context,
          targetLabel: shortTargetLabel(this.options.target),
          notice: picker.warning,
          select: (option) => {
            this.modelPicker = undefined;
            if (!this.addingCandidate) this.candidateIndex = candidateIndex;
            const update = updateCandidateModel(
              candidate,
              option.selector,
              option.supportedEfforts,
              option.fastModeAvailable,
            );
            this.applyCandidateUpdate(update);
          },
          cancel: () => {
            this.modelPicker = undefined;
            this.addingCandidate = false;
            this.message = undefined;
            this.renderSoon();
          },
        });
        this.modelPicker.focused = this.focusState;
        this.renderSoon();
        return undefined;
      })
      .catch((cause: unknown) => {
        if (!this.finishCatalogLoad(controller)) return;
        this.addingCandidate = false;
        this.notice("error", cause instanceof Error ? cause.message : "Could not load models.");
      });
  }

  protected openProfileSearch(): void {
    this.showSelectPage(
      profileSearchSelector({
        ...selectHost(this.options),
        inspection: this.inspection,
        current: this.profile(),
        target: this.options.target,
        select: (profile) => {
          this.selectPage = undefined;
          this.rememberSelection();
          this.profileIndex = PROFILE_IDS.indexOf(profile);
          this.resetSelectionForProfile();
          this.pane = "fields";
          this.renderSoon();
        },
        cancel: () => this.closeSelectPage(),
      }),
    );
  }
}
