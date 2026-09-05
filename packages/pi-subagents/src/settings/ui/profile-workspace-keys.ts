import { filterReservedKeyLabel } from "pi-cosmic-ui/manager/key-labels";
import { FULL_SCREEN_NAVIGATION_SHORTCUTS } from "pi-cosmic-ui/manager/keymap";
import type {
  SearchableSelectHostOptions,
  SettingsSelectKeybindingId,
} from "pi-cosmic-ui/manager/searchable-select";

/** Screen-owned shortcuts precede configured navigation in FullScreenKeymap. */
export const PROFILE_WORKSPACE_SHORTCUTS: ReadonlySet<string> = new Set([
  "/",
  "p",
  "s",
  "t",
  "m",
  "e",
  "r",
  "a",
  "+",
  "f",
  "[",
  "]",
]);
const navigationKeys = new Set([
  ...PROFILE_WORKSPACE_SHORTCUTS,
  ...FULL_SCREEN_NAVIGATION_SHORTCUTS,
]);
const confirmationKeys = new Set(["q", "Q"]);

export const profileWorkspaceKeys = (
  labels: SearchableSelectHostOptions["keybindingLabel"],
  confirmation = false,
) => {
  const key = (id: SettingsSelectKeybindingId, fallback: string) =>
    filterReservedKeyLabel(
      labels?.(id, fallback) ?? fallback,
      confirmation ? confirmationKeys : navigationKeys,
      fallback,
    );
  return {
    up: key("tui.select.up", "↑"),
    down: key("tui.select.down", "↓"),
    confirm: key("tui.select.confirm", "Enter"),
    cancel: key("tui.select.cancel", "Esc"),
  };
};

export type ProfileWorkspaceKeys = ReturnType<typeof profileWorkspaceKeys>;
