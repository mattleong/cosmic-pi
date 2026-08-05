import {
  decodeKittyPrintable,
  isKeyRepeat,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type KeyId,
} from "@earendil-works/pi-tui";

export type FullScreenMode = "navigation" | "search" | "text-input" | "confirmation" | "busy";

export type FullScreenSelectionKeybindingId =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.confirm"
  | "tui.select.cancel";

export type FullScreenAction =
  | "cancel"
  | "confirm"
  | "up"
  | "down"
  | "half-page-up"
  | "half-page-down"
  | "first"
  | "last"
  | "back"
  | "forward"
  | "previous-pane"
  | "next-pane"
  | "search"
  | "quit"
  | "help"
  | "pending-first";

export type FullScreenResolution =
  | { readonly _tag: "Action"; readonly action: FullScreenAction }
  | { readonly _tag: "Shortcut"; readonly key: string };

export interface FullScreenKeymapOptions {
  readonly mode: FullScreenMode;
  readonly matchesKeybinding?:
    | ((data: string, id: FullScreenSelectionKeybindingId) => boolean)
    | undefined;
  /** Screen-owned printable commands that must remain reachable before configured movement keys. */
  readonly reservedKeys?: ReadonlySet<string> | undefined;
}

export const decodeFullScreenPrintable = (data: string): string | undefined =>
  data.length === 1 && data.charCodeAt(0) >= 32 ? data : decodeKittyPrintable(data);

const action = (value: FullScreenAction): FullScreenResolution => ({
  _tag: "Action",
  action: value,
});

const configuredMatch = (
  data: string,
  id: FullScreenSelectionKeybindingId,
  matchesKeybinding: FullScreenKeymapOptions["matchesKeybinding"],
): boolean => Boolean(matchesKeybinding?.(data, id));

const selectionMatch = (
  data: string,
  id: FullScreenSelectionKeybindingId,
  key: KeyId,
  matchesKeybinding: FullScreenKeymapOptions["matchesKeybinding"],
): boolean => configuredMatch(data, id, matchesKeybinding) || matchesKey(data, key);

/** Stateful, synchronous resolver for extension-owned full-screen navigation. */
export class FullScreenKeymap {
  private pendingFirst = false;

  resetChord(): void {
    this.pendingFirst = false;
  }

  resolve(data: string, options: FullScreenKeymapOptions): FullScreenResolution | undefined {
    const { mode, matchesKeybinding } = options;
    const printable = decodeFullScreenPrintable(data);

    const textOwnsPrintable =
      (mode === "search" || mode === "text-input") && printable !== undefined;
    if (
      (mode === "navigation" || mode === "confirmation") &&
      printable !== undefined &&
      options.reservedKeys?.has(printable)
    ) {
      this.resetChord();
      return isKeyRepeat(data) ? undefined : { _tag: "Shortcut", key: printable };
    }
    if (
      matchesKey(data, Key.escape) ||
      (!textOwnsPrintable && configuredMatch(data, "tui.select.cancel", matchesKeybinding))
    ) {
      this.resetChord();
      return action("cancel");
    }

    if (mode === "busy") return undefined;

    if (mode === "confirmation") {
      this.resetChord();
      if (printable?.toLowerCase() === "q") return action("cancel");
      return selectionMatch(data, "tui.select.confirm", Key.enter, matchesKeybinding)
        ? action("confirm")
        : undefined;
    }

    if (
      matchesKey(data, Key.enter) ||
      (!textOwnsPrintable && configuredMatch(data, "tui.select.confirm", matchesKeybinding))
    ) {
      this.resetChord();
      return action("confirm");
    }

    if (mode === "text-input" || textOwnsPrintable) {
      this.resetChord();
      return undefined;
    }

    if (selectionMatch(data, "tui.select.up", Key.up, matchesKeybinding)) {
      this.resetChord();
      return action("up");
    }
    if (selectionMatch(data, "tui.select.down", Key.down, matchesKeybinding)) {
      this.resetChord();
      return action("down");
    }

    if (matchesKey(data, Key.home)) {
      this.resetChord();
      return action("first");
    }
    if (matchesKey(data, Key.end)) {
      this.resetChord();
      return action("last");
    }

    if (mode === "search") {
      this.resetChord();
      return undefined;
    }

    if (this.pendingFirst && printable === "g" && isKeyRepeat(data)) return undefined;
    if (this.pendingFirst) {
      this.pendingFirst = false;
      if (printable === "g") return action("first");
    }

    if (printable === "g") {
      if (isKeyRepeat(data)) return undefined;
      this.pendingFirst = true;
      return action("pending-first");
    }
    if (printable === "G") return action("last");
    if (printable === "k") return action("up");
    if (printable === "j") return action("down");
    if (matchesKey(data, Key.shift("tab"))) return action("previous-pane");
    if (matchesKey(data, Key.tab)) return action("next-pane");
    if (printable === "h" || matchesKey(data, Key.left)) return action("back");
    if (printable === "l" || matchesKey(data, Key.right)) return action("forward");
    if (matchesKey(data, Key.ctrl("u"))) return action("half-page-up");
    if (matchesKey(data, Key.ctrl("d"))) return action("half-page-down");
    if (printable === "/") return action("search");
    if (printable?.toLowerCase() === "q") return action("quit");
    if (printable === "?") return action("help");

    this.resetChord();
    return undefined;
  }
}

