import { visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { ForeignCallable } from "pi-cosmic-core/schema/foreign-callable";
import { invokeBestEffort, invokeHostCallback } from "pi-cosmic-core/host-session";
import {
  decodeFullScreenPrintable,
  FullScreenKeymap,
  type FullScreenAction,
  type FullScreenKeymapOptions,
  type FullScreenSelectionKeybindingId,
} from "./keymap.ts";
import { clipToWidth } from "./chrome.ts";
import {
  joinKeyHints,
  keyHint,
  keyHintBar,
  moveKeyHint,
  keyHintRows,
  piSelectHintKeys,
  settingAffordanceHint,
  type KeyHintBar,
  type SettingAffordance,
} from "./key-labels.ts";

/** A settings row as the shared surface reads it, independent of pi-tui's private fields. */
const SettingRowShape = Schema.Struct({
  kind: Schema.optional(Schema.String),
  values: Schema.optional(Schema.Array(Schema.String)),
  submenu: Schema.optional(Schema.Unknown),
});
type SettingRowShape = typeof SettingRowShape.Type;
const isSettingRow = Schema.is(SettingRowShape);

// pi-tui keeps selection private; the shared surface reads it only to label Enter honestly.
const SettingsListSelection = Schema.Struct({
  selectedIndex: Schema.Int,
  filteredItems: Schema.Array(Schema.Unknown),
});
const decodeSettingsListSelection = Schema.decodeUnknownOption(SettingsListSelection);

const BOOLEAN_VALUE_SETS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["on", "off"]),
  new Set(["true", "false"]),
];

export const isBooleanSettingValues = (values: ReadonlyArray<string>): boolean =>
  values.length === 2 &&
  Arr.some(BOOLEAN_VALUE_SETS, (set) => Arr.every(values, (value) => set.has(value)));

/** Booleans toggle in place, other value lists open a choice list, and submenus open. */
export const settingRowAffordance = (row: SettingRowShape): SettingAffordance | undefined => {
  const values = row.values ?? [];
  if (isBooleanSettingValues(values)) return "toggle";
  if (values.length > 1) return "change";
  if (row.submenu === undefined) return undefined;
  return row.kind === "setting" ? "change" : "open";
};

// Any open submenu; `settingsHint` is optional and lets the submenu own the hint line.
const SettingsSubmenu = Schema.Struct({
  settingsHint: Schema.optional(ForeignCallable<[expanded: boolean]>()),
});
type SettingsSubmenu = typeof SettingsSubmenu.Type;
const isSettingsSubmenu = Schema.is(SettingsSubmenu);

const openSettingsSubmenu = (list: Component): SettingsSubmenu | undefined => {
  const submenu = "submenuComponent" in list ? list.submenuComponent : undefined;
  return isSettingsSubmenu(submenu) ? submenu : undefined;
};

const decodeHintText = Schema.decodeUnknownOption(Schema.String);

interface SettingsListPosition {
  readonly index: number;
  readonly count: number;
  readonly row: SettingRowShape | undefined;
}

const settingsListPosition = (list: Component): SettingsListPosition | undefined =>
  Option.getOrUndefined(
    Option.map(decodeSettingsListSelection(list), ({ selectedIndex, filteredItems }) => {
      const row = filteredItems[selectedIndex];
      return {
        index: selectedIndex,
        count: filteredItems.length,
        row: isSettingRow(row) ? row : undefined,
      };
    }),
  );

const SettingRowId = Schema.Struct({ id: Schema.String });
const isSettingRowWithId = Schema.is(SettingRowId);

/** Where a list's cursor is: its row index and that row's id, so a refresh can keep it there. */
export const settingsListFocus = (
  list: Component,
): { readonly index: number; readonly id: string | undefined } | undefined =>
  Option.getOrUndefined(
    Option.map(decodeSettingsListSelection(list), ({ selectedIndex, filteredItems }) => {
      const row = filteredItems[selectedIndex];
      return { index: selectedIndex, id: isSettingRowWithId(row) ? row.id : undefined };
    }),
  );

/** The level whose Esc this hint describes: `top` closes the surface, `nested` goes back. */
export interface SettingsHintOptions {
  readonly level: "top" | "nested";
  readonly expanded: boolean;
  readonly searching?: boolean | undefined;
  /** A filter is applied after typing ended; Esc clears it before it closes the surface. */
  readonly filtered?: boolean | undefined;
  readonly filterable?: boolean | undefined;
}

