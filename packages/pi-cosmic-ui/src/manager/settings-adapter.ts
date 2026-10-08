import { type Component, type Focusable } from "@earendil-works/pi-tui";
import {
  decodeFullScreenPrintable,
  FullScreenKeymap,
  type FullScreenAction,
  type FullScreenKeymapOptions,
  type FullScreenSelectionKeybindingId,
} from "./keymap.ts";
import { clipToWidth } from "./chrome.ts";

/**
 * Shared modeless hint copy for settings-style lists driven by the full-screen keymap.
 * SettingsList has a single page motion, so `C-u/d` and `PgUp/PgDn` are advertised together
 * rather than as a fake half/full-page distinction.
 */
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

/** Raw SettingsList input and configured selection id each full-screen action forwards as. */
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

/**
 * Structural view of the *private* pi-tui SettingsList/SelectList internals the adapter
 * deliberately couples to: `searchInput` (search focus plus `setValue` for clearing the
 * filter text on Esc), `applyFilter` (re-filtering after the search text is cleared, so a
 * dismissed search cannot keep filtering the list invisibly), `submenuComponent` (submenu
 * focus and trailing-blank-line handling), and an optional `focused` field. This is an
 * explicit contract with the pinned pi-tui version and must be reviewed directly when that
 * dependency is upgraded.
 */
type SettingsFocusableBridge = {
  focused?: boolean;
  searchInput?: (Focusable & { setValue: (value: string) => void }) | undefined;
  applyFilter?: (query: string) => void;
  submenuComponent?: (Component & Partial<Focusable>) | null | undefined;
};

/** Modal adapter for pi-tui SettingsList/SelectList without changing their global key manager. */
export class VimSettingsAdapter implements Component, Focusable {
  private mode: "navigation" | "search" = "navigation";
  private helpExpanded = false;
  private _focused = false;
  private readonly keymap = new FullScreenKeymap();
  private readonly child: Component & SettingsFocusableBridge;
  private readonly options: VimSettingsAdapterOptions;

  constructor(child: Component, options: VimSettingsAdapterOptions = {}) {
    // SAFETY: Callers pass pi-tui SettingsList/SelectList instances; every bridge member is optional and checked before use.
    this.child = child as Component & SettingsFocusableBridge;
    this.options = options;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncChildFocus();
  }

  private syncChildFocus(): void {
    const child = this.child;
    if ("focused" in child) child.focused = this._focused;
    if (child.searchInput) child.searchInput.focused = this._focused && this.mode === "search";
    if (child.submenuComponent && "focused" in child.submenuComponent)
      child.submenuComponent.focused = this._focused;
  }

  private forwardSelection(data: string, action: FullScreenAction): string | undefined {
    const [input, id] = SETTINGS_ACTION_INPUT[action];
    return id && this.options.matchesKeybinding?.(data, id) ? data : input;
  }

  handleInput(data: string): void {
    const resolution = this.keymap.resolve(data, {
      mode: this.mode,
      matchesKeybinding: this.options.matchesKeybinding,
    });
    const action = resolution?._tag === "Action" ? resolution.action : undefined;
    if (this.mode === "search") {
      if (action === "cancel") {
        // Esc leaves search without forwarding a close to the child; the typed filter is
        // cleared and re-applied so it cannot keep filtering the list invisibly.
        this.mode = "navigation";
        this.keymap.resetChord();
        this.child.searchInput?.setValue("");
        this.child.applyFilter?.("");
      } else {
        this.child.handleInput?.((action && this.forwardSelection(data, action)) ?? data);
        if (action === "confirm") {
          this.mode = "navigation";
          this.keymap.resetChord();
        }
      }
    } else if (action === "help") this.helpExpanded = !this.helpExpanded;
    else if (action === "search") {
      this.mode = "search";
      this.helpExpanded = false;
      this.keymap.resetChord();
    } else if (action !== undefined) {
      const translated = this.forwardSelection(data, action);
      if (translated !== undefined) this.child.handleInput?.(translated);
    } else if (decodeFullScreenPrintable(data) === " ") this.child.handleInput?.(" ");
    else return;
    this.syncChildFocus();
    this.options.requestRender?.();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    this.syncChildFocus();
    const lines = [...this.child.render(safeWidth)].map((line) => clipToWidth(line, safeWidth, ""));
    const hint = this.options.renderHint?.(this.mode, this.helpExpanded);
    if (hint && this.child.submenuComponent === null && lines.at(-2) === "") lines.pop();
    return hint ? [...lines, clipToWidth(hint, safeWidth, "")] : lines;
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

export interface SettingsSurfaceBridgeOptions {
  /**
   * Caller-owned host guard wrapped around render/invalidate/input delegation. Ownership of
   * host-boundary recovery (safeHostUi/hostQuery/…) stays with the calling package; the
   * bridge only threads the guard through. Defaults to direct invocation.
   */
  readonly invoke?: (<A>(callback: () => A, fallback: A) => A) | undefined;
  /** Caller-owned follow-up (typically a guarded render request) after each input. */
  readonly afterInput?: (() => void) | undefined;
}

/**
 * Minimal focus/render bridge for `ctx.ui.custom` settings surfaces: focus targets the
 * adapter while rendering targets the composed container (title + adapter).
 */
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
      invoke(() => adapter.handleInput(data), undefined);
      options.afterInput?.();
    },
  };
};
