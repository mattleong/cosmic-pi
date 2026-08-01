// Profile settings are a Promise-shaped Pi host UI boundary.
// @effect-diagnostics effect/asyncFunction:off
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  type Component,
  type KeyId,
} from "@earendil-works/pi-tui";
import { MAX_PROFILE_CANDIDATES } from "../../config/schema.ts";
import type { SubagentConfigInspection, SubagentConfigScope } from "../../config/store.ts";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../../profiles/model.ts";
import type { SubagentEffort } from "../../run/model.ts";
import {
  declaredRouteForDraft,
  inheritProjectDraft,
  loadProfileRouteDraft,
  replaceRouteCandidate,
  resetGlobalDraft,
  type CandidateUpdate,
  type ProfileRouteDraft,
} from "../profile-route-editor.ts";
import {
  updateCandidateFromModelChoice,
  type CandidateModelPickerData,
} from "./candidate-editor.ts";
import { ProfileModelPickerPage } from "./model-picker.ts";
import {
  PROFILE_WORKSPACE_FIELDS,
  candidateFieldRows,
  draftKindLabel,
  profileRouteDraftSummary,
  type ProfileWorkspaceField,
  type ProfileWorkspacePane,
} from "./profile-workspace-model.ts";
import {
  applyProfileWorkspaceDraftAction,
  profileWorkspaceConfirmation,
  type ProfileWorkspaceDraftAction,
} from "./profile-workspace-actions.ts";
import { renderProfileWorkspace } from "./profile-workspace-render.ts";
import {
  makeCandidateFieldSelector,
  makeProfileSearchSelector,
} from "./profile-workspace-selectors.ts";
import { SearchableSelectPage, type SettingsSelectKeybindingId } from "./searchable-select-page.ts";

export type ProfileWorkspaceSaveResult =
  | { readonly inspection: SubagentConfigInspection }
  | { readonly refreshError: string };

export interface ProfileWorkspaceOptions {
  readonly theme: Theme;
  readonly inspection: SubagentConfigInspection;
  readonly projectTrusted: boolean;
  readonly piModel?: string | undefined;
  readonly parentModel?: string | undefined;
  readonly parentEffort: SubagentEffort;
  readonly getHeight: () => number;
  readonly requestRender: () => void;
  readonly matchesKeybinding?:
    | ((data: string, id: SettingsSelectKeybindingId) => boolean)
    | undefined;
  readonly keybindingLabel?:
    | ((id: SettingsSelectKeybindingId, fallback: string) => string)
    | undefined;
  readonly close: (reloadRequired: boolean) => void;
  readonly saveDraft: (
    scope: SubagentConfigScope,
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
  readonly reload: () => Promise<boolean>;
}

type PendingAction = "remove" | "disable" | "reset";
type WorkspaceMessage = {
  readonly kind: "info" | "success" | "warning" | "error";
  readonly text: string;
};

const paneOrder: ReadonlyArray<ProfileWorkspacePane> = ["profiles", "candidates", "fields"];
const confirmationKey = (action: PendingAction): string =>
  action === "remove" ? "x" : action === "disable" ? "d" : "i";
const saveScopeLabel = (scope: SubagentConfigScope): string =>
  scope === "global" ? "globally" : "to project";

const sameCandidate = (left: ProfileCandidate, right: ProfileCandidate): boolean =>
  left.host === right.host &&
  left.runtime === right.runtime &&
  left.model === right.model &&
  left.effort === right.effort &&
  left.context === right.context &&
  left.writeIntent === right.writeIntent &&
  left.fastMode === right.fastMode &&
  left.closeOnReport === right.closeOnReport;

export class ProfileWorkspaceComponent implements Component {
  private inspection: SubagentConfigInspection;
  private scope: SubagentConfigScope;
  private pane: ProfileWorkspacePane = "profiles";
  private profileIndex: number;
  private candidateIndex = 0;
  private fieldIndex = 0;
  private optimisticDraft: ProfileRouteDraft | undefined;
  private optimisticProfile: ProfileId | undefined;
  private optimisticScope: SubagentConfigScope | undefined;
  private busy = false;
  private refreshBlocked = false;
  private reloadRequired = false;
  private message: WorkspaceMessage | undefined;
  private pendingAction: PendingAction | undefined;
  private catalogLoad: AbortController | undefined;
  private modelPicker: ProfileModelPickerPage | undefined;
  private selectPage: SearchableSelectPage<string> | undefined;
  private readonly options: ProfileWorkspaceOptions;