/**
 * A component shown inside a settings surface may implement `settingsHint(expanded)` to own the
 * single hint line while it is active. Components without it get a generic nested hint.
 */
export interface SettingsHintSource {
  readonly settingsHint: (expanded: boolean) => string;
}

// Pi's select keys drive pi-tui lists, so their configured cancel aliases (`C-c`) join the exit.
const genericSubmenuHint = (): KeyHintBar => {
  const keys = piSelectHintKeys();
  return {
    hints: [moveKeyHint(keys.move), keyHint(keys.confirm, "Select")],
    more: [keyHint("j/k", "Move")],
    exit: "nested",
    exitKey: keys.cancel,
    exitAliases: [...keys.cancelAliases, "h", "q"],
  };
};

const submenuHint = (submenu: SettingsSubmenu, expanded: boolean): string => {
  const callback = submenu.settingsHint;
  if (!callback) return keyHintBar(genericSubmenuHint(), expanded);
  const hint = invokeHostCallback<unknown>(() => callback.call(submenu, expanded), "");
  return Option.getOrElse(decodeHintText(hint), () => "");
};

/** The single hint line for a pi-tui `SettingsList`, delegating to an open submenu. */
export const settingsListHint = (list: Component, options: SettingsHintOptions): string => {
  const submenu = openSettingsSubmenu(list);
  if (submenu) return submenuHint(submenu, options.expanded);
  const row = settingsListPosition(list)?.row;
  const affordance = row && settingRowAffordance(row);
  const enter = affordance && settingAffordanceHint(affordance);
  const keys = piSelectHintKeys();
  const move = moveKeyHint(keys.move);
  if (options.searching)
    return joinKeyHints(["Type to filter", move, enter, keyHint(keys.cancel, "Clear")]);
  if (options.filtered)
    return keyHintBar(
      {
        hints: [move, enter, keyHint("/", "Filter"), keyHint(keys.cancel, "Clear")],
        more: [keyHint("j/k", "Move"), keyHint("gg/G", "Ends"), keyHint("q", "Close")],
      },
      options.expanded,
    );
  return keyHintBar(
    {
      hints: [move, enter, options.filterable === true && keyHint("/", "Filter")],
      more: [
        keyHint("j/k", "Move"),
        keyHint("gg/G", "Ends"),
        keyHint("PgUp/PgDn/C-u/C-d", "Page"),
        affordance && settingAffordanceHint(affordance, "Space/l"),
      ],
      exit: options.level,
      exitKey: keys.cancel,
      exitAliases: [...keys.cancelAliases, "h", "q"],
    },
    options.expanded,
  );
};

type SettingsListMotion = "first" | "last" | "page-up" | "page-down";

const MOTION_ACTIONS: Partial<Record<FullScreenAction, SettingsListMotion>> = {
  first: "first",
  last: "last",
  "half-page-up": "page-up",
  "full-page-up": "page-up",
  "half-page-down": "page-down",
  "full-page-down": "page-down",
};

const SETTINGS_PAGE_ROWS = 8;
const UP = "\u001b[A";
const DOWN = "\u001b[B";

/**
 * pi-tui's SettingsList only understands single-row moves, so ends and pages are replayed as
 * row moves. Returns false when the list's position can't be read.
 */
export const moveSettingsList = (
  list: Component,
  motion: SettingsListMotion,
  pageRows = SETTINGS_PAGE_ROWS,
): boolean => {
  const position = settingsListPosition(list);
  if (!position || position.count === 0) return false;
  const last = position.count - 1;
  const target = Match.value(motion).pipe(
    Match.when("first", () => 0),
    Match.when("last", () => last),
    Match.when("page-up", () => Math.max(0, position.index - pageRows)),
    Match.when("page-down", () => Math.min(last, position.index + pageRows)),
    Match.exhaustive,
  );
  const step = target < position.index ? UP : DOWN;
  for (let moved = 0; moved < Math.abs(target - position.index); moved++) list.handleInput?.(step);
  return true;
};

export const settingsListMotion = (action: FullScreenAction): SettingsListMotion | undefined =>
  MOTION_ACTIONS[action];

