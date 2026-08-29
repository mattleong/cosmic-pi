import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import {
  decodeFullScreenPrintable,
  FullScreenKeymap,
  pageSteps,
} from "pi-cosmic-ui/manager/keymap";
import type { FullScreenSelectionKeybindingId } from "pi-cosmic-ui/manager/keymap";
import type { ResolvedProfileSetSelection } from "../config/options.ts";
import type { SubagentConfigScope } from "../config/store.ts";
import type { PersistentProfileSetRef } from "./profile-route-editor.ts";
import {
  initialProfileSetPickerIndex,
  profileSetPickerEntries,
  profileSetSelectionLabel,
  qualifiedProfileSetLabel,
  type ProfileSetPickerEntry,
} from "./ui/profile-set-picker-model.ts";
import { renderProfileSetPicker } from "./ui/profile-set-picker-render.ts";
import type { ProfileSettingsInspection } from "./profile-route-editor.ts";

type UsableProfileSetPickerEntry = Exclude<
  ProfileSetPickerEntry,
  { readonly kind: "invalid-default" }
>;

type PendingProfileSetPickerConfirmation =
  | {
      readonly kind: "use";
      readonly entry: UsableProfileSetPickerEntry;
      readonly reloadRequired: boolean;
    }
  | { readonly kind: "delete"; readonly target: PersistentProfileSetRef };

export type ProfileSetPickerAction =
  | { readonly action: "use"; readonly entry: UsableProfileSetPickerEntry }
  | { readonly action: "edit"; readonly target: PersistentProfileSetRef }
  | { readonly action: "create"; readonly scope: SubagentConfigScope }
  | { readonly action: "copy"; readonly source: PersistentProfileSetRef }
  | { readonly action: "rename"; readonly target: PersistentProfileSetRef }
  | { readonly action: "delete"; readonly target: PersistentProfileSetRef }
  | { readonly action: "reload" };

export interface ProfileSetPickerOptions {
  readonly theme: Theme;
  readonly inspection: ProfileSettingsInspection;
  readonly projectTrusted: boolean;
  readonly initialScope?: SubagentConfigScope | undefined;
  readonly reloadRequired: boolean;
  readonly getHeight: () => number;
  readonly requestRender: () => void;
  readonly matchesKeybinding?:
    | ((data: string, id: FullScreenSelectionKeybindingId) => boolean)
    | undefined;
  readonly close: (action: ProfileSetPickerAction | undefined) => void;
}

const SHORTCUTS = new Set(["/", "R", "c", "e", "n", "r", "u", "x"]);

export class ProfileSetPickerComponent implements Component, Focusable {
  private readonly allEntries: ReadonlyArray<ProfileSetPickerEntry>;
  private selectedIndex: number;
  private query = "";
  private searching = false;
  private pendingConfirmation: PendingProfileSetPickerConfirmation | undefined;
  private message:
    | { readonly kind: "info" | "warning" | "error"; readonly text: string }
    | undefined;
  private readonly keymap = new FullScreenKeymap();
  private readonly options: ProfileSetPickerOptions;
  private disposed = false;
  private _focused = false;

  constructor(options: ProfileSetPickerOptions) {
    this.options = options;
    this.allEntries = profileSetPickerEntries(options.inspection, options.projectTrusted);
    this.selectedIndex = initialProfileSetPickerIndex(this.allEntries, options.initialScope);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    if (!this.disposed) this._focused = value;
  }

