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
import { keyHint, keyHintBar, moveKeyHint } from "./key-labels.ts";
import {
  moveSettingsList,
  settingRowAffordance,
  settingsListHint,
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
 * submenu: the picker opens them as a nested list and saves them like top-level rows. `summary`
 * supplies the group's value after the nested list closes.
 */
export type SettingsSurfaceItem = SettingItem & {
  readonly kind?: "setting" | "group";
  readonly children?: ReadonlyArray<SettingsSurfaceItem> | undefined;
  readonly summary?: (() => string) | undefined;
};

interface SettingsChoiceSubmenuOptions {
  readonly title: string;
  readonly description?: string | undefined;
  readonly values: ReadonlyArray<string>;
  readonly current: string;
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

  constructor(options: SettingsChoiceSubmenuOptions) {
    this.options = options;
    this.index = Math.max(
      0,
      Option.getOrElse(
        Arr.findFirstIndex(options.values, (value) => value === options.current),
        () => 0,
      ),
    );
  }

  private get visible(): number {
    return Math.max(
      1,
      Math.min(this.options.maxVisible ?? CHOICE_MAX_VISIBLE, this.options.values.length),
    );
  }

  settingsHint(expanded: boolean): string {
    return keyHintBar(
      {
        hints: [moveKeyHint(), keyHint("Enter", "Select")],
        more: [
          keyHint("j/k", "Move"),
          keyHint("gg/G", "Ends"),
          keyHint("PgUp/PgDn", "Page"),
          keyHint("Space/l", "Select"),
        ],
        exit: "nested",
        exitAliases: ["h", "q"],
      },
      expanded,
    );
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    const { theme, values, current, title, description } = this.options;
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
    const resolution = this.keymap.resolve(data, { mode: "navigation" });
    const action = Predicate.isTagged(resolution, "Action") ? resolution.action : undefined;
    const kb = getKeybindings();
    const last = this.options.values.length - 1;
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
      const value = this.options.values[this.index];
      this.options.done(value === this.options.current ? undefined : value);
    } else if (kb.matches(data, "tui.select.cancel") || action === "cancel" || action === "back")
      this.options.done(undefined);
  }

  invalidate(): void {}
}

/** A choice list for one setting value, for submenus that pick from a fixed list. */
export const createSettingsChoiceSubmenu = (options: SettingsChoiceSubmenuOptions): Component =>
  new SettingsChoiceSubmenu(options);

/**
 * Gives every multi-valued, non-boolean row a choice list so Enter opens alternatives instead of
 * cycling and saving each one. Booleans keep toggling in place.
 */
export const withSettingChoiceLists = <Item extends SettingItem>(
  items: Item[],
  theme: SettingsListTheme,
): Item[] => {
  for (const item of items) {
    if (item.submenu || settingRowAffordance(item) !== "change" || !item.values) continue;
    const values = [...item.values];
    item.submenu = (current, done) =>
      createSettingsChoiceSubmenu({
        title: item.label,
        description: item.description,
        values,
        current,
        theme,
        done,
      });
  }
  return items;
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
  readonly items: () => SettingsSurfaceItem[];
  readonly onChange: (id: string, value: string) => void | Promise<void>;
  readonly done: (summary?: string) => void;
  readonly summary?: (() => string) | undefined;
  readonly listTheme: SettingsListTheme;
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

  constructor(options: SettingsGroupSubmenuOptions) {
    super();
    this.options = options;
    const items = withSettingChoiceLists(options.items(), options.listTheme);
    const notifyChange = withoutGroupRowChanges(items, (id, value) => this.change(id, value));
    this.list = new SettingsList(
      items,
      Math.min(items.length + 2, 12),
      withClippedValueMarker(options.listTheme, items),
      notifyChange,
      () => options.done(options.summary?.()),
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

  handleInput(data: string): void {
    const motion = groupMotion(data);
    if (motion && moveSettingsList(this.list, motion)) return;
    this.list.handleInput(data);
  }

  private change(id: string, value: string): void {
    const reconcile = (): void => this.reconcile();
    try {
      Promise.resolve(this.options.onChange(id, value))
        .then(reconcile, reconcile)
        .catch(() => undefined);
    } catch {
      reconcile();
    }
  }

  private reconcile(): void {
    for (const item of this.options.items()) this.list.updateValue(item.id, item.currentValue);
  }
}

export const createSettingsGroupSubmenu = (options: SettingsGroupSubmenuOptions): Component =>
  new SettingsGroupSubmenu(options);

/**
 * Saves one row and calls `show` with the value that persisted, so a failed save restores it.
 * A returned Promise lets the nested list reconcile its rows once the save settles.
 */
export type SettingsRowChange = (
  id: string,
  value: string,
  show: (shown: string) => void,
) => void | Promise<void>;

/**
 * Turns rows that list `children` into group rows (`Enter Open`) whose nested list saves each
 * child through `change`, exactly like a top-level row.
 */
export const withSettingsGroupChildren = (
  items: ReadonlyArray<SettingsSurfaceItem>,
  listTheme: SettingsListTheme,
  change: SettingsRowChange,
): SettingsSurfaceItem[] =>
  Arr.map(items, (item): SettingsSurfaceItem => {
    const { children } = item;
    if (!children) return item;
    const rows = Arr.map(children, (child): SettingsSurfaceItem => ({ ...child }));
    const show = (id: string) => (shown: string) => {
      for (const row of rows) if (row.id === id) row.currentValue = shown;
    };
    return {
      ...item,
      kind: "group",
      submenu: (_value, done) =>
        createSettingsGroupSubmenu({
          title: item.label,
          description: item.description,
          items: () => rows,
          onChange: (id, value) => change(id, value, show(id)),
          done,
          summary: item.summary,
          listTheme,
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
  return { list, surface: settingsSurfaceBridge(adapter, container, options.bridge) };
};
