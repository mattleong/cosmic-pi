import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
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
  movementOffset,
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
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";

export type ProfileSetPickerAction =
  | { readonly action: "use-current"; readonly target: PersistentProfileSetRef }
  | { readonly action: "edit"; readonly target: PersistentProfileSetRef }
  | { readonly action: "make-default"; readonly target: PersistentProfileSetRef }
  | { readonly action: "clear-scope-default"; readonly scope: SubagentConfigScope }
  | { readonly action: "copy"; readonly source: PersistentProfileSetRef }
  | { readonly action: "rename"; readonly target: PersistentProfileSetRef }
  | { readonly action: "delete"; readonly target: PersistentProfileSetRef }
  | { readonly action: "save-session"; readonly preferredScope: SubagentConfigScope };

export interface ProfileSetPickerOptions extends Pick<
  SearchableSelectHostOptions,
  "getHeight" | "requestRender" | "matchesKeybinding" | "keybindingLabel"
> {
  readonly theme: Theme;
  readonly inspection: ProfileSettingsInspection;
  readonly projectTrusted: boolean;
  readonly initialScope?: SubagentConfigScope | undefined;
  readonly close: (action: ProfileSetPickerAction | undefined) => void;
}

interface SavedSetMenuChoice {
  readonly action:
    | "use-current"
    | "edit"
    | "make-default"
    | "clear-scope-default"
    | "copy"
    | "rename"
    | "delete";
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
}

type ActionableProfileSetPickerEntry = Extract<
  ProfileSetPickerEntry,
  { readonly kind: "set" | "invalid-default" }
>;

interface ActionMenuState {
  readonly entry: ActionableProfileSetPickerEntry;
  readonly choices: ReadonlyArray<SavedSetMenuChoice>;
  selected: number;
}

const actionChoices = (entry: ActionableProfileSetPickerEntry): ReadonlyArray<SavedSetMenuChoice> =>
  entry.kind === "invalid-default"
    ? [
        {
          action: "clear-scope-default",
          label: entry.scope === "project" ? "Use Global default" : "Use built-in defaults",
          description: entry.description,
          enabled: true,
        },
      ]
    : [
        ...(entry.scopeDefault
          ? [
              {
                action: "clear-scope-default" as const,
                label: entry.scope === "project" ? "Use Global default" : "Use built-in defaults",
                description:
                  entry.scope === "project"
                    ? "Use Global, then built-in profiles in new sessions"
                    : "Use built-in profiles in new sessions without a Project default",
                enabled: true,
              },
            ]
          : !entry.invalid
            ? [
                {
                  action: "make-default" as const,
                  label: "Make default for new sessions",
                  description:
                    entry.scope === "project"
                      ? "Use this set in new sessions for this project"
                      : "Use this set in new sessions without a Project default",
                  enabled: true,
                },
              ]
            : []),
        ...(!entry.invalid
          ? [
              {
                action: "copy" as const,
                label: "Copy",
                description: "Create a copy of this saved set",
                enabled: true,
              },
              {
                action: "rename" as const,
                label: "Rename",
                description: "Give this saved set a new name",
                enabled: true,
              },
            ]
          : []),
        {
          action: "delete",
          label: "Delete",
          description: entry.scopeDefault
            ? "Stop using this set as the default before deleting it"
            : "Delete this saved set. Current Session will not change",
          enabled: !entry.scopeDefault,
        },
      ];

export class ProfileSetPickerComponent implements Component {
  private readonly allEntries: ReadonlyArray<ProfileSetPickerEntry>;
  private selectedIndex: number;
  private query = "";
  private searching = false;
  private actionMenu: ActionMenuState | undefined;
  private pendingDelete: PersistentProfileSetRef | undefined;
  private message:
    | { readonly kind: "info" | "warning" | "error"; readonly text: string }
    | undefined;
  private readonly keymap = new FullScreenKeymap();
  private readonly options: ProfileSetPickerOptions;
  private disposed = false;