  constructor(options: ProfileWorkspaceOptions) {
    this.options = options;
    this.inspection = options.inspection;
    this.scope = "global";
    this.profileIndex = PROFILE_IDS.indexOf("generalist");
    this.reconcile();
  }

  private profile(): ProfileId {
    return PROFILE_IDS[this.profileIndex] ?? PROFILE_IDS[0];
  }

  private draft(): ProfileRouteDraft {
    const profile = this.profile();
    return this.optimisticDraft &&
      this.optimisticProfile === profile &&
      this.optimisticScope === this.scope
      ? this.optimisticDraft
      : loadProfileRouteDraft(this.inspection, this.scope, profile);
  }

  private reconcile(): void {
    this.profileIndex = Math.max(0, Math.min(PROFILE_IDS.length - 1, this.profileIndex));
    const candidates = this.draft().candidates;
    this.candidateIndex = Math.max(
      0,
      Math.min(Math.max(0, candidates.length - 1), this.candidateIndex),
    );
    this.fieldIndex = Math.max(0, Math.min(PROFILE_WORKSPACE_FIELDS.length - 1, this.fieldIndex));
  }

  private renderSoon(): void {
    this.reconcile();
    this.options.requestRender();
  }

  private setMessage(kind: WorkspaceMessage["kind"], text: string): void {
    this.message = { kind, text };
  }

  private clearMessage(): void {
    this.message = undefined;
  }

  private printableKey(data: string): string | undefined {
    return data.length === 1 ? data : decodeKittyPrintable(data);
  }

  private projectOverrideActive(profile = this.profile()): boolean {
    const project = this.inspection.project;
    return Boolean(
      project &&
      (project.invalidProfileRoutes.includes(profile) ||
        Object.prototype.hasOwnProperty.call(project.file.profiles ?? {}, profile)),
    );
  }

  private selectProfile(offset: number): void {
    this.profileIndex = Math.max(0, Math.min(PROFILE_IDS.length - 1, this.profileIndex + offset));
    this.candidateIndex = 0;
    this.fieldIndex = 0;
    this.pendingAction = undefined;
    this.clearMessage();
  }

  private selectCandidate(offset: number): void {
    const length = this.draft().candidates.length;
    this.candidateIndex = Math.max(
      0,
      Math.min(Math.max(0, length - 1), this.candidateIndex + offset),
    );
    this.fieldIndex = 0;
    this.pendingAction = undefined;
    this.clearMessage();
  }

  private selectField(offset: number): void {
    this.fieldIndex += offset;
    this.pendingAction = undefined;
    this.clearMessage();
  }

  private navigate(direction: -1 | 1): void {
    if (direction === 1 && this.pane === "candidates" && this.draft().candidates.length === 0) {
      this.setMessage("info", "Add a candidate before opening candidate details.");
      return;
    }
    const current = paneOrder.indexOf(this.pane);
    const next = Math.max(0, Math.min(paneOrder.length - 1, current + direction));
    this.pane = paneOrder[next] ?? "profiles";
    this.pendingAction = undefined;
    this.clearMessage();
  }

  private changeScope(scope: SubagentConfigScope): void {
    if (scope === "project" && !this.options.projectTrusted) {
      this.setMessage("warning", "Project profile settings require a trusted project.");
      return;
    }
    this.scope = scope;
    this.candidateIndex = 0;
    this.fieldIndex = 0;
    this.pendingAction = undefined;
    if (this.pane === "fields" && this.draft().candidates.length === 0) this.pane = "candidates";
    this.setMessage(
      "info",
      scope === "global"
        ? "Global scope overrides built-in profile defaults."
        : "Project scope overrides global profile settings.",
    );
  }

