// Cancellable full-page selectors. Runtime and model changes commit together.
import type { SearchableSelectPage } from "pi-cosmic-ui/manager/searchable-select";
import { PROFILE_IDS, type ProfileCandidate } from "../profiles/model.ts";
import type { SubagentEffort } from "../domain/routing.ts";
import { updateCandidateControls, updateCandidateModel } from "./profile-route-editor.ts";
import { makeProfileModelPickerPage } from "./ui/model-picker.ts";
import {
  candidateFastModeAvailable,
  runWithChoice,
  type SelectableCandidateField,
} from "./ui/profile-workspace-model.ts";
import {
  makeCandidateFieldSelector,
  makeProfileSearchSelector,
  selectHost,
  shortTargetLabel,
} from "./ui/profile-workspace-selectors.ts";
import { ProfileWorkspaceSave } from "./profile-workspace-save.ts";
import type { ModelPickerOpening } from "./profile-workspace-state.ts";
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
    page.focused = this._focused;
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
    supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined,
    fastModeAvailable?: boolean | undefined,
    notice?: string | undefined,
  ): void {
    const candidateIndex = this.candidateIndex;
    this.showSelectPage(
      makeCandidateFieldSelector({
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
        select: (update, value) => {
          this.selectPage = undefined;
          this.candidateIndex = candidateIndex;
          const runWith = field === "runWith" ? runWithChoice(value) : undefined;
          if (runWith && runWith.runtime !== candidate.runtime && runWith.runtime !== "pi") {
            this.openModelPicker(candidate, { nativeSwitch: runWith });
            return;
          }
          if (runWith && update.candidate && update.candidate.runtime !== candidate.runtime) {
            this.openModelPicker(update.candidate, {
              preferAdvertisedDefault: true,
              priorNotices: update.notices,
            });
            return;
          }
          this.applyCandidateUpdate(update);
        },
        cancel: () => this.closeSelectPage(),
      }),
    );
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
        const current = picker.choices.find((option) => option.selector === candidate.model);
        this.candidateIndex = candidateIndex;
        this.showFieldPicker(
          candidate,
          field,
          fastMode ? undefined : current?.supportedEfforts,
          fastMode
            ? (current?.fastModeAvailable ??
                candidateFastModeAvailable(candidate, this.options.parentModel))
            : undefined,
          picker.warning,
        );
      })
      .catch((error) => {
        if (!this.finishCatalogLoad(controller)) return;
        this.notice(
          "error",
          error instanceof Error
            ? error.message
            : fastMode
              ? "Could not check fast mode."
              : "Could not load reasoning levels.",
        );
      });
  }

  protected openModelPicker(candidate: ProfileCandidate, opening: ModelPickerOpening = {}): void {
    const { nativeSwitch, priorNotices = [] } = opening;
    const candidateIndex = this.addingCandidate
      ? this.draft().candidates.length
      : this.candidateIndex;
    const controller = this.beginCatalogLoad(
      this.addingCandidate ? "Choose a model for the new fallback…" : "Loading models…",
    );
    void this.options
      .loadModelPicker(
        this.profile(),
        candidateIndex,
        nativeSwitch ? { ...candidate, ...nativeSwitch } : candidate,
        controller.signal,
        nativeSwitch !== undefined,
      )
      .then((picker) => {
        if (!this.finishCatalogLoad(controller)) return;
        if (picker.choices.length === 0) {
          this.addingCandidate = false;
          this.notice("warning", picker.warning ?? "No models are available for this selection.");
          return;
        }
        this.modelPicker = makeProfileModelPickerPage({
          ...selectHost(this.options),
          choices: picker.choices,
          scopedChoices: picker.scopedChoices,
          initialSelection:
            opening.preferAdvertisedDefault || nativeSwitch
              ? (picker.defaultSelector ?? picker.current)
              : picker.current,
          context: picker.context,
          targetLabel: shortTargetLabel(this.options.target),
          notice: picker.warning,
          select: (option) => {
            this.modelPicker = undefined;
            if (!this.addingCandidate) this.candidateIndex = candidateIndex;
            // Runtime and model commit together, so a native switch applies only on selection.
            const switched = nativeSwitch
              ? updateCandidateControls(candidate, nativeSwitch, {
                  nativeModel: option.selector,
                })
              : { candidate, notices: [] };
            if (!switched.candidate) {
              this.applyCandidateUpdate(switched);
              return;
            }
            const update = updateCandidateModel(
              switched.candidate,
              option.selector,
              option.supportedEfforts,
              option.fastModeAvailable,
            );
            this.applyCandidateUpdate({
              ...update,
              notices: [...priorNotices, ...switched.notices, ...update.notices],
            });
          },
          cancel: () => {
            this.modelPicker = undefined;
            this.addingCandidate = false;
            this.message = undefined;
            this.renderSoon();
          },
        });
        this.modelPicker.focused = this._focused;
        this.renderSoon();
      })
      .catch((error) => {
        if (!this.finishCatalogLoad(controller)) return;
        this.addingCandidate = false;
        this.notice("error", error instanceof Error ? error.message : "Could not load models.");
      });
  }

  protected openProfileSearch(): void {
    this.showSelectPage(
      makeProfileSearchSelector({
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
