import { type Component, type Focusable } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import {
  decodeFullScreenPrintable,
  FullScreenKeymap,
  type FullScreenAction,
  type FullScreenKeymapOptions,
  type FullScreenSelectionKeybindingId,
} from "./keymap.ts";
import { clipToWidth } from "./chrome.ts";

export const fullScreenSettingsHint = (searching: boolean, helpExpanded?: boolean): string =>
  searching
    ? "Type to filter · Enter Select · Esc Done"
    : helpExpanded
      ? "j/k or ↑/↓ Move · gg/G Ends · C-u/d/PgUp/PgDn Page · / Filter · Enter/l Select · h/q/Esc Back · ? Less"
      : "j/k Move · Enter/l Select · h/q Back · / Filter · ? More";

export interface VimSettingsAdapterOptions {
  readonly matchesKeybinding?: FullScreenKeymapOptions["matchesKeybinding"];
  readonly requestRender?: (() => void) | undefined;
  readonly renderHint?:
    | ((mode: "navigation" | "search", helpExpanded?: boolean) => string)
    | undefined;
}

const SETTINGS_ACTION_INPUT = {
  up: ["\u001b[A", "tui.select.up"],
  down: ["\u001b[B", "tui.select.down"],
  "half-page-up": ["\u001b[5~"],
  "full-page-up": ["\u001b[5~", "tui.select.pageUp"],
  "half-page-down": ["\u001b[6~"],
  "full-page-down": ["\u001b[6~", "tui.select.pageDown"],
  first: ["\u001b[H"],
  last: ["\u001b[F"],
  confirm: ["\r", "tui.select.confirm"],
  forward: ["\r"],
  cancel: ["\u001b", "tui.select.cancel"],
  back: ["\u001b"],
  quit: ["\u001b"],
  help: [],
  "next-pane": [],
  "pending-first": [],
  "previous-pane": [],
  search: [],
} satisfies Record<
  FullScreenAction,
  readonly [input?: string, id?: FullScreenSelectionKeybindingId]
>;

const isTextCallback = <Value>(value: Value): value is Value & ((text: string) => void) =>
  Predicate.isFunction(value);

const settingsSearchInput = (child: Component) => {
  if (!("searchInput" in child)) return undefined;
  const input = child.searchInput;
  return Predicate.isObject(input) ? input : undefined;
};

const settingsSubmenu = (child: Component) =>
  "submenuComponent" in child ? child.submenuComponent : undefined;

const clearSettingsFilter = (child: Component): void => {
  const input = settingsSearchInput(child);
  if (isTextCallback(input?.setValue)) input.setValue("");
  if ("applyFilter" in child && isTextCallback(child.applyFilter)) child.applyFilter("");
};

export class VimSettingsAdapter implements Component, Focusable {
  private mode: "navigation" | "search" = "navigation";
  private helpExpanded = false;
  private hasFocus = false;
  private readonly keymap = new FullScreenKeymap();
  private readonly child: Component;
  private readonly options: VimSettingsAdapterOptions;

  constructor(child: Component, options: VimSettingsAdapterOptions = {}) {
    this.child = child;
    this.options = options;
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.syncChildFocus();
  }

  private syncChildFocus(): void {
    const child = this.child;
    if ("focused" in child) child.focused = this.hasFocus;
    const input = settingsSearchInput(child);
    if (input) input.focused = this.hasFocus && this.mode === "search";
    const submenu = settingsSubmenu(child);
    if (Predicate.isObject(submenu) && "focused" in submenu) submenu.focused = this.hasFocus;
  }

  private forwardSelection(data: string, action: FullScreenAction): string | undefined {
    const [input, id] = SETTINGS_ACTION_INPUT[action];
    return id && this.options.matchesKeybinding?.(data, id) ? data : input;
  }

  private handleSearchInput(data: string, action: FullScreenAction | undefined): void {
    if (action === "cancel") {
      this.mode = "navigation";
      this.keymap.resetChord();
      clearSettingsFilter(this.child);
      return;
    }
    this.child.handleInput?.((action && this.forwardSelection(data, action)) ?? data);
    if (action === "confirm") {
      this.mode = "navigation";
      this.keymap.resetChord();
    }
  }

  private handleNavigationInput(data: string, action: FullScreenAction | undefined): boolean {
    if (action === "help") this.helpExpanded = !this.helpExpanded;
    else if (action === "search") {
      this.mode = "search";
      this.helpExpanded = false;
      this.keymap.resetChord();
    } else if (action !== undefined) {
      const translated = this.forwardSelection(data, action);
      if (translated !== undefined) this.child.handleInput?.(translated);
    } else if (decodeFullScreenPrintable(data) === " ") this.child.handleInput?.(" ");
    else return false;
    return true;
  }

  handleInput(data: string): void {
    const resolution = this.keymap.resolve(data, {
      mode: this.mode,
      matchesKeybinding: this.options.matchesKeybinding,
    });
    const action = Predicate.isTagged(resolution, "Action") ? resolution.action : undefined;
    if (this.mode === "search") this.handleSearchInput(data, action);
    else if (!this.handleNavigationInput(data, action)) return;
    this.syncChildFocus();
    this.options.requestRender?.();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    this.syncChildFocus();
    const lines = [...this.child.render(safeWidth)].map((line) => clipToWidth(line, safeWidth, ""));
    const hint = this.options.renderHint?.(this.mode, this.helpExpanded);
    if (hint && settingsSubmenu(this.child) === null && lines.at(-2) === "") lines.pop();
    return hint ? [...lines, clipToWidth(hint, safeWidth, "")] : lines;
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

export interface SettingsSurfaceBridgeOptions {
  readonly invoke?: (<A>(callback: () => A, fallback: A) => A) | undefined;
  readonly admitInput?: (() => boolean) | undefined;
  readonly afterInput?: (() => void) | undefined;
}

export const settingsSurfaceBridge = (
  adapter: VimSettingsAdapter,
  container: Component,
  options: SettingsSurfaceBridgeOptions = {},
): Component & Focusable => {
  const invoke = options.invoke ?? (<A>(callback: () => A, _fallback: A): A => callback());
  return {
    get focused(): boolean {
      return adapter.focused;
    },
    set focused(value: boolean) {
      adapter.focused = value;
    },
    render: (width: number): string[] => {
      const safeWidth = Math.max(0, Math.floor(width));
      if (safeWidth === 0) return [];
      return invoke(
        () => container.render(safeWidth).map((line) => clipToWidth(line, safeWidth, "")),
        [],
      );
    },
    invalidate: (): void => invoke(() => container.invalidate(), undefined),
    handleInput: (data: string): void => {
      const { admitInput } = options;
      if (admitInput && !invoke(admitInput, false)) return;
      invoke(() => adapter.handleInput(data), undefined);
      options.afterInput?.();
    },
  };
};
