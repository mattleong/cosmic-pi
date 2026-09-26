import { FullScreenKeymap } from "pi-cosmic-ui/manager/keymap";
import type { SearchableSelectPage } from "pi-cosmic-ui/manager/searchable-select";
import {
  PROFILE_IDS,
  sameProfileCandidate,
  type ProfileCandidate,
  type ProfileId,
} from "../profiles/model.ts";
import {
  loadProfileRouteDraft,
  profileWorkspaceScope,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileSettingsScope,
} from "./profile-route-editor.ts";
import type { ProfileWorkspaceOptions } from "./profile-workspace.ts";
import type { makeProfileModelPickerPage } from "./ui/model-picker.ts";
import type { ProfileWorkspaceField } from "./ui/profile-workspace-model.ts";
import { profileWorkspaceRows } from "./ui/profile-workspace-rows.ts";
import { ProfileEditVisit } from "./profile-edit-visit.ts";
import { isWorkspaceNavigationKey } from "./ui/profile-workspace-keys.ts";

type Selection = {
  control: ProfileWorkspaceField | undefined;
  candidateIndex: number;
  fields: Map<number, ProfileWorkspaceField>;
  expanded: Set<number>;
};
export interface ProfileWorkspaceSelectionMemory {
  readonly profile: ProfileId;
  readonly control?: ProfileWorkspaceField | undefined;
  readonly candidateIndex: number;
  readonly fields: ReadonlyArray<readonly [number, ProfileWorkspaceField]>;
  readonly expanded: ReadonlyArray<number>;
}
export type WorkspaceMessage = {
  readonly kind: "info" | "success" | "warning" | "error";
  readonly text: string;
};

export interface ModelPickerOpening {
  /** Start on the runtime's advertised default instead of the configured model. */
  readonly preferAdvertisedDefault?: boolean | undefined;
  readonly priorNotices?: ReadonlyArray<string> | undefined;
  /** Claude or Codex route that takes its model from this picker's live catalog. */
  readonly nativeSwitch?: Pick<ProfileCandidate, "host" | "runtime"> | undefined;
}

/** The fixed-target editor's synchronous state. The dashboard owns its lifetime. */
export abstract class ProfileWorkspaceState {
  protected inspection: ProfileSettingsInspection;
  protected readonly scope: ProfileSettingsScope;
  protected pane: "profiles" | "fields" = "profiles";
  protected saveFocused = false;
  protected profileIndex: number;
  protected candidateIndex = 0;
  protected fieldIndex = 0;
  protected addingCandidate = false;
  protected readonly selections = new Map<ProfileId, Selection>();
  protected optimisticDraft: ProfileRouteDraft | undefined;
  protected optimisticProfile: ProfileId | undefined;
  protected busy = false;
  protected refreshBlocked = false;
  protected message: WorkspaceMessage | undefined;
  protected pendingAction: "remove" | "reset" | undefined;
  protected helpOpen = false;
  protected helpScroll = 0;
  protected helpMaximum = 0;
  protected catalogLoad: AbortController | undefined;
  protected modelPicker: ReturnType<typeof makeProfileModelPickerPage> | undefined;
  protected selectPage: SearchableSelectPage<string> | undefined;
  protected _focused = false;
  protected disposed = false;
  protected readonly keymap = new FullScreenKeymap();
  protected readonly options: ProfileWorkspaceOptions;
  protected readonly editVisit: ProfileEditVisit;

