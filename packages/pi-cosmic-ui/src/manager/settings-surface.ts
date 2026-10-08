/**
 * Pure composition of the shared `ctx.ui.custom` settings surface: header chrome +
 * `SettingsList` + modeless Vim adapter + focus/render bridge. `boundary/host-settings-command.ts`
 * opens it and guards every host callback threaded through here.
 */
import {
  Container,
  SettingsList,
  Spacer,
  Text,
  type Component,
  type SettingItem,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SettingsOptionDescriptor } from "pi-cosmic-core";
import { focusedField, managerTone } from "./style.ts";
import type { FullScreenKeymapOptions } from "./keymap.ts";
import {
  fullScreenSettingsHint,
  settingsSurfaceBridge,
  VimSettingsAdapter,
  type SettingsSurfaceBridgeOptions,
} from "./settings-adapter.ts";

type SettingsListTheme = ConstructorParameters<typeof SettingsList>[2];

/** Public SettingsList callbacks only; focus and navigation remain owned by Pi. */
export const managerSettingsTheme = (theme: Theme): SettingsListTheme => ({
  label: (text, selected) => (selected ? focusedField(theme, text) : theme.fg("text", text)),
  value: (text, selected) =>
    selected ? focusedField(theme, text) : theme.fg(managerTone.value, text),
  description: (text) => theme.fg("muted", text),
  cursor: theme.fg("accent", "› "),
  hint: (text) => theme.fg("dim", text),
});

export type SettingsSurfaceItem = SettingItem & {
  /** "group" marks navigation/summary rows whose submenu completions never reach `onChange`. */
  readonly kind?: "setting" | "group";
};

/** Wraps a SettingsList change callback so group/navigation rows never reach it. */
export const withoutGroupRowChanges = (
  items: readonly SettingsSurfaceItem[],
  onChange: (id: string, value: string) => void,
): ((id: string, value: string) => void) => {
  const groupIds = new Set(items.filter((item) => item.kind === "group").map((item) => item.id));
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
  descriptors.map((descriptor) => ({
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

class SettingsGroupSubmenu extends Container {
  private readonly options: SettingsGroupSubmenuOptions;
  private readonly list: SettingsList;

  constructor(options: SettingsGroupSubmenuOptions) {
    super();
    this.options = options;
    const items = options.items();
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

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  private change(id: string, value: string): void {
    const reconcile = (): void => this.reconcile();
    try {
      Promise.resolve(this.options.onChange(id, value)).then(reconcile, reconcile);
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
  /** Rendered above the list (title, config path, …). */
  readonly header: Component;
  readonly items: SettingsSurfaceItem[];
  readonly height: number;
  readonly listTheme: SettingsListTheme;
  /** Value-change callback for setting rows; group rows are filtered out by the surface. */
  readonly onChange: (id: string, value: string, list: SettingsList) => void;
  readonly onCancel: () => void;
  readonly matchesKeybinding: FullScreenKeymapOptions["matchesKeybinding"];
  readonly requestRender: () => void;
  /** Dim styling for the shared modeless hint line. */
  readonly dim: (text: string) => string;
  readonly bridge: SettingsSurfaceBridgeOptions;
}

export const createSettingsListSurface = (options: SettingsListSurfaceOptions) => {
  const container = new Container();
  container.addChild(options.header);
  const list: SettingsList = new SettingsList(
    options.items,
    options.height,
    options.listTheme,
    withoutGroupRowChanges(options.items, (id, value) => options.onChange(id, value, list)),
    options.onCancel,
    { enableSearch: true },
  );
  const adapter = new VimSettingsAdapter(list, {
    matchesKeybinding: options.matchesKeybinding,
    requestRender: options.requestRender,
    renderHint: (mode, helpExpanded) =>
      options.dim(` ${fullScreenSettingsHint(mode === "search", helpExpanded)} `),
  });
  container.addChild(adapter);
  return { list, surface: settingsSurfaceBridge(adapter, container, options.bridge) };
};
