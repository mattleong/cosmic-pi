import {
  decodeKittyPrintable,
  isKeyRepeat,
  Key,
  matchesKey,
  type KeyId,
} from "@earendil-works/pi-tui";

export type FullScreenMode = "navigation" | "search" | "text-input" | "confirmation" | "busy";

export type FullScreenSelectionKeybindingId =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "tui.select.confirm"
  | "tui.select.cancel";

export type FullScreenAction =
  | "cancel"
  | "confirm"
  | "up"
  | "down"
  | "half-page-up"
  | "half-page-down"
  | "full-page-up"
  | "full-page-down"
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

/** Decodes raw or Kitty CSI-u printable input; DEL (0x7f) is a control key, never printable. */
export const decodeFullScreenPrintable = (data: string): string | undefined => {
  const printable =
    data.length === 1 && data.charCodeAt(0) >= 32 ? data : decodeKittyPrintable(data);
  return printable !== undefined && printable.charCodeAt(0) === 127 ? undefined : printable;
};

const action = (value: FullScreenAction): FullScreenResolution => ({
  _tag: "Action",
  action: value,
});

const SELECTION_MOTIONS: ReadonlyArray<
  readonly [KeyId, FullScreenAction, FullScreenSelectionKeybindingId?]
> = [
  [Key.up, "up", "tui.select.up"],
  [Key.down, "down", "tui.select.down"],
  [Key.home, "first"],
  [Key.end, "last"],
  [Key.pageUp, "full-page-up", "tui.select.pageUp"],
  [Key.pageDown, "full-page-down", "tui.select.pageDown"],
];

export const FULL_SCREEN_NAVIGATION_SHORTCUTS: ReadonlySet<string> = new Set([
  "g",
  "G",
  "j",
  "k",
  "h",
  "l",
  "/",
  "q",
  "Q",
  "?",
]);

/** Stateful, synchronous resolver for extension-owned full-screen navigation. */
export class FullScreenKeymap {
  private pendingFirst = false;

  resetChord(): void {
    this.pendingFirst = false;
  }

  resolve(data: string, options: FullScreenKeymapOptions): FullScreenResolution | undefined {
    const { mode, matchesKeybinding } = options;
    const printable = decodeFullScreenPrintable(data);
    // Every input ends a pending `gg` chord except a lone `g`, which re-arms it below.
    const pendingFirst = this.pendingFirst;
    this.pendingFirst = false;

    const textOwnsPrintable =
      (mode === "search" || mode === "text-input") && printable !== undefined;
    const sharedActionOwnsPrintable =
      mode === "navigation" &&
      printable !== undefined &&
      FULL_SCREEN_NAVIGATION_SHORTCUTS.has(printable);
    const configured = (id: FullScreenSelectionKeybindingId): boolean =>
      !textOwnsPrintable && !sharedActionOwnsPrintable && Boolean(matchesKeybinding?.(data, id));
    if (
      (mode === "navigation" || mode === "confirmation") &&
      printable !== undefined &&
      options.reservedKeys?.has(printable)
    )
      return isKeyRepeat(data) ? undefined : { _tag: "Shortcut", key: printable };
    if (mode === "confirmation" && isKeyRepeat(data)) return undefined;
    if (matchesKey(data, Key.escape) || configured("tui.select.cancel")) return action("cancel");
    if (mode === "busy") return printable?.toLowerCase() === "q" ? action("quit") : undefined;
    if (mode === "confirmation" && printable?.toLowerCase() === "q") return action("cancel");
    if (matchesKey(data, Key.enter) || configured("tui.select.confirm")) return action("confirm");
    if (mode === "confirmation" || mode === "text-input" || textOwnsPrintable) return undefined;

    for (const [key, motion, id] of SELECTION_MOTIONS)
      if (matchesKey(data, key) || (id !== undefined && configured(id))) return action(motion);
    if (mode === "search") return undefined;

    if (printable === "g") {
      // A held `g` neither completes nor starts the chord.
      if (isKeyRepeat(data)) {
        this.pendingFirst = pendingFirst;
        return undefined;
      }
      this.pendingFirst = !pendingFirst;
      return action(pendingFirst ? "first" : "pending-first");
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
    return undefined;
  }
}

export interface PageSteps {
  readonly page: number;
  readonly half: number;
}

/** Pure page-step arithmetic shared by full-screen list surfaces; both steps are at least 1. */
export const pageSteps = (pageSize: number): PageSteps => {
  const page = Math.max(1, pageSize);
  return { page, half: Math.max(1, Math.floor(page / 2)) };
};
