/**
 * Pure composition of the shared `ctx.ui.custom` settings surface: caller header chrome +
 * `SettingsList` + modeless Vim adapter + focus/render bridge. Host-boundary safety stays
 * caller-owned: every callback threaded through here (change/cancel/render/bridge guard)
 * must already be guarded by the calling package's own host-ui boundary.
 */
import {
  Container,
  SettingsList,
  Spacer,
  Text,
  type Component,
  type Focusable,
  type SettingItem,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SettingsOptionDescriptor } from "pi-cosmic-core";
import { focusedField, managerTone } from "./style.ts";
import type { FullScreenKeymapOptions } from "./keymap.ts";
import {
  settingsHintRenderer,
  settingsSurfaceBridge,
  VimSettingsAdapter,
  type SettingsSurfaceBridgeOptions,
} from "./settings-adapter.ts";

export type SettingsListTheme = ConstructorParameters<typeof SettingsList>[2];

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
  descriptors.map((descriptor) => {
    const item: SettingsSurfaceItem = {
      id: descriptor.id,
      label: descriptor.label,
      currentValue: descriptor.currentValue(config),
      description: descriptor.description,
    };
    return descriptor.values ? { ...item, values: [...descriptor.values] } : item;
  });

export interface SettingsRowGenerations {
  readonly begin: (id: string) => number;
  readonly isCurrent: (id: string, generation: number) => boolean;
}

/** Pure per-row generation latch for optimistic asynchronous settings updates. */
export const settingsRowGenerations = (): SettingsRowGenerations => {
  const generations = new Map<string, number>();
  return {
    begin: (id) => {
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);
      return generation;
    },
    isCurrent: (id, generation) => generations.get(id) === generation,
  };
};

export interface SettingsGroupSubmenuOptions {
  readonly title: string;
  readonly description?: string | undefined;
  readonly items: () => SettingsSurfaceItem[];
  readonly onChange: (id: string, value: string) => void | Promise<void>;
  readonly done: (summary?: string) => void;
  readonly summary?: (() => string) | undefined;
  readonly listTheme: SettingsListTheme;
  readonly maxVisible?: number | undefined;
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
      options.maxVisible ?? Math.min(items.length + 2, 12),
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

export interface SettingsListSurfaceOptions {
  /** Caller-owned header component rendered above the list (title, config path, …). */
  readonly header: Component;
  readonly items: SettingsSurfaceItem[];
  readonly height: number;
  readonly listTheme: SettingsListTheme;
  /** Value-change callback for setting rows; group rows are filtered out by the surface. */
  readonly onChange: (id: string, value: string, list: SettingsList) => void;
  readonly onCancel: () => void;
  readonly search?: boolean | undefined;
  readonly matchesKeybinding?: FullScreenKeymapOptions["matchesKeybinding"];
  /** Caller-owned (host-guarded) render request used by the Vim adapter. */
  readonly requestRender?: (() => void) | undefined;
  /** Caller-owned dim styling for the shared modeless hint line. */
  readonly dim: (text: string) => string;
  /** Caller-owned host-boundary guard options for the composed bridge. */
  readonly bridge?: SettingsSurfaceBridgeOptions | undefined;
}

export interface SettingsListSurface {
  readonly list: SettingsList;
  readonly surface: Component & Focusable;
}

export const createSettingsListSurface = (
  options: SettingsListSurfaceOptions,
): SettingsListSurface => {
  const search = options.search ?? true;
  const container = new Container();
  container.addChild(options.header);
  const list: SettingsList = new SettingsList(
    options.items,
    options.height,
    options.listTheme,
    withoutGroupRowChanges(options.items, (id, value) => options.onChange(id, value, list)),
    options.onCancel,
    { enableSearch: search },
  );
  const adapter = new VimSettingsAdapter(list, {
    search,
    matchesKeybinding: options.matchesKeybinding,
    requestRender: options.requestRender,
    renderHint: settingsHintRenderer({ search, dim: options.dim }),
  });
  container.addChild(adapter);
  return { list, surface: settingsSurfaceBridge(adapter, container, options.bridge ?? {}) };
};
