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
export const fullScreenSettingsHint = (context: {
  readonly searching: boolean;
  readonly helpExpanded?: boolean | undefined;
  /** Configured key labels; Pi's defaults are shown without it. */
  readonly keybindingLabel?:
    | ((id: FullScreenSelectionKeybindingId, fallback: string) => string)
    | undefined;
}): string => {
  const key = (id: FullScreenSelectionKeybindingId, fallback: string) =>
    context.keybindingLabel?.(id, fallback) || fallback;
  const enter = key("tui.select.confirm", "Enter");
  const escape = key("tui.select.cancel", "Esc");
  if (context.searching) return `Type to filter · ${enter} Select · ${escape} Done`;
  return context.helpExpanded
    ? `j/k or ${key("tui.select.up", "↑")}/${key("tui.select.down", "↓")} Move · gg/G Ends · C-u/d/PgUp/PgDn Page · / Filter · ${enter}/l Select · h/q/${escape} Back · ? Less`
    : `j/k Move · ${enter}/l Select · h/q Back · / Filter · ? More`;
};

export interface VimSettingsAdapterOptions {
  readonly matchesKeybinding?: FullScreenKeymapOptions["matchesKeybinding"];
  readonly requestRender?: (() => void) | undefined;
  readonly renderHint?:
    | ((mode: "navigation" | "search", helpExpanded?: boolean) => string)
    | undefined;
}

/** Raw SettingsList input and configured selection id each full-screen action forwards as. */
const SETTINGS_ACTION_INPUT = {
  up: { input: "\u001b[A", id: "tui.select.up" },
  down: { input: "\u001b[B", id: "tui.select.down" },
  "half-page-up": { input: "\u001b[5~", id: undefined },
  "full-page-up": { input: "\u001b[5~", id: "tui.select.pageUp" },
  "half-page-down": { input: "\u001b[6~", id: undefined },
  "full-page-down": { input: "\u001b[6~", id: "tui.select.pageDown" },
  first: { input: "\u001b[H", id: undefined },
  last: { input: "\u001b[F", id: undefined },
  confirm: { input: "\r", id: "tui.select.confirm" },
  forward: { input: "\r", id: undefined },
  cancel: { input: "\u001b", id: "tui.select.cancel" },
  back: { input: "\u001b", id: undefined },
  quit: { input: "\u001b", id: undefined },
  help: { input: undefined, id: undefined },
  "next-pane": { input: undefined, id: undefined },
  "pending-first": { input: undefined, id: undefined },
  "previous-pane": { input: undefined, id: undefined },
  search: { input: undefined, id: undefined },
} satisfies Record<
  FullScreenAction,
  {
    readonly input: string | undefined;
    readonly id: FullScreenSelectionKeybindingId | undefined;
  }
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
    const { input, id } = SETTINGS_ACTION_INPUT[action];
    return id && this.options.matchesKeybinding?.(data, id) ? data : input;
  }

  handleInput(data: string): void {
    const resolution = this.keymap.resolve(data, {
      mode: this.mode,
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (this.mode === "search") {
      if (resolution?._tag === "Action" && resolution.action === "cancel") {
        // Esc leaves search without forwarding a close to the child; the typed filter is
        // cleared and re-applied so it cannot keep filtering the list invisibly.
        this.mode = "navigation";
        this.keymap.resetChord();
        this.child.searchInput?.setValue("");
        this.child.applyFilter?.("");
      } else if (resolution?._tag === "Action") {
        this.child.handleInput?.(this.forwardSelection(data, resolution.action) ?? data);
        if (resolution.action === "confirm") {
          this.mode = "navigation";
          this.keymap.resetChord();
        }
      } else this.child.handleInput?.(data);
      this.syncChildFocus();
      this.options.requestRender?.();
      return;
    }

    if (resolution?._tag !== "Action") {
      if (decodeFullScreenPrintable(data) === " ") {
        this.child.handleInput?.(" ");
        this.syncChildFocus();
        this.options.requestRender?.();
      }
      return;
    }
    if (resolution.action === "help") {
      this.helpExpanded = !this.helpExpanded;
      this.options.requestRender?.();
      return;
    }
    if (resolution.action === "search") {
      this.mode = "search";
      this.helpExpanded = false;
      this.keymap.resetChord();
      this.syncChildFocus();
      this.options.requestRender?.();
      return;
    }
    const translated = this.forwardSelection(data, resolution.action);
    if (translated !== undefined) this.child.handleInput?.(translated);
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
