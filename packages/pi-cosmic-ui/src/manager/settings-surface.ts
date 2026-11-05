import {
  Container,
  getKeybindings,
  Key,
  matchesKey,
  SettingsList,
  Spacer,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type SettingItem,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import type { SettingsOptionDescriptor } from "pi-cosmic-core";
import { focusedField, LIST_CURSOR, managerTone, selectionMarker } from "./style.ts";
import { FullScreenKeymap, type FullScreenKeymapOptions } from "./keymap.ts";
import { clipToWidth, INLINE_SEPARATOR } from "./chrome.ts";
import { keyHint, keyHintBar, moveKeyHint, piSelectHintKeys } from "./key-labels.ts";
import {
  moveSettingsList,
  settingRowAffordance,
  settingsListHint,
  settingsListFocus,
  settingsListMotion,
  settingsSurfaceBridge,
  VimSettingsAdapter,
  type SettingsSurfaceBridgeOptions,
} from "./settings-adapter.ts";

export {
  isBooleanSettingValues,
  settingRowAffordance,
  settingsListHint,
  type SettingsHintOptions,
  type SettingsHintSource,
} from "./settings-adapter.ts";

type SettingsListTheme = ConstructorParameters<typeof SettingsList>[2];

/** Boolean settings read `on`/`off` everywhere; automatic choices read `auto`. */
export const ON_OFF_SETTING_VALUES = ["on", "off"] as const;
export const AUTO_SETTING_VALUE = "auto";

export const settingOnOff = (value: boolean): "on" | "off" => (value ? "on" : "off");

/** An inherited value shows what actually applies: `inherit (on)`. */
export const settingInherited = (effective: string): string => `inherit (${effective})`;

/** Whether a choice is a scope's inherit choice, bare (`inherit`) or naming its value. */
export const isInheritedSettingValue = (value: string): boolean =>
  value === "inherit" ||
  (Fn.pipe(value, Str.startsWith("inherit (")) && Fn.pipe(value, Str.endsWith(")")));

/** Every choice list leads with its inherit choice, then the values a scope can set itself. */
export const inheritChoiceFirst = (values: ReadonlyArray<string>): string[] => [
  ...Arr.filter(values, isInheritedSettingValue),
  ...Arr.filter(values, (value) => !isInheritedSettingValue(value)),
];

// pi-tui appends its own key hint to every SettingsList; the shared surface owns one hint line.
const PI_TUI_SETTINGS_HINT = "Enter/Space to change";
const PI_TUI_SCROLL_POSITION = /^\s*\((\d+)\/(\d+)\)\s*$/u;

const managerSettingsHint = (theme: Theme, text: string): string => {
  if (Fn.pipe(text, Str.includes(PI_TUI_SETTINGS_HINT))) return "";
  const position = PI_TUI_SCROLL_POSITION.exec(text);
  return theme.fg("dim", position ? `  ${position[1] ?? ""} of ${position[2] ?? ""}` : text);
};

export const managerSettingsTheme = (theme: Theme): SettingsListTheme => ({
  label: (text, selected) => (selected ? focusedField(theme, text) : theme.fg("text", text)),
  value: (text, selected) =>
    selected ? focusedField(theme, text) : theme.fg(managerTone.value, text),
  description: (text) => theme.fg("muted", text),
  cursor: theme.fg("accent", `${LIST_CURSOR} `),
  hint: (text) => managerSettingsHint(theme, text),
});

/** The title every settings surface opens with: a blank row, then the title at column 1. */
export const settingsSurfaceHeader = (
  theme: Pick<Theme, "fg" | "bold">,
  title: string,
): Component => new Text(theme.fg("accent", theme.bold(title)), 1, 1);

// Nested titles and descriptions sit in the surface header's column, above the list rows.
const NESTED_TITLE_INDENT = " ";

const nestedTitleLines = (
  theme: SettingsListTheme,
  title: string,
  description: string | undefined,
  width: number,
): string[] => [
  clipToWidth(`${NESTED_TITLE_INDENT}${theme.label(title, false)}`, width, "…"),
  ...(description
    ? Arr.map(
        wrapTextWithAnsi(description, Math.max(1, width - 2)),
        (line) => `${NESTED_TITLE_INDENT}${theme.description(line)}`,
      )
    : []),
];

/**
 * pi-tui clips a long row value without a marker. Knowing the rows, the surface restores the `…`
 * on a value that is a clipped prefix of a row's full value.
 */
const STYLE_RESET = "\u001b[0m";

/** A value listing facts keeps whole facts: `read off · write off · …`, never `edit off ·…`. */
const clipAtFact = (full: string, room: number): string | undefined => {
  const facts = Str.split(full, INLINE_SEPARATOR);
  const ending = `${INLINE_SEPARATOR}…`;
  const leading = Arr.map(facts.slice(0, -1), (_, index) =>
    Arr.join(facts.slice(0, index + 1), INLINE_SEPARATOR),
  );
  const fits = Arr.takeWhile(leading, (prefix) => visibleWidth(`${prefix}${ending}`) <= room);
  return Option.getOrUndefined(Option.map(Arr.last(fits), (prefix) => `${prefix}${ending}`));
};

const withClippedValueMarker = (
  theme: SettingsListTheme,
  items: ReadonlyArray<SettingItem>,
): SettingsListTheme => ({
  ...theme,
  value: (text, selected) => {
    // pi-tui closes a clipped value with a style reset, which never belongs to the value itself.
    const shown = Fn.pipe(text, Str.endsWith(STYLE_RESET))
      ? Fn.pipe(text, Str.slice(0, -STYLE_RESET.length))
      : text;
    if (shown.length <= 1 || Arr.some(items, (item) => item.currentValue === shown))
      return theme.value(text, selected);
    const full = Arr.findFirst(items, (item) => Fn.pipe(item.currentValue, Str.startsWith(shown)));
    if (Option.isNone(full)) return theme.value(text, selected);
    const clipped =
      clipAtFact(full.value.currentValue, visibleWidth(shown)) ??
      `${Fn.pipe(shown, Str.slice(0, -1))}…`;
    return theme.value(clipped, selected);
  },
});

/**
 * `kind: "group"` rows open a nested list (`Enter Open`). A row with a submenu that picks a value
 * should set `kind: "setting"` so Enter reads `Enter Change`.
 *
 * In a `SettingsSession.picker`, a group row may list its rows as `children` instead of building a
 * submenu: the picker opens them as a nested list and saves them like top-level rows. Children
 * given as a function are derived again when the group opens and, while it is open, whenever any
 * save settles or rolls back, keeping the cursor on its row. Rows whose labels or choices depend
 * on another group's values, such as `inherit (16)`, then show that group's latest outcome, so the
 * function must read the owner's current state, including a value restored after a failed save.
 * `summary` supplies the group's value; the surface reads it again whenever it draws, so every
 * group row reflects a save made anywhere in the picker.
 */
export type SettingsSurfaceItem = SettingItem & {
  readonly kind?: "setting" | "group";
  readonly children?:
    | ReadonlyArray<SettingsSurfaceItem>
    | (() => ReadonlyArray<SettingsSurfaceItem>)
    | undefined;
  readonly summary?: (() => string) | undefined;
};

/** Shows each group row's current summary; a summary that throws keeps the row's last value. */
const refreshGroupSummaries = (
  items: ReadonlyArray<SettingsSurfaceItem>,
  update: (id: string, value: string) => void,
): void => {
  for (const item of items) {
    const { summary } = item;
    if (!summary) continue;
    let current: string | undefined;
    try {
      current = summary();
    } catch {
      current = undefined;
    }
    if (current !== undefined && current !== item.currentValue) update(item.id, current);
  }
};

interface SettingsChoiceSubmenuOptions {
  readonly title: string;
  readonly description?: string | undefined;
  /** The choices, or a function the list reads each time it draws so its choices stay live. */
  readonly values: ReadonlyArray<string> | (() => ReadonlyArray<string>);
  /** The marked value, or a function read each time the list draws. */
  readonly current: string | (() => string);
  readonly theme: SettingsListTheme;
  /** Receives the chosen value, or undefined when cancelled or unchanged. */
  readonly done: (value?: string) => void;
  readonly maxVisible?: number | undefined;
}

const CHOICE_MAX_VISIBLE = 10;

/**
 * A single-select list for one setting. Moving through it never persists; Enter chooses and Esc
 * returns without a change.
 */
class SettingsChoiceSubmenu implements Component {
  private readonly options: SettingsChoiceSubmenuOptions;
  private readonly keymap = new FullScreenKeymap();
  private index: number;
  private values: ReadonlyArray<string>;

  constructor(options: SettingsChoiceSubmenuOptions) {
    this.options = options;
    this.values = this.readValues();
    this.index = Math.max(
      0,
      Option.getOrElse(
        Arr.findFirstIndex(this.values, (value) => value === this.current),
        () => 0,
      ),
    );
  }

  private get current(): string {
    const { current } = this.options;
    return Predicate.isFunction(current) ? current() : current;
  }

  private readValues(): ReadonlyArray<string> {
    const { values } = this.options;
    return inheritChoiceFirst(Predicate.isFunction(values) ? values() : values);
  }

  /**
   * Reads the choices again, keeping the cursor on the same choice: by value, or on the inherit
   * choice when only the value it names changed, such as `inherit (8)` becoming `inherit (16)`.
   */
  private sync(): void {
    const previous = this.values[this.index];
    const values = this.readValues();
    this.values = values;
    const found = Option.orElse(
      Arr.findFirstIndex(values, (value) => value === previous),
      () =>
        previous !== undefined && isInheritedSettingValue(previous)
          ? Arr.findFirstIndex(values, isInheritedSettingValue)
          : Option.none(),
    );
    this.index = Option.getOrElse(found, () =>
      Math.max(0, Math.min(this.index, values.length - 1)),
    );
  }

  private get visible(): number {
    return Math.max(1, Math.min(this.options.maxVisible ?? CHOICE_MAX_VISIBLE, this.values.length));
  }

  settingsHint(expanded: boolean): string {
    const keys = piSelectHintKeys();
    return keyHintBar(
      {
        hints: [moveKeyHint(keys.move), keyHint(keys.confirm, "Select")],
        more: [
          keyHint("j/k", "Move"),
          keyHint("gg/G", "Ends"),
          keyHint("PgUp/PgDn", "Page"),
          keyHint("Space/l", "Select"),
        ],
        exit: "nested",
        exitKey: keys.cancel,
        exitAliases: [...keys.cancelAliases, "h", "q"],
      },
      expanded,
    );
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    this.sync();
    const { theme, title, description } = this.options;
    const { values, current } = this;
    const visible = this.visible;
    const start = Math.max(
      0,
      Math.min(this.index - Math.floor(visible / 2), values.length - visible),
    );
    const rows = Arr.map(Arr.take(Arr.drop(values, start), visible), (value, offset) => {
      const selected = start + offset === this.index;
      const prefix = selected ? theme.cursor : "  ";
      const label = `${selectionMarker("single", value === current)} ${value}`;
      return clipToWidth(`${prefix}${theme.label(label, selected)}`, safeWidth, "…");
    });
    const position =
      values.length > visible ? [theme.hint(`  ${this.index + 1} of ${values.length}`)] : [];
    return [...nestedTitleLines(theme, title, description, safeWidth), "", ...rows, ...position];
  }

  handleInput(data: string): void {
    this.sync();
    const resolution = this.keymap.resolve(data, { mode: "navigation" });
    const action = Predicate.isTagged(resolution, "Action") ? resolution.action : undefined;
    const kb = getKeybindings();
    const last = this.values.length - 1;
    const page = this.visible;
    if (kb.matches(data, "tui.select.up") || action === "up")
      this.index = this.index === 0 ? last : this.index - 1;
    else if (kb.matches(data, "tui.select.down") || action === "down")
      this.index = this.index === last ? 0 : this.index + 1;
    else if (kb.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp))
      this.index = Math.max(0, this.index - page);
    else if (kb.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown))
      this.index = Math.min(last, this.index + page);
    else if (matchesKey(data, Key.home) || action === "first") this.index = 0;
    else if (matchesKey(data, Key.end) || action === "last") this.index = last;
    else if (kb.matches(data, "tui.select.confirm") || data === " " || action === "forward") {
      const value = this.values[this.index];
      this.options.done(value === this.current ? undefined : value);
    } else if (kb.matches(data, "tui.select.cancel") || action === "cancel" || action === "back")
      this.options.done(undefined);
  }

  invalidate(): void {}
}