const SPECIAL_KEY_LABELS: Readonly<Record<string, string>> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  enter: "Enter",
  escape: "Esc",
  pageUp: "PgUp",
  pageDown: "PgDn",
  home: "Home",
  end: "End",
  tab: "Tab",
  space: "Space",
};

export const formatFullScreenKeyId = (value: string): string => {
  const parts = value.split("+");
  const base = parts.pop() ?? value;
  const modifiers = parts
    .map((part) => (part === "ctrl" ? "C-" : part === "shift" ? "⇧" : part === "alt" ? "A-" : "⌘"))
    .join("");
  const label = SPECIAL_KEY_LABELS[base] ?? base;
  return `${modifiers}${parts.includes("shift") && base.length === 1 ? label.toUpperCase() : label}`;
};

export const fullScreenKeybindingLabel = (
  id: FullScreenSelectionKeybindingId,
  fallback: string,
  getKeys?: ((id: FullScreenSelectionKeybindingId) => ReadonlyArray<string>) | undefined,
): string => getKeys?.(id).map(formatFullScreenKeyId).join("/") || fallback;

export interface VimSettingsAdapterOptions {
  readonly search?: boolean | undefined;
  readonly matchesKeybinding?: FullScreenKeymapOptions["matchesKeybinding"];
  readonly requestRender?: (() => void) | undefined;
  readonly renderHint?: ((mode: "navigation" | "search") => string) | undefined;
}

const selectionIdForAction = (
  action: FullScreenAction,
): FullScreenSelectionKeybindingId | undefined => {
  switch (action) {
    case "up":
      return "tui.select.up";
    case "down":
      return "tui.select.down";
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
      return "\u001b[5~";
    case "half-page-down":
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

type SettingsFocusableBridge = {
  focused?: boolean;
  searchInput?: Focusable | undefined;
  submenuComponent?: (Component & Partial<Focusable>) | null | undefined;
};

/** Modal adapter for pi-tui SettingsList/SelectList without changing their global key manager. */
export class VimSettingsAdapter implements Component, Focusable {
  private mode: "navigation" | "search" = "navigation";
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
    if (resolution.action === "search" && this.options.search) {
      this.mode = "search";
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
    const hint = this.options.renderHint?.(this.mode);
    const bridge = this.child as Component & SettingsFocusableBridge;
    if (hint && bridge.submenuComponent === null && lines.at(-2) === "") lines.pop();
    return hint ? [...lines, truncateToWidth(hint, Math.max(0, width), "")] : lines;
  }

  invalidate(): void {
    this.child.invalidate();
  }
}
