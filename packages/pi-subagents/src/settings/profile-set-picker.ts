import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import {
  decodeFullScreenPrintable,
  FullScreenKeymap,
  pageSteps,
  type PageSteps,
} from "pi-cosmic-ui/manager/keymap";
import type { SubagentConfigScope } from "../config/store.ts";
import {
  isListMotion,
  isMovementMotion,
  nextListMotionIndex,
} from "pi-cosmic-ui/manager/list-navigation";
import type { PersistentProfileSetRef, ProfileSettingsInspection } from "./profile-route-editor.ts";
import {
  initialProfileSetPickerIndex,
  profileSetPickerEntries,
  qualifiedProfileSetLabel,
  type ProfileSetPickerEntry,
} from "./ui/profile-set-picker-model.ts";
import { renderProfileSetPicker } from "./ui/profile-set-picker-render.ts";
import { isWorkspaceNavigationKey } from "./ui/profile-workspace-keys.ts";
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

export interface ProfileSetPickerOptions extends Pick<
  SearchableSelectHostOptions,
  "getHeight" | "requestRender" | "matchesKeybinding" | "keybindingLabel"
> {
  readonly theme: Theme;
  readonly inspection: ProfileSettingsInspection;
  readonly projectTrusted: boolean;
  readonly close: (action: ProfileSetPickerAction | undefined) => void;
}

type SavedSetMenuEntry = Extract<
  ProfileSetPickerEntry,
  { readonly kind: "set" | "invalid-default" }
>;

const menuChoice = (
  payload: ProfileSetPickerAction,
  label: string,
  description: string,
  disabledHint?: string,
): SearchableSelectPageChoice<ProfileSetPickerAction> => ({
  value: payload.action,
  item: { value: payload.action, label, description },
  searchText: `${label} ${description}`,
  payload,
  ...(disabledHint && { enabled: false, disabledReason: description, disabledHint }),
});

/** More-menu choices carry complete actions; a default set keeps Delete visible but unavailable. */
export const savedSetMenuChoices = (
  entry: SavedSetMenuEntry,
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
        : "Delete this saved set. Current Session will not change",
      entry.scopeDefault ? "clear default first" : undefined,
    ),
  ];
};

/** The saved-set More menu is the shared selector over complete library actions. */
const savedSetMenuPage = (
  entry: SavedSetMenuEntry,
  host: Omit<
    SearchableSelectPageOptions<ProfileSetPickerAction>,
    "breadcrumb" | "title" | "subtitle" | "choices"
  >,
): SearchableSelectPage<ProfileSetPickerAction> =>
  new SearchableSelectPage({
    ...host,
    breadcrumb: "/subagents profiles › Profile sets › More",
    title:
      entry.kind === "set"
        ? qualifiedProfileSetLabel(entry.ref)
        : `${entry.scope === "project" ? "Project" : "Global"} default`,
    subtitle:
      entry.kind === "invalid-default"
        ? entry.description
        : entry.scope === "project"
          ? "New sessions in this project use its default, else Global"
          : "New sessions without a Project default use Global, else built-ins",
    choices: savedSetMenuChoices(entry),
    emptyText: "No matching actions",
  });

export class ProfileSetPickerComponent implements Component, Focusable {
  private allEntries: ReadonlyArray<ProfileSetPickerEntry>;
  private selectedIndex: number;
  private query = "";
  private searching = false;
  private menu: SearchableSelectPage<ProfileSetPickerAction> | undefined;
  private message:
    | { readonly kind: "info" | "warning" | "error"; readonly text: string }
    | undefined;
  private readonly keymap = new FullScreenKeymap();
  private options: ProfileSetPickerOptions;
  private disposed = false;
  private _focused = false;

  constructor(options: ProfileSetPickerOptions) {
    this.options = {
      ...options,
      matchesKeybinding: (data, id) =>
        !isWorkspaceNavigationKey(data) && (options.matchesKeybinding?.(data, id) ?? false),
    };
    this.allEntries = profileSetPickerEntries(options.inspection, options.projectTrusted);
    this.selectedIndex = initialProfileSetPickerIndex(this.allEntries);
  }

  get focused(): boolean {
    return this._focused;
  }

  /** The More menu owns a `/` filter input, so focus follows it while open. */
  set focused(value: boolean) {
    this._focused = value;
    if (this.menu) this.menu.focused = value;
  }

  get hasOverlay(): boolean {
    return this.menu !== undefined || this.searching;
  }

