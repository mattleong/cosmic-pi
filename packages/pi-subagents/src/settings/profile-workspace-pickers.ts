import { findOrUndefined } from "pi-cosmic-core/array";
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
import type { ProfileWorkspaceSelectPage } from "./profile-workspace-state.ts";
export abstract class ProfileWorkspacePickers extends ProfileWorkspaceSave {
  protected showSelectPage(page: ProfileWorkspaceSelectPage): void {
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
    const picker = this.options.loadModelPicker(candidate);
    const current = findOrUndefined(
      picker.choices,
      (option) => option.selector === candidate.model,
    );
    this.message = undefined;
    this.showFieldPicker(
      candidate,
      "openaiFastMode",
      undefined,
      current?.fastModeAvailable ?? candidateFastModeAvailable(candidate, this.options.parentModel),
      picker.warning,
    );
  }

  protected openModelPicker(candidate: ProfileCandidate): void {
    const candidateIndex = this.addingCandidate
      ? this.draft().candidates.length
      : this.candidateIndex;
    const picker = this.options.loadModelPicker(candidate);
    this.message = undefined;
    if (picker.choices.length === 0) {
      this.addingCandidate = false;
      this.notice("warning", picker.warning ?? "No models are available for this selection.");
      return;
    }
    this.modelPicker = profileModelPickerPage({
      ...selectHost(this.options),
      choices: picker.choices,
      scopedChoices: picker.scopedChoices,
      initialSelection: candidate.model,
      context: { profile: this.profile(), candidateIndex },
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
  }

  protected openProfileSearch(): void {
    this.showSelectPage(
      profileSearchSelector({
        ...selectHost(this.options),
        inspection: this.inspection,
        current: this.profile(),
        target: this.options.target,
        parentModel: this.options.parentModel,
        select: (profile) => {
          this.selectPage = undefined;
          this.selectProfileRow(PROFILE_IDS.indexOf(profile));
          this.focusPane("fields");
          this.renderSoon();
        },
        cancel: () => this.closeSelectPage(),
      }),
    );
  }
}