  private persist(
    next: ProfileRouteDraft,
    description: string,
    preferredCandidateIndex = this.candidateIndex,
  ): void {
    if (this.busy) return;
    if (this.refreshBlocked) {
      this.setMessage(
        "error",
        "Profile state could not be safely refreshed. Reopen /subagents profiles before editing again.",
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
    const scope = this.scope;
    const profile = this.profile();
    this.optimisticDraft = next;
    this.optimisticProfile = profile;
    this.optimisticScope = scope;
    this.candidateIndex = preferredCandidateIndex;
    this.busy = true;
    this.pendingAction = undefined;
    this.setMessage("info", `Saving ${saveScopeLabel(scope)} · ${profile} · ${description}`);
    this.renderSoon();
    void this.options
      .saveDraft(scope, profile, next)
      .then((result) => {
        this.busy = false;
        this.reloadRequired = true;
        this.candidateIndex = preferredCandidateIndex;
        if ("refreshError" in result) {
          this.refreshBlocked = true;
          this.setMessage("error", result.refreshError);
        } else {
          this.inspection = result.inspection;
          this.optimisticDraft = undefined;
          this.optimisticProfile = undefined;
          this.optimisticScope = undefined;
          this.setMessage(
            "success",
            `Saved ${saveScopeLabel(scope)} · ${profile} · ${description}`,
          );
        }
        this.renderSoon();
      })
      .catch((error: unknown) => {
        this.optimisticDraft = undefined;
        this.optimisticProfile = undefined;
        this.optimisticScope = undefined;
        this.busy = false;
        this.refreshBlocked = true;
        const message = error instanceof Error ? error.message : "Could not save profile settings.";
        this.setMessage("error", `${message} Reopen /subagents profiles before editing again.`);
        this.renderSoon();
      });
  }

  private applyCandidateUpdate(update: CandidateUpdate | undefined, description: string): void {
    if (!update) return;
    if (update.error || !update.candidate) {
      this.setMessage("warning", update.error ?? "Candidate update was rejected.");
      this.renderSoon();
      return;
    }
    const current = this.draft().candidates[this.candidateIndex];
    if (current && sameCandidate(current, update.candidate)) {
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

  private openFieldPicker(): void {
    const candidate = this.draft().candidates[this.candidateIndex];
    const field = PROFILE_WORKSPACE_FIELDS[this.fieldIndex];
    if (!candidate || !field || this.busy) return;
    const row = candidateFieldRows(
      candidate,
      this.profile(),
      this.options.parentEffort,
      this.options.parentModel,
    )[this.fieldIndex];
    if (row?.fixed) {
      this.setMessage(
        "info",
        row.fixedReason ?? `${row.label} is fixed by the current host/runtime policy.`,
      );
      this.renderSoon();
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
    if (field === "fastMode") {
      this.openFastModePicker(candidate);
      return;
    }
    this.showFieldPicker(
      candidate,
      field,
      candidate.runtime === "pi" ? this.options.supportedPiEfforts(candidate) : undefined,
    );
  }

  private showFieldPicker(
    candidate: ProfileCandidate,
    field: Exclude<ProfileWorkspaceField, "model">,
    supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined,
    fastModeAvailable?: boolean | undefined,
    notice?: string | undefined,
  ): void {
    const candidateIndex = this.candidateIndex;
    this.selectPage = makeCandidateFieldSelector({
      theme: this.options.theme,
      profile: this.profile(),
      candidateIndex,
      candidate,
      field,
      fieldIndex: this.fieldIndex,
      piModel: this.options.piModel,
      parentModel: this.options.parentModel,
      parentEffort: this.options.parentEffort,
      supportedEfforts,
      fastModeAvailable,
      ...(notice ? { notice } : {}),
      getHeight: this.options.getHeight,
      requestRender: this.options.requestRender,
      matchesKeybinding: this.options.matchesKeybinding,
      keybindingLabel: this.options.keybindingLabel,
      select: (update, description) => {
        this.selectPage = undefined;
        this.candidateIndex = candidateIndex;
        if (
          field === "runtime" &&
          update.candidate &&
          update.candidate.runtime !== candidate.runtime &&
          update.candidate.runtime !== "pi"
        ) {
          this.openModelPicker(update.candidate, true, "Runtime and model updated", update.notices);
          return;
        }
        this.applyCandidateUpdate(update, description);
      },
      cancel: (label) => {
        this.selectPage = undefined;
        this.setMessage("info", `${label} selection canceled.`);
        this.renderSoon();
      },
    });
    this.renderSoon();
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
    if (this.catalogLoad !== controller) return false;
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
    this.setMessage("info", "Model catalog loading canceled.");
    this.renderSoon();
  }

  private openFastModePicker(candidate: ProfileCandidate): void {
    const candidateIndex = this.candidateIndex;
    const controller = this.beginCatalogLoad("Checking fast-mode availability…");
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
          "fastMode",
          undefined,
          current?.fastModeAvailable ?? this.options.fastModeAvailable(candidate),
          picker.warning,
        );
      })
      .catch((error: unknown) => {
        if (!this.finishCatalogLoad(controller)) return;
        this.setMessage(
          "error",
          error instanceof Error ? error.message : "Fast-mode discovery failed.",
        );
        this.renderSoon();
      });
  }

  private openNativeEffortPicker(candidate: ProfileCandidate): void {
    const candidateIndex = this.candidateIndex;
    const controller = this.beginCatalogLoad("Loading model effort choices…");
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
      .catch((error: unknown) => {
        if (!this.finishCatalogLoad(controller)) return;
        this.setMessage(
          "error",
          error instanceof Error ? error.message : "Effort discovery failed.",
        );
        this.renderSoon();
      });
  }

  private openModelPicker(
    candidate: ProfileCandidate,
    preferAdvertisedDefault = false,
    description = "Model updated",
    priorNotices: ReadonlyArray<string> = [],
  ): void {
    const candidateIndex = this.candidateIndex;
    const controller = this.beginCatalogLoad("Loading model choices…");
    void this.options
      .loadModelPicker(this.profile(), candidateIndex, candidate, controller.signal)
      .then((picker) => {
        if (!this.finishCatalogLoad(controller)) return;
        if (picker.choices.length === 0) {
          this.setMessage("warning", picker.warning ?? "No models are available for this runtime.");
          this.renderSoon();
          return;
        }
        this.modelPicker = new ProfileModelPickerPage({
          theme: this.options.theme,
          choices: picker.choices,
          current: preferAdvertisedDefault
            ? (picker.defaultSelector ?? picker.current)
            : picker.current,
          context: picker.context,
          getHeight: this.options.getHeight,
          requestRender: this.options.requestRender,
          matchesKeybinding: this.options.matchesKeybinding,
          keybindingLabel: this.options.keybindingLabel,
          ...(picker.warning ? { notice: picker.warning } : {}),
          select: (choice) => {
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
                ? "Runtime change canceled because no model was selected."
                : "Model selection canceled.",
            );
            this.renderSoon();
          },
        });
        this.renderSoon();
      })
      .catch((error: unknown) => {
        if (!this.finishCatalogLoad(controller)) return;
        this.setMessage("error", error instanceof Error ? error.message : "Model picker failed.");
        this.renderSoon();
      });
  }

  private openProfileSearch(initialQuery = ""): void {
    this.selectPage = makeProfileSearchSelector({
      theme: this.options.theme,
      inspection: this.inspection,
      current: this.profile(),
      parentEffort: this.options.parentEffort,
      parentModel: this.options.parentModel,
      ...(initialQuery ? { initialQuery } : {}),
      getHeight: this.options.getHeight,
      requestRender: this.options.requestRender,
      matchesKeybinding: this.options.matchesKeybinding,
      keybindingLabel: this.options.keybindingLabel,
      select: (profile) => {
        this.selectPage = undefined;
        this.profileIndex = PROFILE_IDS.indexOf(profile);
        this.candidateIndex = 0;
        this.fieldIndex = 0;
        this.pane = "candidates";
        this.setMessage("info", `Opened ${profile} route.`);
        this.renderSoon();
      },
      cancel: () => {
        this.selectPage = undefined;
        this.setMessage("info", "Profile search canceled.");
        this.renderSoon();
      },
    });
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
    });
    if ("error" in result) {
      this.setMessage("warning", result.error);
      this.renderSoon();
    } else if ("unchanged" in result) {
      this.pendingAction = undefined;
      this.setMessage("info", "No profile change was needed.");
      this.renderSoon();
    } else this.persist(result.draft, result.description, result.candidateIndex);
  }

