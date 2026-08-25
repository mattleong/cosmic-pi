import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  SettingsList,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
  type SettingItem,
} from "@earendil-works/pi-tui";
import type { SettingsOptionDescriptor } from "../../config/options.ts";
import type { ResolvedConfig } from "../../config/schema.ts";

export function settingItemsFromDescriptors(
  descriptors: readonly SettingsOptionDescriptor[],
  cfg: ResolvedConfig,
): SettingItem[] {
  return descriptors.map((descriptor) => {
    const item: SettingItem = {
      id: descriptor.id,
      label: descriptor.label,
      currentValue: descriptor.currentValue(cfg),
      description: descriptor.description,
    };
    if (descriptor.values) item.values = [...descriptor.values];
    return item;
  });
}

interface SettingsSubmenuOptions {
  readonly title: string;
  readonly items: () => SettingItem[];
  readonly onChange: (id: string, value: string) => Promise<void>;
  readonly done: (selectedValue?: string) => void;
  readonly summary?: (() => string) | undefined;
}

/** A small category panel backed by pi-tui's SettingsList. */
export class SettingsSubmenu extends Container {
  private readonly list: SettingsList;
  private readonly options: SettingsSubmenuOptions;

  constructor(options: SettingsSubmenuOptions) {
    super();
    this.options = options;
    const items = options.items();
    this.list = new SettingsList(
      items,
      Math.min(items.length + 2, 12),
      getSettingsListTheme(),
      (id, value) => {
        const reconcile = () => this.reconcile();
        try {
          void options
            .onChange(id, value)
            .then(reconcile, reconcile)
            .catch(() => undefined);
        } catch {
          reconcile();
        }
      },
      () => options.done(options.summary?.()),
      // The outer VimSettingsAdapter owns search. A nested search input cannot clear its query
      // through that adapter, and these category lists are small enough not to need a filter.
      { enableSearch: false },
    );
    this.addChild(new Text(options.title, 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.list);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  private reconcile(): void {
    for (const item of this.options.items()) this.list.updateValue(item.id, item.currentValue);
  }
}

export function textPanel(title: string, lines: string[], done: () => void): Component {
  return {
    render: (width) => [
      title,
      "",
      ...lines.map((line) => truncateToWidth(line, width, "...")),
      "",
      "Esc/q to go back",
    ],
    invalidate() {},
    handleInput(data) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") done();
    },
  };
}
