import { matchesKey } from "@earendil-works/pi-tui";
import { configuredKeyLabels } from "pi-cosmic-ui/manager/key-labels";
import { FULL_SCREEN_NAVIGATION_SHORTCUTS } from "pi-cosmic-ui/manager/keymap";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";

/** Screen-owned shortcuts precede configured navigation in FullScreenKeymap. */
export const PROFILE_WORKSPACE_SHORTCUTS: ReadonlySet<string> = new Set([
  "/",
  "s",
  "m",
  "e",
  "r",
  "a",
  "+",
  "[",
  "]",
]);
export const isWorkspaceNavigationKey = (data: string): boolean =>
  (["up", "down", "left", "right", "tab", "shift+tab"] as const).some((key) =>
    matchesKey(data, key),
  );

/** Configured bindings never claim raw arrows or Tab, which always navigate. */
export const withoutNavigationKeys =
  (
    matches: SearchableSelectHostOptions["matchesKeybinding"],
  ): NonNullable<SearchableSelectHostOptions["matchesKeybinding"]> =>
  (data, id) =>
    !isWorkspaceNavigationKey(data) && (matches?.(data, id) ?? false);

const navigationKeys = new Set([
  ...PROFILE_WORKSPACE_SHORTCUTS,
  ...FULL_SCREEN_NAVIGATION_SHORTCUTS,
]);
const confirmationKeys = new Set(["q", "Q"]);

export const profileWorkspaceKeys = (
  labels: SearchableSelectHostOptions["keybindingLabel"],
  confirmation = false,
) => {
  const { key } = configuredKeyLabels(labels, confirmation ? confirmationKeys : navigationKeys);
  return {
    up: key("tui.select.up", "↑"),
    down: key("tui.select.down", "↓"),
    confirm: key("tui.select.confirm", "Enter"),
    cancel: key("tui.select.cancel", "Esc"),
  };
};