  private entries(): ReadonlyArray<ProfileSetPickerEntry> {
    const query = this.query.trim().toLocaleLowerCase();
    if (!query) return this.allEntries;
    return this.allEntries.filter((entry) =>
      `${entry.label} ${entry.description}`.toLocaleLowerCase().includes(query),
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

  private entryMatchesSelection(
    entry: UsableProfileSetPickerEntry,
    selection: ResolvedProfileSetSelection,
  ): boolean {
    if (entry.kind === "builtin") return selection.scope === "builtin";
    if (entry.kind === "inherit-project") return selection.scope !== "project";
    return (
      selection.scope === entry.scope && !selection.invalid && selection.name === entry.ref.name
    );
  }

  private activationRequiresReload(entry: UsableProfileSetPickerEntry): boolean {
    return (
      this.options.reloadRequired ||
      !this.entryMatchesSelection(
        entry,
        this.options.inspection.session.baseConfig.currentProfileSet,
      ) ||
      !this.entryMatchesSelection(entry, this.options.inspection.config.currentProfileSet)
    );
  }

  private beginUse(): void {
    const entry = this.selected();
    if (!entry) return;
    if (entry.kind === "invalid-default") {
      this.setMessage(
        "warning",
        "Choose a valid set, Inherit global, or Built-in routes to repair the default.",
      );
      return;
    }
    if (entry.kind === "set" && entry.invalid) {
      this.setMessage("warning", "This invalid set cannot become the default.");
      return;
    }
    this.message = undefined;
    this.pendingConfirmation = {
      kind: "use",
      entry,
      reloadRequired: this.activationRequiresReload(entry),
    };
    this.renderSoon();
  }

  private editSelected(): void {
    const entry = this.selected();
    if (!entry) return;
    if (entry.kind === "invalid-default") {
      this.setMessage(
        "warning",
        "This default reference is malformed. Choose a valid entry with u or repair the settings file.",
      );
      return;
    }
    if (entry.kind === "builtin") {
      this.setMessage("info", "Built-in routes have no editable set. Press u to use them.");
      return;
    }
    if (entry.kind === "inherit-project") {
      this.setMessage("info", "Inherit global has no editable set. Press u to use it.");
      return;
    }
    if (entry.invalid) {
      this.setMessage("warning", "This set is invalid. Delete it or repair the file directly.");
      return;
    }
    this.options.close({ action: "edit", target: entry.ref });
  }

  private scopeForNew(): SubagentConfigScope {
    return this.selected()?.scope === "project" && this.options.projectTrusted
      ? "project"
      : "global";
  }

  private beginDelete(): void {
    const entry = this.selected();
    if (entry?.kind !== "set") {
      this.setMessage("info", "Select a named profile set to delete it.");
      return;
    }
    if (entry.scopeDefault) {
      this.setMessage("warning", "Choose another default set or inherit before deleting this set.");
      return;
    }
    this.message = undefined;
    this.pendingConfirmation = { kind: "delete", target: entry.ref };
    this.renderSoon();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const printable = decodeFullScreenPrintable(data);
    if (this.pendingConfirmation) {
      const pending = this.pendingConfirmation;
      const resolution = this.keymap.resolve(data, {
        mode: "confirmation",
        matchesKeybinding: this.options.matchesKeybinding,
      });
      if (resolution?._tag === "Action" && resolution.action === "confirm") {
        if (pending.kind === "use") this.options.close({ action: "use", entry: pending.entry });
        else this.options.close({ action: "delete", target: pending.target });
        return;
      }
      if (resolution?._tag === "Action" && resolution.action === "cancel") {
        this.pendingConfirmation = undefined;
        this.setMessage(
          "info",
          pending.kind === "use" ? "Activation canceled." : "Delete canceled.",
        );
      }
      return;
    }
    if (this.searching) {
      const resolution = this.keymap.resolve(data, {
        mode: "navigation",
        matchesKeybinding: this.options.matchesKeybinding,
      });
      if (
        resolution?._tag === "Action" &&
        (resolution.action === "cancel" || resolution.action === "quit")
      ) {
        this.searching = false;
        this.query = "";
        this.selectedIndex = initialProfileSetPickerIndex(
          this.allEntries,
          this.options.initialScope,
        );
      } else if (resolution?._tag === "Action" && resolution.action === "confirm") {
        this.searching = false;
      } else if (data === "\u007f" || data === "\b") {
        this.query = this.query.slice(0, -1);
        this.selectedIndex = 0;
      } else if (printable && printable !== "/") {
        this.query += printable;
        this.selectedIndex = 0;
      }
      this.renderSoon();
      return;
    }
    const resolution = this.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: SHORTCUTS,
    });
    if (!resolution) return;
    if (resolution._tag === "Shortcut") {
      const shortcut = resolution.key;
      const selected = this.selected();
      if (shortcut === "/") {
        this.searching = true;
        this.query = "";
        this.selectedIndex = 0;
      } else if (shortcut === "u") this.beginUse();
      else if (shortcut === "e") this.editSelected();
      else if (shortcut === "n")
        this.options.close({ action: "create", scope: this.scopeForNew() });
      else if (shortcut === "c" && selected?.kind === "set")
        this.options.close({ action: "copy", source: selected.ref });
      else if (shortcut === "R" && selected?.kind === "set")
        this.options.close({ action: "rename", target: selected.ref });
      else if (shortcut === "x") this.beginDelete();
      else if (shortcut === "r" && this.options.reloadRequired)
        this.options.close({ action: "reload" });
      this.renderSoon();
      return;
    }
    const steps = pageSteps(this.options.getHeight() - 8);
    switch (resolution.action) {
      case "cancel":
      case "quit":
        this.options.close(undefined);
        return;
      case "confirm":
      case "forward":
        this.editSelected();
        return;
      case "up":
        this.move(-1);
        break;
      case "down":
        this.move(1);
        break;
      case "half-page-up":
        this.move(-steps.half);
        break;
      case "half-page-down":
        this.move(steps.half);
        break;
      case "full-page-up":
        this.move(-steps.page);
        break;
      case "full-page-down":
        this.move(steps.page);
        break;
      case "first":
        this.selectedIndex = 0;
        break;
      case "last":
        this.selectedIndex = Math.max(0, this.entries().length - 1);
        break;
      case "search":
        this.searching = true;
        this.query = "";
        this.selectedIndex = 0;
        break;
      case "back":
      case "next-pane":
      case "previous-pane":
      case "help":
      case "pending-first":
        break;
    }
    this.renderSoon();
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const entries = this.entries();
    this.selectedIndex = Math.max(0, Math.min(Math.max(0, entries.length - 1), this.selectedIndex));
    return renderProfileSetPicker(
      {
        entries,
        selectedIndex: this.selectedIndex,
        query: this.query,
        searching: this.searching,
        reloadRequired: this.options.reloadRequired,
        sessionOverrideCount: Object.keys(this.options.inspection.session.overrides).length,
        activeSelectionLabel: profileSetSelectionLabel(
          this.options.inspection.session.baseConfig.currentProfileSet,
        ),
        savedSelectionLabel: profileSetSelectionLabel(
          this.options.inspection.config.currentProfileSet,
        ),
        ...(this.message !== undefined && { message: this.message }),
        ...(this.pendingConfirmation?.kind === "use"
          ? {
              pendingConfirmation: {
                kind: "use" as const,
                label: this.pendingConfirmation.entry.label,
                reloadRequired: this.pendingConfirmation.reloadRequired,
              },
            }
          : this.pendingConfirmation?.kind === "delete"
            ? {
                pendingConfirmation: {
                  kind: "delete" as const,
                  label: qualifiedProfileSetLabel(this.pendingConfirmation.target),
                },
              }
            : {}),
      },
      {
        theme: this.options.theme,
        width,
        height: this.options.getHeight(),
      },
    );
  }

  invalidate(): void {}

  dispose(): void {
    this.disposed = true;
    this.pendingConfirmation = undefined;
  }
}
