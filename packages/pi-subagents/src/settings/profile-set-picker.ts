import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import {
  decodeFullScreenPrintable,
  pageSteps,
  type FullScreenAction,
} from "pi-cosmic-ui/manager/keymap";
import { listDetailMotionFromAction } from "pi-cosmic-ui/manager/list-detail";
import { ListDetailShell } from "pi-cosmic-ui/manager/list-detail-shell";
import type { SubagentConfigScope } from "../config/store.ts";
import type { SubagentEffort } from "../domain/routing.ts";
import { isListMotion, nextListMotionIndex } from "pi-cosmic-ui/manager/list-navigation";
import {
  SCOPE_LABELS,
  type PersistentProfileSetRef,
  type ProfileSettingsInspection,
} from "./profile-route-editor.ts";
import {
  initialProfileSetPickerIndex,
  isSelectableProfileSetEntry,
  profileSetPickerEntries,
  qualifiedProfileSetLabel,
  type ProfileSetPickerEntry,
  type SelectableProfileSetEntry,
} from "./ui/profile-set-picker-model.ts";
import type { DashboardPrompt } from "./ui/profile-dashboard-render.ts";
import { PROFILE_SET_SHORTCUTS, renderProfileSetPicker } from "./ui/profile-set-picker-render.ts";
import { selectChoice } from "./ui/profile-workspace-selectors.ts";
import { withoutNavigationKeys } from "./ui/profile-workspace-keys.ts";
import {
  SearchableSelectPage,
  type SearchableSelectHostOptions,
  type SearchableSelectPageChoice,
  type SearchableSelectPageOptions,
} from "pi-cosmic-ui/manager/searchable-select";

export type ProfileSetPickerAction =
  | { readonly action: "use-current"; readonly target: PersistentProfileSetRef }
  | { readonly action: "edit"; readonly target: PersistentProfileSetRef }
  | { readonly action: "make-default"; readonly target: PersistentProfileSetRef }
  | { readonly action: "clear-scope-default"; readonly scope: SubagentConfigScope }
  | { readonly action: "copy"; readonly source: PersistentProfileSetRef }
  | { readonly action: "rename"; readonly target: PersistentProfileSetRef }
  | { readonly action: "delete"; readonly target: PersistentProfileSetRef }
  | { readonly action: "save-session" };

interface ProfileSetPickerOptions extends Pick<
  SearchableSelectHostOptions,
  "getHeight" | "requestRender" | "matchesKeybinding" | "keybindingLabel"
> {
  readonly theme: Theme;
  /** The whole surface's height, which with the width decides how panes are arranged. */
  readonly getFrameHeight?: (() => number) | undefined;
  readonly inspection: ProfileSettingsInspection;
  readonly projectTrusted: boolean;
  /** The parent's model and reasoning, which inherited candidates run with. */
  readonly parentModel?: string | undefined;
  readonly parentEffort?: SubagentEffort | undefined;
  readonly close: (action: ProfileSetPickerAction | undefined) => void;
}

const menuChoice = (
  payload: ProfileSetPickerAction,
  label: string,
  description: string,
  disabledHint?: string,
): SearchableSelectPageChoice<ProfileSetPickerAction> => ({
  ...selectChoice(payload.action, label, description, payload, `${label} ${description}`),
  ...(disabledHint && { enabled: false, disabledReason: description, disabledHint }),
});

const savedSetMenuChoices = (
  entry: SelectableProfileSetEntry,
): ReadonlyArray<SearchableSelectPageChoice<ProfileSetPickerAction>> => {
  const project = entry.scope === "project";
  const clearDefault = menuChoice(
    { action: "clear-scope-default", scope: entry.scope },
    project ? "Use Global default" : "Use built-in defaults",
    entry.kind === "invalid-default"
      ? entry.description
      : project
        ? "Use Global, then built-in profiles in new sessions"
        : "Use built-in profiles in new sessions without a Project default",
  );
  if (entry.kind === "invalid-default") return [clearDefault];
  const target = entry.ref;
  const makeDefault = menuChoice(
    { action: "make-default", target },
    "Make default for new sessions",
    project
      ? "Use this set in new sessions for this project"
      : "Use this set in new sessions without a Project default",
  );
  return [
    ...(entry.scopeDefault ? [clearDefault] : entry.invalid ? [] : [makeDefault]),
    ...(entry.invalid
      ? []
      : [
          menuChoice({ action: "copy", source: target }, "Copy", "Create a copy of this saved set"),
          menuChoice({ action: "rename", target }, "Rename", "Give this saved set a new name"),
        ]),
    menuChoice(
      { action: "delete", target },
      "Delete",
      entry.scopeDefault
        ? "Stop using this set as the default before deleting it"
        : "Delete this saved set. Current session will not change",
      entry.scopeDefault ? "clear default first" : undefined,
    ),
  ];
};