  private arm(action: PendingAction): void {
    if (this.busy) return;
    const draft = this.draft();
    if (
      (action === "disable" && draft.kind === "disabled") ||
      (action === "reset" &&
        ((this.scope === "global" && draft.kind === "reset") ||
          (this.scope === "project" && draft.kind === "inherit")))
    ) {
      this.setMessage("info", "No profile change was needed.");
      this.renderSoon();
      return;
    }
    this.pendingAction = action;
    this.renderSoon();
  }

  private confirmPending(): void {
    if (this.pendingAction) this.performDraftAction(this.pendingAction);
  }

  private requestReload(): void {
    if (this.busy || !this.reloadRequired) return;
    this.busy = true;
    this.setMessage("info", "Reload requested…");
    this.renderSoon();
    void this.options
      .reload()
      .then((reloaded) => {
        this.busy = false;
        if (reloaded) {
          this.reloadRequired = false;
          this.options.close(false);
          return;
        }
        this.setMessage("info", "Reload canceled; saved changes remain pending.");
        this.renderSoon();
      })
      .catch((error: unknown) => {
        this.busy = false;
        this.setMessage("error", error instanceof Error ? error.message : "Reload failed.");
        this.renderSoon();
      });
  }

  private back(): void {
    if (this.pane === "fields") {
      this.pane = "candidates";
      this.clearMessage();
    } else if (this.pane === "candidates") {
      this.pane = "profiles";
      this.clearMessage();
    } else this.options.close(this.reloadRequired);
    this.pendingAction = undefined;
  }