/** A choice list for one setting value, for submenus that pick from a fixed list. */
export const createSettingsChoiceSubmenu = (options: SettingsChoiceSubmenuOptions): Component =>
  new SettingsChoiceSubmenu(options);

// Choice lists this surface gave a row, so a refresh can tell them from an owner's own submenu.
const choiceListSubmenus = new WeakSet<NonNullable<SettingItem["submenu"]>>();

/**
 * A row's choice list reads the row each time it draws, so a refresh that changes the row's values
 * or value shows in a list that is already open.
 */
const withChoiceList = <Item extends SettingItem>(item: Item, theme: SettingsListTheme): Item => {
  if (item.submenu || settingRowAffordance(item) !== "change" || !item.values) return item;
  const submenu: NonNullable<SettingItem["submenu"]> = (_current, done) =>
    createSettingsChoiceSubmenu({
      title: item.label,
      description: item.description,
      values: () => item.values ?? [],
      current: () => item.currentValue,
      theme,
      done,
    });
  choiceListSubmenus.add(submenu);
  item.submenu = submenu;
  return item;
};

/**
 * Gives every multi-valued, non-boolean row a choice list so Enter opens alternatives instead of
 * cycling and saving each one. Booleans keep toggling in place.
 */
export const withSettingChoiceLists = <Item extends SettingItem>(
  items: Item[],
  theme: SettingsListTheme,
): Item[] => {
  for (const item of items) withChoiceList(item, theme);
  return items;
};

