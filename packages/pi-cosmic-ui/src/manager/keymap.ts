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
  readonly reservedKeys?: ReadonlySet<string> | undefined;
}

export const decodeFullScreenPrintable = (data: string): string | undefined => {
  const printable =
    data.length === 1 && data.charCodeAt(0) >= 32 ? data : decodeKittyPrintable(data);
  return printable?.charCodeAt(0) === 127 ? undefined : printable;
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

const NAVIGATION_KEYS: ReadonlyArray<readonly [FullScreenAction, ReadonlyArray<string>, KeyId?]> = [
  ["last", ["G"]],
  ["up", ["k"]],
  ["down", ["j"]],
  ["previous-pane", [], Key.shift("tab")],
  ["next-pane", [], Key.tab],
  ["back", ["h"], Key.left],
  ["forward", ["l"], Key.right],
  ["half-page-up", [], Key.ctrl("u")],
  ["half-page-down", [], Key.ctrl("d")],
  ["search", ["/"]],
  ["quit", ["q", "Q"]],
  ["help", ["?"]],
];

interface KeyInput {
  readonly data: string;
  readonly printable: string | undefined;
  readonly configured: (id: FullScreenSelectionKeybindingId) => boolean;
}

const keyInput = (data: string, options: FullScreenKeymapOptions): KeyInput => {
  const { mode, matchesKeybinding } = options;
  const printable = decodeFullScreenPrintable(data);
  const textOwnsPrintable = (mode === "search" || mode === "text-input") && printable !== undefined;
  const sharedActionOwnsPrintable =
    mode === "navigation" &&
    printable !== undefined &&
    FULL_SCREEN_NAVIGATION_SHORTCUTS.has(printable);
  return {
    data,
    printable,
    configured: (id) =>
      !textOwnsPrintable && !sharedActionOwnsPrintable && Boolean(matchesKeybinding?.(data, id)),
  };
};

const isReserved = (
  { printable }: KeyInput,
  reservedKeys: ReadonlySet<string> | undefined,
): boolean => printable !== undefined && reservedKeys?.has(printable) === true;

const shortcut = ({ data, printable }: KeyInput): FullScreenResolution | undefined =>
  printable === undefined || isKeyRepeat(data) ? undefined : { _tag: "Shortcut", key: printable };

const cancels = ({ data, configured }: KeyInput): boolean =>
  matchesKey(data, Key.escape) || configured("tui.select.cancel");

const confirms = ({ data, configured }: KeyInput): boolean =>
  matchesKey(data, Key.enter) || configured("tui.select.confirm");

const selectionMotion = ({ data, configured }: KeyInput): FullScreenResolution | undefined => {
  for (const [key, motion, id] of SELECTION_MOTIONS)
    if (matchesKey(data, key) || (id !== undefined && configured(id))) return action(motion);
  return undefined;
};

const navigationKey = ({ data, printable }: KeyInput): FullScreenResolution | undefined => {
  for (const [motion, printables, key] of NAVIGATION_KEYS)
    if (
      (printable !== undefined && printables.includes(printable)) ||
      (key !== undefined && matchesKey(data, key))
    )
      return action(motion);
  return undefined;
};

const resolveConfirmation = (
  input: KeyInput,
  reservedKeys: ReadonlySet<string> | undefined,
): FullScreenResolution | undefined => {
  if (isReserved(input, reservedKeys)) return shortcut(input);
  if (isKeyRepeat(input.data)) return undefined;
  if (cancels(input) || input.printable?.toLowerCase() === "q") return action("cancel");
  return confirms(input) ? action("confirm") : undefined;
};

const resolveBusy = (input: KeyInput): FullScreenResolution | undefined => {
  if (cancels(input)) return action("cancel");
  return input.printable?.toLowerCase() === "q" ? action("quit") : undefined;
};

const resolveTextInput = (input: KeyInput): FullScreenResolution | undefined => {
  if (cancels(input)) return action("cancel");
  return confirms(input) ? action("confirm") : undefined;
};

const resolveSearch = (input: KeyInput): FullScreenResolution | undefined => {
  if (cancels(input)) return action("cancel");
  if (confirms(input)) return action("confirm");
  return input.printable === undefined ? selectionMotion(input) : undefined;
};

const MODE_RESOLVERS = {
  confirmation: resolveConfirmation,
  busy: resolveBusy,
  "text-input": resolveTextInput,
  search: resolveSearch,
} satisfies Record<
  Exclude<FullScreenMode, "navigation">,
  (
    input: KeyInput,
    reservedKeys: ReadonlySet<string> | undefined,
  ) => FullScreenResolution | undefined
>;

export class FullScreenKeymap {
  private pendingFirst = false;

  resetChord(): void {
    this.pendingFirst = false;
  }

  resolve(data: string, options: FullScreenKeymapOptions): FullScreenResolution | undefined {
    const pendingFirst = this.pendingFirst;
    this.pendingFirst = false;
    const input = keyInput(data, options);
    if (options.mode === "navigation")
      return this.resolveNavigation(input, options.reservedKeys, pendingFirst);
    return MODE_RESOLVERS[options.mode](input, options.reservedKeys);
  }

  private resolveNavigation(
    input: KeyInput,
    reservedKeys: ReadonlySet<string> | undefined,
    pendingFirst: boolean,
  ): FullScreenResolution | undefined {
    if (isReserved(input, reservedKeys)) return shortcut(input);
    if (cancels(input)) return action("cancel");
    if (confirms(input)) return action("confirm");
    const motion = selectionMotion(input);
    if (motion) return motion;
    return input.printable === "g"
      ? this.firstChord(input.data, pendingFirst)
      : navigationKey(input);
  }

  private firstChord(data: string, pendingFirst: boolean): FullScreenResolution | undefined {
    if (isKeyRepeat(data)) {
      this.pendingFirst = pendingFirst;
      return undefined;
    }
    this.pendingFirst = !pendingFirst;
    return action(pendingFirst ? "first" : "pending-first");
  }
}

export interface PageSteps {
  readonly page: number;
  readonly half: number;
}

export const pageSteps = (pageSize: number): PageSteps => {
  const page = Math.max(1, pageSize);
  return { page, half: Math.max(1, Math.floor(page / 2)) };
};