  private forward(): void {
    if (this.pane === "profiles") {
      this.pane = "candidates";
      this.clearMessage();
    } else if (this.pane === "candidates") {
      if (this.draft().candidates.length > 0) {
        this.pane = "fields";
        this.clearMessage();
      } else this.setMessage("info", "Add a candidate before opening candidate details.");
    } else this.openFieldPicker();
  }

  private matches(data: string, key: KeyId, id: SettingsSelectKeybindingId): boolean {
    return this.options.matchesKeybinding
      ? this.options.matchesKeybinding(data, id)
      : matchesKey(data, key);
  }

  handleInput(data: string): void {
    if (this.modelPicker) {
      this.modelPicker.handleInput(data);
      return;
    }
    if (this.selectPage) {
      this.selectPage.handleInput(data);
      return;
    }

    if (this.matches(data, Key.escape, "tui.select.cancel")) {
      if (this.pendingAction) {
        this.pendingAction = undefined;
        this.renderSoon();
      } else if (this.catalogLoad) this.cancelCatalogLoad();
      else if (this.busy) {
        this.setMessage("warning", "Wait for the current settings operation to finish.");
        this.renderSoon();
      } else this.back();
      return;
    }

    if (this.busy) {
      this.setMessage("warning", "Wait for the current settings operation to finish.");
      this.renderSoon();
      return;
    }

    const printable = this.printableKey(data);

    if (this.pendingAction) {
      if (printable === confirmationKey(this.pendingAction)) this.confirmPending();
      else {
        this.pendingAction = undefined;
        this.setMessage("info", "Confirmation canceled.");
        this.renderSoon();
      }
      return;
    }

    if (matchesKey(data, Key.tab)) this.navigate(1);
    else if (matchesKey(data, Key.shift("tab"))) this.navigate(-1);
    else if (
      this.matches(data, Key.pageUp, "tui.select.pageUp") ||
      this.matches(data, Key.pageDown, "tui.select.pageDown")
    ) {
      const direction = this.matches(data, Key.pageUp, "tui.select.pageUp") ? -1 : 1;
      const step = Math.max(1, this.options.getHeight() - 10);
      if (this.pane === "profiles") this.selectProfile(direction * step);
      else if (this.pane === "candidates") this.selectCandidate(direction * step);
      else this.selectField(direction * step);
    } else if (matchesKey(data, Key.home)) {
      if (this.pane === "profiles") this.profileIndex = 0;
      else if (this.pane === "candidates") this.candidateIndex = 0;
      else this.fieldIndex = 0;
      this.pendingAction = undefined;
      this.clearMessage();
    } else if (matchesKey(data, Key.end)) {
      if (this.pane === "profiles") this.profileIndex = PROFILE_IDS.length - 1;
      else if (this.pane === "candidates")
        this.candidateIndex = Math.max(0, this.draft().candidates.length - 1);
      else this.fieldIndex = PROFILE_WORKSPACE_FIELDS.length - 1;
      this.pendingAction = undefined;
      this.clearMessage();
    } else if (this.matches(data, Key.up, "tui.select.up") || printable === "k") {
      if (this.pane === "profiles") this.selectProfile(-1);
      else if (this.pane === "candidates") this.selectCandidate(-1);
      else this.selectField(-1);
    } else if (this.matches(data, Key.down, "tui.select.down") || printable === "j") {
      if (this.pane === "profiles") this.selectProfile(1);
      else if (this.pane === "candidates") this.selectCandidate(1);
      else this.selectField(1);
    } else if (matchesKey(data, Key.left)) {
      if (this.pane !== "profiles") this.back();
    } else if (matchesKey(data, Key.right) || this.matches(data, Key.enter, "tui.select.confirm"))
      this.forward();
    else if (printable === "/" && this.pane === "profiles") this.openProfileSearch();
    else if (printable === "g") this.changeScope("global");
    else if (printable === "p") this.changeScope("project");
    else if (
      printable === "a" &&
      this.pane === "candidates" &&
      this.draft().candidates.length < MAX_PROFILE_CANDIDATES
    )
      this.performDraftAction("add");
    else if (
      printable === "c" &&
      this.pane === "candidates" &&
      this.draft().candidates.length > 0 &&
      this.draft().candidates.length < MAX_PROFILE_CANDIDATES
    )
      this.performDraftAction("clone");
    else if (printable === "K" && this.pane === "candidates" && this.candidateIndex > 0)
      this.performDraftAction("move-up");
    else if (
      printable === "J" &&
      this.pane === "candidates" &&
      this.candidateIndex < this.draft().candidates.length - 1
    )
      this.performDraftAction("move-down");
    else if (printable === "x" && this.pane === "candidates" && this.draft().candidates.length > 0)
      this.arm("remove");
    else if (printable === "d" && this.pane === "candidates") this.arm("disable");
    else if (printable === "i" && this.pane !== "fields") this.arm("reset");
    else if (printable === "r") this.requestReload();
    this.renderSoon();
  }

