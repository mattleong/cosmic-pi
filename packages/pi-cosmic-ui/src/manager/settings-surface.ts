/**
 * Pure composition of the shared `ctx.ui.custom` settings surface: caller header chrome +
 * `SettingsList` + modeless Vim adapter + focus/render bridge. Host-boundary safety stays
 * caller-owned: every callback threaded through here (change/cancel/render/bridge guard)
 * must already be guarded by the calling package's own host-ui boundary.
 */
import {
  Container,
  SettingsList,
  type Component,
  type Focusable,
  type SettingItem,
} from "@earendil-works/pi-tui";
import type { FullScreenKeymapOptions } from "./keymap.ts";
import {
  settingsHintRenderer,
  settingsSurfaceBridge,
  VimSettingsAdapter,
  type SettingsSurfaceBridgeOptions,
} from "./settings-adapter.ts";

type SettingsListTheme = ConstructorParameters<typeof SettingsList>[2];

export interface SettingsListSurfaceOptions {
  /** Caller-owned header component rendered above the list (title, config path, …). */
  readonly header: Component;
  readonly items: SettingItem[];
  readonly height: number;
  readonly listTheme: SettingsListTheme;
  /** Value-change callback; receives the composed list for optimistic display updates. */
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
    (id, value) => options.onChange(id, value, list),
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
