import { truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import {
  FullScreenKeymap,
  type FullScreenAction,
  type FullScreenKeymapOptions,
  type FullScreenSelectionKeybindingId,
} from "./keymap.ts";

/**
 * Shared modeless hint copy for settings-style lists driven by the full-screen keymap.
 * SettingsList has a single page motion, so `C-u/d` and `PgUp/PgDn` are advertised together
 * rather than as a fake half/full-page distinction.
 */
export const fullScreenSettingsHint = (context: {
  readonly searching: boolean;
  readonly search?: boolean | undefined;
  readonly helpExpanded?: boolean | undefined;
}): string => {
  if (context.searching) return "Type to filter · Enter select · Esc done";
  const filter = context.search ? " · / filter" : "";
  return context.helpExpanded
    ? `j/k or ↑/↓ move · gg/G ends · C-u/d/PgUp/PgDn page${filter} · Enter/l select · h/q/Esc back · ? less`
    : `j/k move · Enter/l select · h/q back${filter} · ? help`;
};

export interface SettingsHintRendererOptions {
  /** Caller-owned dim styling; the renderer itself stays pure. */
  readonly dim: (text: string) => string;
  readonly search?: boolean | undefined;
}

/** Pure `renderHint` factory for settings surfaces sharing the modeless hint copy. */
export const settingsHintRenderer =
  (
    options: SettingsHintRendererOptions,
  ): ((mode: "navigation" | "search", helpExpanded?: boolean) => string) =>
  (mode, helpExpanded) =>
    options.dim(
      ` ${fullScreenSettingsHint({
        searching: mode === "search",
        search: options.search,
        helpExpanded,
      })} `,
    );

export interface VimSettingsAdapterOptions {
  readonly search?: boolean | undefined;
  readonly matchesKeybinding?: FullScreenKeymapOptions["matchesKeybinding"];
  readonly requestRender?: (() => void) | undefined;
  readonly renderHint?:
    | ((mode: "navigation" | "search", helpExpanded?: boolean) => string)
    | undefined;
}

const selectionIdForAction = (
  action: FullScreenAction,
): FullScreenSelectionKeybindingId | undefined => {
  switch (action) {
    case "up":
      return "tui.select.up";
    case "down":
      return "tui.select.down";
    case "full-page-up":
      return "tui.select.pageUp";
    case "full-page-down":
      return "tui.select.pageDown";
    case "confirm":
      return "tui.select.confirm";
    case "cancel":
      return "tui.select.cancel";
    default:
      return undefined;
  }
};

const translatedSettingsInput = (action: FullScreenAction): string | undefined => {
  switch (action) {
    case "up":
      return "\u001b[A";
    case "down":
      return "\u001b[B";
    case "half-page-up":
    case "full-page-up":
      return "\u001b[5~";
    case "half-page-down":
    case "full-page-down":
      return "\u001b[6~";
    case "first":
      return "\u001b[H";
    case "last":
      return "\u001b[F";
    case "confirm":
    case "forward":
      return "\r";
    case "cancel":
    case "back":
    case "quit":
      return "\u001b";
    case "help":
    case "next-pane":
    case "pending-first":
    case "previous-pane":
    case "search":
      return undefined;
  }
};

/**
 * Structural view of the *private* pi-tui SettingsList/SelectList internals the adapter
 * deliberately couples to: `searchInput` (search focus), `submenuComponent` (submenu focus
 * and trailing-blank-line handling), and an optional `focused` field. This is an explicit
 * contract with the pinned pi-tui version; `tests/settings-surface.test.ts` probes the real
 * SettingsList so a pi-tui upgrade that changes these internals fails loudly there.
 */
type SettingsFocusableBridge = {
  focused?: boolean;
  searchInput?: Focusable | undefined;
  submenuComponent?: (Component & Partial<Focusable>) | null | undefined;
};

/** Modal adapter for pi-tui SettingsList/SelectList without changing their global key manager. */
export class VimSettingsAdapter implements Component, Focusable {
  private mode: "navigation" | "search" = "navigation";
  private helpExpanded = false;
  private _focused = false;
  private readonly keymap = new FullScreenKeymap();
  private readonly child: Component;
  private readonly options: VimSettingsAdapterOptions;

  constructor(child: Component, options: VimSettingsAdapterOptions = {}) {
    this.child = child;
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
    const bridge = this.child as Component & SettingsFocusableBridge;
    if ("focused" in bridge) bridge.focused = this._focused;
    if (bridge.searchInput) bridge.searchInput.focused = this._focused && this.mode === "search";
    if (bridge.submenuComponent && "focused" in bridge.submenuComponent)
      bridge.submenuComponent.focused = this._focused;
  }

  handleInput(data: string): void {
    const resolution = this.keymap.resolve(data, {
      mode: this.mode,
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (this.mode === "search") {
      if (resolution?._tag === "Action" && resolution.action === "cancel") {
        this.mode = "navigation";
        this.keymap.resetChord();
      } else if (resolution?._tag === "Action") {
        const id = selectionIdForAction(resolution.action);
        const configured = id && this.options.matchesKeybinding?.(data, id);
        const translated = configured ? data : translatedSettingsInput(resolution.action);
        this.child.handleInput?.(translated ?? data);
        if (resolution.action === "confirm") {
          this.mode = "navigation";
          this.keymap.resetChord();
        }
      } else this.child.handleInput?.(data);
      this.syncChildFocus();
      this.options.requestRender?.();
      return;
    }

    if (resolution?._tag !== "Action") return;
    if (resolution.action === "help") {
      this.helpExpanded = !this.helpExpanded;
      this.options.requestRender?.();
      return;
    }
    if (resolution.action === "search" && this.options.search) {
      this.mode = "search";
      this.helpExpanded = false;
      this.keymap.resetChord();
      this.syncChildFocus();
      this.options.requestRender?.();
      return;
    }
    const id = selectionIdForAction(resolution.action);
    const configured = id && this.options.matchesKeybinding?.(data, id);
    const translated = configured ? data : translatedSettingsInput(resolution.action);
    if (translated !== undefined) this.child.handleInput?.(translated);
    this.syncChildFocus();
    this.options.requestRender?.();
  }

  render(width: number): string[] {
    this.syncChildFocus();
    const lines = [...this.child.render(width)];
    const hint = this.options.renderHint?.(this.mode, this.helpExpanded);
    const bridge = this.child as Component & SettingsFocusableBridge;
    if (hint && bridge.submenuComponent === null && lines.at(-2) === "") lines.pop();
    return hint ? [...lines, truncateToWidth(hint, Math.max(0, width), "")] : lines;
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
    render: (width: number): string[] => invoke(() => container.render(width), []),
    invalidate: (): void => invoke(() => container.invalidate(), undefined),
    handleInput: (data: string): void => {
      invoke(() => adapter.handleInput(data), undefined);
      options.afterInput?.();
    },
  };
};