  render(width: number): string[] {
    if (this.modelPicker) return this.modelPicker.render(width);
    if (this.selectPage) return this.selectPage.render(width);
    this.reconcile();
    const profile = this.profile();
    const draft = this.draft();
    const resetDraft =
      this.scope === "global"
        ? resetGlobalDraft(profile)
        : inheritProjectDraft(this.inspection, profile);
    const resetCurrent = `${draftKindLabel(draft, this.scope)} · ${profileRouteDraftSummary(profile, draft, this.options.parentEffort, this.options.parentModel)}`;
    const resetAfter = `${this.scope === "global" ? "[B] built-in" : "inherits [G] global / [B] built-in"} · ${profileRouteDraftSummary(profile, resetDraft, this.options.parentEffort, this.options.parentModel)}`;
    return renderProfileWorkspace(
      {
        inspection: this.inspection,
        scope: this.scope,
        projectTrusted: this.options.projectTrusted,
        parentEffort: this.options.parentEffort,
        parentModel: this.options.parentModel,
        pane: this.pane,
        profileIndex: this.profileIndex,
        candidateIndex: this.candidateIndex,
        fieldIndex: this.fieldIndex,
        draft,
        busy: this.busy,
        cancellableBusy: this.catalogLoad !== undefined,
        reloadRequired: this.reloadRequired,
        message: this.message,
        pendingConfirmation: this.pendingAction
          ? profileWorkspaceConfirmation({
              action: this.pendingAction,
              profile,
              candidateIndex: this.candidateIndex,
              candidateCount: draft.candidates.length,
              scope: this.scope,
              projectOverrideActive: this.scope === "global" && this.projectOverrideActive(),
              ...(this.pendingAction === "reset"
                ? { currentSummary: resetCurrent, afterSummary: resetAfter }
                : {}),
            })
          : undefined,
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
    this.modelPicker?.invalidate();
    this.selectPage?.invalidate();
  }

  dispose(): void {
    this.catalogLoad?.abort();
    this.catalogLoad = undefined;
  }
}