/**
 * Updates a shown row from its derived form in place, so an open choice list reading the row stays
 * live. A row with a save still pending keeps the value it shows.
 */
const refreshRow = (
  row: SettingsSurfaceItem,
  fresh: SettingsSurfaceItem,
  keepValue: boolean,
  theme: SettingsListTheme,
): SettingsSurfaceItem => {
  if (row === fresh) return row;
  row.label = fresh.label;
  if (fresh.description === undefined) delete row.description;
  else row.description = fresh.description;
  if (fresh.values === undefined) delete row.values;
  else row.values = [...fresh.values];
  if (!keepValue) row.currentValue = fresh.currentValue;
  if (fresh.submenu) row.submenu = fresh.submenu;
  else if (row.submenu && choiceListSubmenus.has(row.submenu)) delete row.submenu;
  return withChoiceList(row, theme);
};

/** Shown to every open group so it derives its rows again once a save settles anywhere. */
export interface SettingsSaveEvents {
  /** A save settled, showed the value that persisted, or rolled back. */
  readonly settled: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export const settingsSaveEvents = (): SettingsSaveEvents => {
  const listeners = new Set<() => void>();
  return {
    settled: () => {
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export const withoutGroupRowChanges = (
  items: readonly SettingsSurfaceItem[],
  onChange: (id: string, value: string) => void,
): ((id: string, value: string) => void) => {
  const groupIds = new Set(
    Arr.filterMap(items, (item) =>
      item.kind === "group" ? Result.succeed(item.id) : Result.failVoid,
    ),
  );
  return (id, value) => {
    if (!groupIds.has(id)) onChange(id, value);
  };
};

export const settingsItemsFromDescriptors = <Config>(
  descriptors: ReadonlyArray<
    Pick<
      SettingsOptionDescriptor<Config>,
      "id" | "label" | "description" | "currentValue" | "values"
    >
  >,
  config: Config,
): SettingsSurfaceItem[] =>
  Arr.map(descriptors, (descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
    currentValue: descriptor.currentValue(config),
    description: descriptor.description,
    ...(descriptor.values && { values: [...descriptor.values] }),
  }));

interface SettingsGroupSubmenuOptions {
  readonly title: string;
  readonly description?: string | undefined;
  /** The group's rows as they are now; read again whenever a save settles. */
  readonly items: () => SettingsSurfaceItem[];
  /** Saves a row; `show` puts the value that persisted on the row, such as a restored one. */
  readonly onChange: (
    id: string,
    value: string,
    show: (shown: string) => void,
  ) => void | Promise<void>;
  readonly done: (summary?: string) => void;
  readonly summary?: (() => string) | undefined;
  readonly listTheme: SettingsListTheme;
  /** Saves elsewhere in the surface; the open group derives its rows again when one settles. */
  readonly saves?: SettingsSaveEvents | undefined;
}

// The surface adapter replays ends and pages as these keys while a submenu is open.
const groupMotion = (data: string) => {
  if (matchesKey(data, Key.home)) return settingsListMotion("first");
  if (matchesKey(data, Key.end)) return settingsListMotion("last");
  if (matchesKey(data, Key.pageUp)) return settingsListMotion("full-page-up");
  if (matchesKey(data, Key.pageDown)) return settingsListMotion("full-page-down");
  return undefined;
};

class SettingsGroupSubmenu extends Container {
  private readonly options: SettingsGroupSubmenuOptions;
  private readonly list: SettingsList;
  private readonly rows: SettingsSurfaceItem[];
  private readonly saves: SettingsSaveEvents;
  // Rows with a save still in flight keep the value they show until it settles.
  private readonly pending = new Map<string, number>();

  constructor(options: SettingsGroupSubmenuOptions) {
    super();
    this.options = options;
    this.saves = options.saves ?? settingsSaveEvents();
    const rows = withSettingChoiceLists(options.items(), options.listTheme);
    this.rows = rows;
    const notifyChange = withoutGroupRowChanges(rows, (id, value) => this.change(id, value));
    const unsubscribe = this.saves.subscribe(() => this.refresh());
    this.list = new SettingsList(
      rows,
      Math.min(rows.length + 2, 12),
      withClippedValueMarker(options.listTheme, rows),
      notifyChange,
      () => {
        unsubscribe();
        options.done(options.summary?.());
      },
      { enableSearch: false },
    );
    this.addChild({
      render: (width) =>
        nestedTitleLines(options.listTheme, options.title, options.description, width),
      invalidate: () => undefined,
    });
    this.addChild(new Spacer(1));
    this.addChild(this.list);
  }

  settingsHint(expanded: boolean): string {
    return settingsListHint(this.list, { level: "nested", expanded });
  }

  override render(width: number): string[] {
    refreshGroupSummaries(this.rows, (id, value) => this.list.updateValue(id, value));
    return super.render(width);
  }

  handleInput(data: string): void {
    const motion = groupMotion(data);
    if (motion && moveSettingsList(this.list, motion)) return;
    this.list.handleInput(data);
  }

  private change(id: string, value: string): void {
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
    const settle = (): void => {
      const left = (this.pending.get(id) ?? 1) - 1;
      if (left > 0) this.pending.set(id, left);
      else this.pending.delete(id);
      this.saves.settled();
    };
    const show = (shown: string): void => {
      this.list.updateValue(id, shown);
      this.saves.settled();
    };
    try {
      Promise.resolve(this.options.onChange(id, value, show))
        .then(settle, settle)
        .catch(() => undefined);
    } catch {
      settle();
    }
  }

  /**
   * Derives the rows again, values and choices alike, keeping the cursor on the same row. Rows
   * that can't be derived keep the ones shown.
   */
  private refresh(): void {
    let fresh: ReadonlyArray<SettingsSurfaceItem>;
    try {
      fresh = this.options.items();
    } catch {
      return;
    }
    const focus = settingsListFocus(this.list);
    const { listTheme } = this.options;
    const next = Arr.map(fresh, (row) =>
      Option.match(
        Arr.findFirst(this.rows, (shown) => shown.id === row.id),
        {
          onNone: () => withChoiceList({ ...row }, listTheme),
          onSome: (shown) => refreshRow(shown, row, this.pending.has(row.id), listTheme),
        },
      ),
    );
    this.rows.splice(0, this.rows.length, ...next);
    const kept = focus?.id !== undefined && Arr.some(next, (row) => row.id === focus.id);
    const target = kept ? focus?.id : next[Math.min(focus?.index ?? 0, next.length - 1)]?.id;
    if (target !== undefined) this.list.selectItem(target);
  }
}

export const createSettingsGroupSubmenu = (options: SettingsGroupSubmenuOptions): Component =>
  new SettingsGroupSubmenu(options);

/**
 * Saves one row and calls `show` with the value that persisted, so a failed save restores it.
 * A returned Promise lets open groups derive their rows again once the save settles.
 */
export type SettingsRowChange = (
  id: string,
  value: string,
  show: (shown: string) => void,
) => void | Promise<void>;

/**
 * Turns rows that list `children` into group rows (`Enter Open`) whose nested list saves each
 * child through `change`, exactly like a top-level row. Children given as a function are derived
 * again when the group opens and whenever a save made anywhere in the surface settles, shows its
 * value, or rolls back, so pass `saves` shared with the surface's top-level changes.
 */
export const withSettingsGroupChildren = (
  items: ReadonlyArray<SettingsSurfaceItem>,
  listTheme: SettingsListTheme,
  change: SettingsRowChange,
  saves: SettingsSaveEvents = settingsSaveEvents(),
): SettingsSurfaceItem[] =>
  Arr.map(items, (item): SettingsSurfaceItem => {
    const { children } = item;
    if (!children) return item;
    const copy = (source: ReadonlyArray<SettingsSurfaceItem>) =>
      Arr.map(source, (child): SettingsSurfaceItem => ({ ...child }));
    // Fixed rows persist what each save showed; derived rows come from the owner's current state.
    let rows = Predicate.isFunction(children) ? [] : copy(children);
    const derive = (): SettingsSurfaceItem[] => {
      if (!Predicate.isFunction(children)) return rows;
      try {
        rows = copy(children());
      } catch {
        // Rows that can't be derived again keep the ones last shown.
      }
      return rows;
    };
    return {
      ...item,
      kind: "group",
      submenu: (_value, done) =>
        createSettingsGroupSubmenu({
          title: item.label,
          description: item.description,
          items: derive,
          onChange: change,
          done,
          summary: item.summary,
          listTheme,
          saves,
        }),
    };
  });

interface SettingsListSurfaceOptions {
  readonly header: Component;
  readonly items: SettingsSurfaceItem[];
  readonly height: number;
  readonly listTheme: SettingsListTheme;
  readonly onChange: (id: string, value: string, list: SettingsList) => void;
  readonly onCancel: () => void;
  readonly matchesKeybinding: FullScreenKeymapOptions["matchesKeybinding"];
  readonly requestRender: () => void;
  readonly dim: (text: string) => string;
  readonly bridge: SettingsSurfaceBridgeOptions;
}

export const createSettingsListSurface = (options: SettingsListSurfaceOptions) => {
  const container = new Container();
  container.addChild(options.header);
  // Group rows read their summaries as they draw, so a save in any group shows in all of them.
  const surface: Component = {
    render: (width) => {
      refreshGroupSummaries(options.items, (id, value) => list.updateValue(id, value));
      return container.render(width);
    },
    invalidate: () => container.invalidate(),
  };
  const list: SettingsList = new SettingsList(
    withSettingChoiceLists(options.items, options.listTheme),
    options.height,
    withClippedValueMarker(options.listTheme, options.items),
    withoutGroupRowChanges(options.items, (id, value) => options.onChange(id, value, list)),
    options.onCancel,
    { enableSearch: true },
  );
  const adapter = new VimSettingsAdapter(list, {
    matchesKeybinding: options.matchesKeybinding,
    requestRender: options.requestRender,
    styleHint: options.dim,
    filterable: true,
  });
  container.addChild(adapter);
  return { list, surface: settingsSurfaceBridge(adapter, surface, options.bridge) };
};