  constructor(options: ProfileWorkspaceOptions) {
    this.options = {
      ...options,
      matchesKeybinding: (data, id) =>
        !isWorkspaceNavigationKey(data) && (options.matchesKeybinding?.(data, id) ?? false),
    };
    this.inspection = options.inspection;
    this.editVisit = options.editVisit ?? new ProfileEditVisit(options.inspection);
    this.scope = profileWorkspaceScope(options.target);
    this.saveFocused = options.target.kind === "session" && options.initialSaveFocused === true;
    for (const saved of options.initialSelections ?? []) {
      this.selections.set(saved.profile, {
        control: saved.control,
        candidateIndex: saved.candidateIndex,
        fields: new Map(saved.fields),
        expanded: new Set(saved.expanded),
      });
    }
    this.profileIndex = Math.max(0, PROFILE_IDS.indexOf(options.initialProfile ?? PROFILE_IDS[0]));
    this.candidateIndex = options.initialCandidateIndex ?? 0;
    this.pane = options.initialFocus ?? "profiles";
    this.advancedExpanded = options.initialAdvancedExpanded ?? false;
    this.reconcile();
    this.selectField(options.initialField ?? "model");
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
  get isBusy(): boolean {
    return this.busy;
  }
  get hasOverlay(): boolean {
    return Boolean(
      this.modelPicker ||
      this.selectPage ||
      this.pendingAction ||
      this.helpOpen ||
      this.catalogLoad,
    );
  }
  getPosition() {
    this.rememberSelection();
    const initialSelections: ReadonlyArray<ProfileWorkspaceSelectionMemory> = Array.from(
      this.selections,
      ([profile, selection]) => ({
        profile,
        control: selection.control,
        candidateIndex: selection.candidateIndex,
        fields: Array.from(selection.fields, ([index, field]) => [index, field] as const),
        expanded: Array.from(selection.expanded),
      }),
    );
    return {
      initialSelections,
      initialSaveFocused: this.saveFocused,
      initialProfile: this.profile(),
      initialCandidateIndex: this.candidateIndex,
      initialField: this.rows()[this.fieldIndex]?.field ?? "model",
      initialFocus: this.pane,
      initialAdvancedExpanded: this.advancedExpanded,
    };
  }
  updateInspection(inspection: ProfileSettingsInspection): void {
    if (this.disposed || this.inspection === inspection) return;
    const field = this.rows()[this.fieldIndex]?.field ?? "model";
    const previous = this.draft();
    const selected = previous.candidates[this.candidateIndex];
    const next = loadProfileRouteDraft(inspection, this.options.target, this.profile());
    this.remapSelection(previous, next);
    const moved = selected
      ? next.candidates.findIndex((candidate) => sameProfileCandidate(candidate, selected))
      : -1;
    if (moved >= 0) this.candidateIndex = moved;
    this.editVisit.reconcile(inspection);
    this.inspection = inspection;
    // Hidden editors cannot keep a picker continuation based on a replaced route.
    this.catalogLoad?.abort();
    if (this.catalogLoad) this.busy = false;
    this.catalogLoad = undefined;
    this.modelPicker = undefined;
    this.selectPage = undefined;
    this.addingCandidate = false;
    this.pendingAction = undefined;
    this.reconcile();
    this.selectField(field);
  }
  protected profile(): ProfileId {
    return PROFILE_IDS[this.profileIndex] ?? PROFILE_IDS[0];
  }
  protected draft(): ProfileRouteDraft {
    if (this.optimisticDraft && this.optimisticProfile === this.profile())
      return this.optimisticDraft;
    return loadProfileRouteDraft(this.inspection, this.options.target, this.profile());
  }
  protected selection(): Selection {
    let selection = this.selections.get(this.profile());
    if (!selection) {
      selection = { control: undefined, candidateIndex: 0, fields: new Map(), expanded: new Set() };
      this.selections.set(this.profile(), selection);
    }
    return selection;
  }
  protected get advancedExpanded(): boolean {
    return this.selection().expanded.has(this.candidateIndex);
  }
  protected set advancedExpanded(value: boolean) {
    if (value) this.selection().expanded.add(this.candidateIndex);
    else this.selection().expanded.delete(this.candidateIndex);
  }
  protected rows() {
    return profileWorkspaceRows(
      this.draft(),
      this.profile(),
      this.options.parentEffort,
      this.options.parentModel,
      this.selection().expanded,
    );
  }
  protected reconcile(): void {
    this.profileIndex = Math.max(0, Math.min(PROFILE_IDS.length - 1, this.profileIndex));
    this.candidateIndex = Math.max(
      0,
      Math.min(Math.max(0, this.draft().candidates.length - 1), this.candidateIndex),
    );
    this.fieldIndex = Math.max(0, Math.min(this.rows().length - 1, this.fieldIndex));
  }
  protected renderSoon(): void {
    if (this.disposed) return;
    this.reconcile();
    this.options.requestRender();
  }
  protected setMessage(kind: WorkspaceMessage["kind"], text: string): void {
    this.message = { kind, text };
  }
  protected rememberSelection(): void {
    const row = this.rows()[this.fieldIndex];
    const selection = this.selection();
    selection.candidateIndex = this.candidateIndex;
    if (row?.scope === "candidate") {
      selection.fields.set(row.candidateIndex, row.field);
      selection.control = undefined;
    } else if (row) selection.control = row.field;
  }
  protected selectField(field: ProfileWorkspaceField): void {
    if (["context", "openaiFastMode", "closeOnReport"].includes(field))
      this.advancedExpanded = true;
    const rows = this.rows();
    const index = rows.findIndex(
      (row) =>
        row.field === field &&
        (row.scope !== "candidate" || row.candidateIndex === this.candidateIndex),
    );
    this.fieldIndex =
      index >= 0
        ? index
        : Math.max(
            0,
            rows.findIndex((row) => row.candidateIndex === this.candidateIndex),
          );
  }
  protected selectCandidate(index: number): void {
    this.saveFocused = false;
    this.rememberSelection();
    this.candidateIndex = Math.max(0, Math.min(this.draft().candidates.length - 1, index));
    this.selectField(this.selection().fields.get(this.candidateIndex) ?? "model");
  }
  protected selectProfileRow(index: number): void {
    this.rememberSelection();
    const last = PROFILE_IDS.length - (this.options.target.kind === "session" ? 0 : 1);
    const selected = Math.max(0, Math.min(last, index));
    if (selected === PROFILE_IDS.length) {
      this.saveFocused = true;
    } else {
      this.profileIndex = selected;
      this.resetSelectionForProfile();
    }
  }
  protected moveRow(index: number): void {
    this.rememberSelection();
    this.fieldIndex = Math.max(0, Math.min(this.rows().length - 1, index));
    const row = this.rows()[this.fieldIndex];
    if (row?.scope === "candidate") this.candidateIndex = row.candidateIndex;
    this.rememberSelection();
  }
  protected resetSelectionForProfile(): void {
    this.saveFocused = false;
    this.candidateIndex = this.selection().candidateIndex;
    this.reconcile();
    this.selectField(
      this.selection().control ?? this.selection().fields.get(this.candidateIndex) ?? "model",
    );
    this.pendingAction = undefined;
    this.message = undefined;
  }
  protected remapSelection(before: ProfileRouteDraft, after: ProfileRouteDraft): void {
    this.rememberSelection();
    const old = this.selection();
    const fields = new Map<number, ProfileWorkspaceField>();
    const expanded = new Set<number>();
    const used = new Set<number>();
    after.candidates.forEach((candidate, index) => {
      let previous = before.candidates.findIndex(
        (entry, i) => !used.has(i) && sameProfileCandidate(entry, candidate),
      );
      if (previous < 0 && before.candidates.length === after.candidates.length && !used.has(index))
        previous = index;
      if (previous < 0) return;
      used.add(previous);
      const field = old.fields.get(previous);
      if (field) fields.set(index, field);
      if (old.expanded.has(previous)) expanded.add(index);
    });
    old.fields = fields;
    old.expanded = expanded;
  }
  protected abstract openModelPicker(
    candidate: ProfileCandidate,
    opening?: ModelPickerOpening,
  ): void;
}
