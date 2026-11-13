import {
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  Text,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import { plainTheme } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import {
  createSettingsListSurface,
  managerSettingsTheme,
  type SettingsSurfaceItem,
} from "../../src/manager/settings-surface.ts";

/** A settings surface over `items`, 80 columns wide, driven by key presses under Pi's default keys. */
export const surfaceFor = (items: SettingsSurfaceItem[], onChange = vi.fn()) => {
  setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));
  const onCancel = vi.fn();
  const created = createSettingsListSurface({
    header: new Text("Settings", 0, 0),
    items,
    height: items.length,
    listTheme: managerSettingsTheme(plainTheme),
    onChange,
    onCancel,
    matchesKeybinding: undefined,
    requestRender: () => undefined,
    dim: (text) => text,
    bridge: {},
  });
  const lines = () => created.surface.render(80);
  return {
    press: (...keys: string[]) => {
      for (const key of keys) created.surface.handleInput?.(key);
    },
    onChange,
    onCancel,
    lines,
    text: () => Arr.join(lines(), "\n"),
  };
};