const savedSetMenuPage = (
  entry: SelectableProfileSetEntry,
  host: Omit<
    SearchableSelectPageOptions<ProfileSetPickerAction>,
    "breadcrumb" | "title" | "subtitle" | "choices"
  >,
): SearchableSelectPage<ProfileSetPickerAction> =>
  new SearchableSelectPage({
    ...host,
    breadcrumb: "Saved profiles › Actions",
    title:
      entry.kind === "set"
        ? `Actions · ${qualifiedProfileSetLabel(entry.ref)}`
        : `${SCOPE_LABELS[entry.scope]} default`,
    subtitle:
      entry.kind === "invalid-default"
        ? entry.description
        : entry.scope === "project"
          ? "New sessions in this project use its default, else Global"
          : "New sessions without a Project default use Global, else built-ins",
    choices: savedSetMenuChoices(entry),
    emptyText: "No matching actions",
  });

/**
 * The Saved profiles tab: saved sets grouped by scope beside a read-only preview of the selected
 * set. The shared shell owns pane focus, the selection, the preview's scrolling, and the panes'
 * arrangement; Enter edits the selected set from either pane.
 */
export class ProfileSetPickerComponent implements Component, Focusable {
  private allEntries: ReadonlyArray<ProfileSetPickerEntry>;
  private query = "";
  private searching = false;
  private hintsExpanded = false;
  // The preview opens at its first line whenever it shows another set.
  private previewAtTop = true;
  private menu: SearchableSelectPage<ProfileSetPickerAction> | undefined;
  private message:
    | { readonly kind: "info" | "warning" | "error"; readonly text: string }
    | undefined;
  private readonly shell = new ListDetailShell();
  private options: ProfileSetPickerOptions;
  private disposed = false;
  private focusState = false;

  constructor(options: ProfileSetPickerOptions) {
    this.options = {
      ...options,
      matchesKeybinding: withoutNavigationKeys(options.matchesKeybinding),
    };
    this.allEntries = profileSetPickerEntries(options.inspection, options.projectTrusted);
    this.reset();
  }

  get focused(): boolean {
    return this.focusState;
  }

  set focused(value: boolean) {
    this.focusState = value;
    if (this.menu) this.menu.focused = value;
  }

  get hasOverlay(): boolean {
    return this.menu !== undefined || this.searching;
  }

  /** A transient message for the host's status row. */
  get status() {
    return this.message;
  }

  dismissStatus(): void {
    this.message = undefined;
  }

  updateInspection(inspection: ProfileSettingsInspection, projectTrusted: boolean): void {
    if (this.disposed) return;
    this.options = { ...this.options, inspection, projectTrusted };
    this.allEntries = profileSetPickerEntries(inspection, projectTrusted);
    if (this.shell.reconcile(this.ids()).changed) this.previewAtTop = true;
    this.menu = undefined;
  }

  private get keymap() {
    return this.shell.keymap;
  }

  /** Entries the filter keeps, notes included, in display order. */
  private entries(): ReadonlyArray<ProfileSetPickerEntry> {
    const query = Fn.pipe(this.query, Str.trim, Str.toLocaleLowerCase());
    if (!query) return this.allEntries;
    return Arr.filter(
      this.allEntries,
      (entry) =>
        isSelectableProfileSetEntry(entry) &&
        Fn.pipe(
          `${entry.label} ${entry.description} ${entry.scope}`,
          Str.toLocaleLowerCase(),
          Str.includes(query),
        ),
    );
  }

  private selectable(): ReadonlyArray<SelectableProfileSetEntry> {
    return Arr.filter(this.entries(), isSelectableProfileSetEntry);
  }

  private ids(): ReadonlyArray<string> {
    return Arr.map(this.selectable(), (entry) => entry.key);
  }

  private selected(): SelectableProfileSetEntry | undefined {
    return this.selectable()[this.shell.state.selected];
  }

  private select(index: number): void {
    if (this.shell.select(index, this.ids()).changed) this.previewAtTop = true;
  }

  /** Selects the default set, or the first set, with the list focused. */
  private reset(): void {
    this.select(initialProfileSetPickerIndex(this.selectable()));
    if (this.shell.state.pane === "detail")
      this.shell.applyMotion("back", { rowCount: 0, hasSelection: false });
  }

  private renderSoon(): void {
    if (!this.disposed) this.options.requestRender();
  }

  private setMessage(kind: "info" | "warning" | "error", text: string): void {
    this.message = { kind, text };
    this.renderSoon();
  }