  constructor(options: ProfileSetPickerOptions) {
    this.options = options;
    this.allEntries = profileSetPickerEntries(options.inspection, options.projectTrusted);
    this.selectedIndex = initialProfileSetPickerIndex(this.allEntries, options.initialScope);
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

  private move(offset: number): void {
    const entries = this.entries();
    this.selectedIndex = Math.max(
      0,
      Math.min(Math.max(0, entries.length - 1), this.selectedIndex + offset),
    );
    this.message = undefined;
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
    this.actionMenu = { entry, choices: actionChoices(entry), selected: 0 };
    this.message = undefined;
    this.keymap.resetChord();
    this.renderSoon();
  }

  private chooseAction(): void {
    const menu = this.actionMenu;
    const choice = menu?.choices[menu.selected];
    if (!menu || !choice) return;
    if (!choice.enabled) {
      this.setMessage("warning", choice.description);
      return;
    }
    if (choice.action === "clear-scope-default") {
      this.options.close({ action: choice.action, scope: menu.entry.scope });
      return;
    }
    if (menu.entry.kind !== "set") return;
    const target = menu.entry.ref;
    if (choice.action === "delete") {
      this.pendingDelete = target;
      this.actionMenu = undefined;
      this.renderSoon();
      return;
    }
    if (choice.action === "copy") this.options.close({ action: "copy", source: target });
    else this.options.close({ action: choice.action, target });
  }

  private saveScope(): SubagentConfigScope {
    const selected = this.selected();
    return selected?.scope === "project" && this.options.projectTrusted ? "project" : "global";
  }

  private handleConfirmation(data: string): void {
    const pending = this.pendingDelete;
    const resolution = this.keymap.resolve(data, {
      mode: "confirmation",
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (resolution?._tag === "Action" && resolution.action === "confirm") {
      this.options.close({ action: "delete", target: pending! });
      return;
    }
    if (resolution?._tag === "Action" && resolution.action === "cancel") {
      this.pendingDelete = undefined;
      this.setMessage("info", "Delete canceled.");
    }
  }

  private handleMenu(data: string): void {
    const menu = this.actionMenu;
    if (!menu) return;
    const resolution = this.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (!resolution || resolution._tag !== "Action") return;
    const move = (offset: number) => {
      menu.selected = Math.max(0, Math.min(menu.choices.length - 1, menu.selected + offset));
    };
    if (isListMotion(resolution.action)) {
      if (isMovementMotion(resolution.action))
        move(movementOffset(resolution.action, { half: 3, page: 3 }));
      else
        menu.selected = nextListMotionIndex(resolution.action, menu.selected, menu.choices.length, {
          half: 3,
          page: 3,
        });
    } else
      switch (resolution.action) {
        case "confirm":
        case "forward":
          this.chooseAction();
          return;
        case "cancel":
        case "back":
          this.actionMenu = undefined;
          this.message = undefined;
          break;
        case "quit":
          this.options.close(undefined);
          return;
        case "search":
        case "help":
        case "next-pane":
        case "previous-pane":
        case "pending-first":
          break;
      }
    this.renderSoon();
  }

  /** Shared list-motion handling for both input modes; endpoints keep the message untouched. */
  private applyMotionAction(action: string, steps: PageSteps): boolean {
    if (!isListMotion(action)) return false;
    if (isMovementMotion(action)) this.move(movementOffset(action, steps));
    else
      this.selectedIndex = nextListMotionIndex(
        action,
        this.selectedIndex,
        this.entries().length,
        steps,
      );
    return true;
  }

  private handleSearchAction(action: string, steps: PageSteps): void {
    if (this.applyMotionAction(action, steps)) return;
    switch (action) {
      case "cancel":
        this.searching = false;
        this.query = "";
        this.selectedIndex = initialProfileSetPickerIndex(
          this.allEntries,
          this.options.initialScope,
        );
        break;
      case "confirm": {
        const selected = this.selected();
        if (!selected) {
          this.message = { kind: "info", text: "No saved sets match this search." };
          break;
        }
        this.searching = false;
        this.query = "";
        this.selectedIndex = this.allEntries.indexOf(selected);
        this.activate("edit");
        break;
      }
      case "quit":
      case "back":
      case "forward":
      case "search":
      case "help":
      case "next-pane":
      case "previous-pane":
      case "pending-first":
        break;
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

  private handleNavigationInput(data: string): void {
    const resolution = this.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: new Set(["/", "s", "u"]),
    });
    if (!resolution) return;
    if (resolution._tag === "Shortcut") {
      if (resolution.key === "/") {
        this.searching = true;
        this.query = "";
        this.selectedIndex = 0;
        this.message = undefined;
      } else if (resolution.key === "u") {
        this.activate("use-current");
        return;
      } else if (resolution.key === "s") {
        this.options.close({ action: "save-session", preferredScope: this.saveScope() });
        return;
      }
      this.renderSoon();
      return;
    }
    const steps = pageSteps(this.options.getHeight() - 8);
    if (this.applyMotionAction(resolution.action, steps)) {
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
      case "search":
        this.searching = true;
        this.query = "";
        this.selectedIndex = 0;
        break;
      case "help":
        this.openActions();
        return;
      case "next-pane":
      case "previous-pane":
      case "pending-first":
        break;
    }
    this.renderSoon();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.pendingDelete) {
      this.handleConfirmation(data);
      return;
    }
    if (this.actionMenu) {
      this.handleMenu(data);
      return;
    }
    if (this.searching) this.handleSearchInput(data);
    else this.handleNavigationInput(data);
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const entries = this.entries();
    this.selectedIndex = Math.max(0, Math.min(Math.max(0, entries.length - 1), this.selectedIndex));
    const baseState = {
      entries,
      selectedIndex: this.selectedIndex,
      query: this.query,
      searching: this.searching,
      projectTrusted: this.options.projectTrusted,
    };
    const withMessage = this.message ? { ...baseState, message: this.message } : baseState;
    const withMenu = this.actionMenu
      ? {
          ...withMessage,
          actionMenu: {
            label:
              this.actionMenu.entry.kind === "set"
                ? qualifiedProfileSetLabel(this.actionMenu.entry.ref)
                : `${this.actionMenu.entry.scope === "project" ? "Project" : "Global"} default`,
            choices: this.actionMenu.choices,
            selectedIndex: this.actionMenu.selected,
          },
        }
      : withMessage;
    const renderState = this.pendingDelete
      ? { ...withMenu, pendingDeleteLabel: qualifiedProfileSetLabel(this.pendingDelete) }
      : withMenu;
    return renderProfileSetPicker(renderState, {
      theme: this.options.theme,
      width,
      height: this.options.getHeight(),
      keybindingLabel: this.options.keybindingLabel,
    });
  }

  invalidate(): void {}

  dispose(): void {
    this.disposed = true;
    this.actionMenu = undefined;
    this.pendingDelete = undefined;
  }
}
