import {
  Container,
  getKeybindings,
  Key,
  matchesKey,
  SettingsList,
  Spacer,
  Text,
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
import { clipToWidth } from "./chrome.ts";
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

/**
 * `kind: "group"` rows open a nested list (`Enter Open`). A row with a submenu that picks a value
 * should set `kind: "setting"` so Enter reads `Enter Change`.
 */
export type SettingsSurfaceItem = SettingItem & {
  readonly kind?: "setting" | "group";
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
    const about = description
      ? Arr.map(wrapTextWithAnsi(description, Math.max(1, safeWidth - 2)), (line) =>
          theme.description(line),
        )
      : [];
    return [theme.label(title, false), ...about, "", ...rows, ...position];
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
      options.listTheme,
      notifyChange,
      () => options.done(options.summary?.()),
      { enableSearch: false },
    );
    this.addChild(new Text(options.title, 0, 0));
    if (options.description) this.addChild(new Text(options.description, 0, 0));
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
    options.listTheme,
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