  updateInspection(inspection: ProfileSettingsInspection, projectTrusted: boolean): void {
    if (this.disposed) return;
    const selected = this.selected()?.key;
    this.options = { ...this.options, inspection, projectTrusted };
    this.allEntries = profileSetPickerEntries(inspection, projectTrusted);
    const index = this.entries().findIndex((entry) => entry.key === selected);
    this.selectedIndex = index < 0 ? 0 : index;
    // A refreshed library cannot keep a menu built for the previous entry.
    this.menu = undefined;
  }

  private entries(): ReadonlyArray<ProfileSetPickerEntry> {
    const query = this.query.trim().toLocaleLowerCase();
    if (!query) return this.allEntries;
    return this.allEntries.filter((entry) =>
      `${entry.label} ${entry.description} ${entry.scope}`.toLocaleLowerCase().includes(query),
    );
  }

  private selected(): ProfileSetPickerEntry | undefined {
    return this.entries()[this.selectedIndex];
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
    if (entry?.kind !== "set" && entry?.kind !== "invalid-default") {
      this.setMessage(
        entry?.scope === "project" && this.options.projectTrusted === false ? "warning" : "info",
        entry?.description ?? "Select a saved set first.",
      );
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
    this.menu.focused = this._focused;
    this.renderSoon();
  }

  /** Shared list-motion handling for both input modes; endpoints keep the message untouched. */
  private applyMotionAction(action: string, steps: PageSteps): boolean {
    if (!isListMotion(action)) return false;
    this.selectedIndex = nextListMotionIndex(
      action,
      this.selectedIndex,
      this.entries().length,
      steps,
    );
    if (isMovementMotion(action)) this.message = undefined;
    return true;
  }

  private handleSearchAction(action: string, steps: PageSteps): void {
    if (this.applyMotionAction(action, steps)) return;
    if (action === "cancel") {
      this.searching = false;
      this.query = "";
      this.selectedIndex = initialProfileSetPickerIndex(this.allEntries);
    } else if (action === "confirm") {
      const selected = this.selected();
      if (!selected) {
        this.message = { kind: "info", text: "No saved sets match this search." };
        return;
      }
      this.searching = false;
      this.query = "";
      this.selectedIndex = this.allEntries.indexOf(selected);
      this.activate("edit");
    }
  }

  private handleSearchInput(data: string): void {
    const resolution = this.keymap.resolve(data, {
      mode: "search",
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (resolution?._tag === "Action") {
      this.handleSearchAction(resolution.action, pageSteps(this.options.getHeight() - 8));
    } else if (data === "\u007f" || data === "\b") {
      this.query = this.query.slice(0, -1);
      this.selectedIndex = 0;
      this.message = undefined;
    } else {
      const printable = decodeFullScreenPrintable(data);
      if (printable && printable !== "/") {
        this.query += printable;
        this.selectedIndex = 0;
        this.message = undefined;
      }
    }
    this.renderSoon();
  }

  private startSearch(): void {
    this.searching = true;
    this.query = "";
    this.selectedIndex = 0;
  }

  private handleNavigationInput(data: string): void {
    const resolution = this.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: new Set(["/", "a", "u"]),
    });
    if (!resolution) return;
    if (resolution._tag === "Shortcut") {
      if (resolution.key === "u") this.activate("use-current");
      else if (resolution.key === "a") this.openActions();
      else {
        this.startSearch();
        this.message = undefined;
        this.renderSoon();
      }
      return;
    }
    if (this.applyMotionAction(resolution.action, pageSteps(this.options.getHeight() - 8))) {
      this.renderSoon();
      return;
    }
    switch (resolution.action) {
      case "cancel":
      case "quit":
      case "back":
        this.options.close(undefined);
        return;
      case "confirm":
      case "forward":
        this.activate("edit");
        return;
      case "help":
        this.openActions();
        return;
      case "search":
        this.startSearch();
    }
    this.renderSoon();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.menu) {
      // Shared selectors treat Right as confirmation; Right never chooses a saved-set action.
      if (!matchesKey(data, "right")) this.menu.handleInput(data);
      return;
    }
    if (this.searching) this.handleSearchInput(data);
    else this.handleNavigationInput(data);
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    if (this.menu) return this.menu.render(width);
    const entries = this.entries();
    this.selectedIndex = Math.max(0, Math.min(Math.max(0, entries.length - 1), this.selectedIndex));
    return renderProfileSetPicker(
      {
        entries,
        selectedIndex: this.selectedIndex,
        query: this.query,
        searching: this.searching,
        ...(this.message && { message: this.message }),
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
    this.menu?.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.menu = undefined;
  }
}