/** Drops blank rows a child leaves where its own hint used to be. */
export const trimTrailingBlankLines = (lines: ReadonlyArray<string>): string[] => {
  let end = lines.length;
  while (end > 0 && visibleWidth(lines[end - 1] ?? "") === 0) end--;
  return Arr.take(lines, end);
};

export interface VimSettingsAdapterOptions {
  readonly matchesKeybinding?: FullScreenKeymapOptions["matchesKeybinding"];
  readonly requestRender?: (() => void) | undefined;
  /** Styles the single hint line; omit to render no hint. */
  readonly styleHint?: ((hint: string) => string) | undefined;
  /** Whether `/` filtering is available at the top level. */
  readonly filterable?: boolean | undefined;
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

const isTextCallback = Schema.is(ForeignCallable<[text: string]>());

const settingsSearchInput = (child: Component) => {
  if (!("searchInput" in child)) return undefined;
  const input = child.searchInput;
  return Predicate.isObject(input) ? input : undefined;
};

const isValueGetter = Schema.is(ForeignCallable<[]>());

/** The child's filter text, or none when it has no readable filter input. */
const searchFilterText = (child: Component): Option.Option<string> => {
  const input = settingsSearchInput(child);
  const getValue = input?.getValue;
  if (!isValueGetter(getValue)) return Option.none();
  return decodeHintText(invokeHostCallback<unknown>(() => getValue.call(input), undefined));
};

// An idle, empty filter prompt is noise; the hint advertises `/ Filter` instead.
const hasEmptySearchInput = (child: Component): boolean =>
  Option.contains(searchFilterText(child), "");

const hasAppliedFilter = (child: Component): boolean =>
  Option.exists(searchFilterText(child), Str.isNonEmpty);

const clearSettingsFilter = (child: Component): void => {
  const input = settingsSearchInput(child);
  const setValue = input?.setValue;
  if (isTextCallback(setValue)) invokeBestEffort(() => setValue.call(input, ""));
  const applyFilter = "applyFilter" in child ? child.applyFilter : undefined;
  if (isTextCallback(applyFilter)) invokeBestEffort(() => applyFilter.call(child, ""));
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
    const submenu = openSettingsSubmenu(child);
    if (submenu && "focused" in submenu) submenu.focused = this.hasFocus;
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

  // A filter left applied after typing ends is cleared by Esc before Esc closes the surface.
  private filterApplied(): boolean {
    return openSettingsSubmenu(this.child) === undefined && hasAppliedFilter(this.child);
  }

  private handleNavigationInput(data: string, action: FullScreenAction | undefined): boolean {
    if (action === "help") this.helpExpanded = !this.helpExpanded;
    else if (action === "cancel" && this.filterApplied()) {
      clearSettingsFilter(this.child);
      this.helpExpanded = false;
    } else if (action === "search") {
      this.mode = "search";
      this.helpExpanded = false;
      this.keymap.resetChord();
    } else if (action !== undefined) {
      const motion = settingsListMotion(action);
      if (
        motion &&
        openSettingsSubmenu(this.child) === undefined &&
        moveSettingsList(this.child, motion)
      )
        return true;
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
    const { styleHint } = this.options;
    // Resolve the hint first: an open submenu may sync its own help state from it.
    const hint = styleHint
      ? settingsListHint(this.child, {
          level: "top",
          expanded: this.helpExpanded,
          searching: this.mode === "search",
          filtered: this.mode === "navigation" && this.filterApplied(),
          filterable: this.options.filterable,
        })
      : "";
    const rendered = this.child.render(safeWidth);
    const idleSearch =
      this.mode === "navigation" &&
      openSettingsSubmenu(this.child) === undefined &&
      hasEmptySearchInput(this.child);
    const lines = trimTrailingBlankLines(
      Arr.map(idleSearch ? Arr.drop(rendered, 2) : rendered, (line) =>
        clipToWidth(line, safeWidth, ""),
      ),
    );
    if (!styleHint) return lines;
    // The trailing blank row keeps the surface off whatever Pi renders below it, such as the footer.
    return hint ? [...lines, "", ...keyHintRows(hint, safeWidth, styleHint), ""] : [...lines, ""];
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
        () => Arr.map(container.render(safeWidth), (line) => clipToWidth(line, safeWidth, "")),
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