  private activate(action: "edit" | "use-current"): void {
    const entry = this.selected();
    if (entry?.kind !== "set") {
      this.openActions();
      return;
    }
    if (entry.invalid && (action === "use-current" || !entry.repairable)) {
      this.setMessage("warning", entry.description);
      return;
    }
    this.options.close({ action, target: entry.ref });
  }

  private openActions(): void {
    const entry = this.selected();
    if (!entry) {
      this.setMessage("info", "Save the current session as a set first.");
      return;
    }
    this.message = undefined;
    this.keymap.resetChord();
    this.menu = savedSetMenuPage(entry, {
      ...this.options,
      select: (action) => {
        this.menu = undefined;
        this.options.close(action);
      },
      cancel: () => {
        this.menu = undefined;
        this.renderSoon();
      },
    });
    this.menu.focused = this.focusState;
    this.renderSoon();
  }

  private moveSearchSelection(action: FullScreenAction): boolean {
    if (!isListMotion(action)) return false;
    this.select(
      nextListMotionIndex(
        action,
        this.shell.state.selected,
        this.selectable().length,
        pageSteps(this.options.getHeight() - 8),
      ),
    );
    return true;
  }

  private handleSearchAction(action: FullScreenAction): void {
    if (this.moveSearchSelection(action)) return;
    if (action === "cancel") {
      this.searching = false;
      this.query = "";
      this.reset();
    } else if (action === "confirm") {
      const selected = this.selected();
      if (!selected) {
        this.message = { kind: "info", text: "No saved sets match this search." };
        return;
      }
      this.searching = false;
      this.query = "";
      this.select(this.ids().indexOf(selected.key));
      this.activate("edit");
    }
  }

  private handleSearchInput(data: string): void {
    const resolution = this.keymap.resolve(data, {
      mode: "search",
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (Predicate.isTagged(resolution, "Action")) {
      this.handleSearchAction(resolution.action);
    } else if (data === "\u007f" || data === "\b") {
      this.query = Fn.pipe(this.query, Str.slice(0, -1));
      this.select(0);
      this.message = undefined;
    } else {
      const printable = decodeFullScreenPrintable(data);
      if (printable && printable !== "/") {
        this.query += printable;
        this.select(0);
        this.message = undefined;
      }
    }
    this.renderSoon();
  }

  private startSearch(): void {
    this.searching = true;
    this.query = "";
    this.select(0);
    if (this.shell.state.pane === "detail")
      this.shell.applyMotion("back", { rowCount: 0, hasSelection: false });
    this.message = undefined;
    this.renderSoon();
  }

  private handleNavigationInput(data: string): void {
    const resolution = this.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: PROFILE_SET_SHORTCUTS,
    });
    if (!resolution) return;
    if (Predicate.isTagged(resolution, "Shortcut")) {
      if (resolution.key === "u") this.activate("use-current");
      else if (resolution.key === "a") this.openActions();
      else this.startSearch();
      return;
    }
    const { action } = resolution;
    if (action === "confirm") this.activate("edit");
    else if (action === "help") this.hintsExpanded = !this.hintsExpanded;
    else {
      const motion = listDetailMotionFromAction(action);
      const result = motion
        ? this.shell.applyMotion(motion, {
            rowCount: this.selectable().length,
            hasSelection: this.selected() !== undefined,
          })
        : undefined;
      if (result && Predicate.isTagged(result, "Close")) {
        this.options.close(undefined);
        return;
      }
      if (result && Predicate.isTagged(result, "Update") && result.movedSelection) {
        this.select(result.state.selected);
        this.message = undefined;
      }
    }
    this.renderSoon();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.menu) {
      if (!matchesKey(data, "right")) this.menu.handleInput(data);
      return;
    }
    if (this.searching) this.handleSearchInput(data);
    else this.handleNavigationInput(data);
  }

  render(width: number): string[] {
    return this.renderWithPrompt(width);
  }

  /** Draws the library; a host's `prompt`, such as a confirmation, takes a band above the border. */
  renderWithPrompt(width: number, prompt?: DashboardPrompt): string[] {
    if (this.disposed) return [];
    this.shell.reconcile(this.ids());
    const follow = this.previewAtTop ? "top" : false;
    this.previewAtTop = false;
    return renderProfileSetPicker(
      {
        entries: this.entries(),
        selected: this.selected(),
        shell: this.shell,
        previewFollow: follow,
        searching: this.searching,
        query: this.query,
        hintsExpanded: this.hintsExpanded,
        parentModel: this.options.parentModel,
        parentEffort: this.options.parentEffort,
        menu: this.menu,
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
    this.menu?.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.menu = undefined;
  }
}
