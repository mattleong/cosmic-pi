import * as Arr from "effect/Array";
import { matchesKey } from "@earendil-works/pi-tui";
import { configuredKeyLabels } from "pi-cosmic-ui/manager/key-labels";
import { FULL_SCREEN_NAVIGATION_SHORTCUTS } from "pi-cosmic-ui/manager/keymap";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";

export const PROFILE_WORKSPACE_SHORTCUTS: ReadonlySet<string> = new Set([
  "/",
  "s",
  "m",
  "e",
  "a",
  "+",
  "[",
  "]",
]);
export const isWorkspaceNavigationKey = (data: string): boolean =>
  Arr.some(["up", "down", "left", "right", "tab", "shift+tab"] as const, (key) =>
    matchesKey(data, key),
  );

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

/**
 * The editor's configured select keys as its hints name them: primary keys for the default bar,
 * and the cancel key's aliases, such as `C-c`, for expanded help.
 */
export const profileWorkspaceKeys = (
  labels: SearchableSelectHostOptions["keybindingLabel"],
  confirmation = false,
) => {
  const keys = configuredKeyLabels(labels, confirmation ? confirmationKeys : navigationKeys);
  const cancel = keys.binding("tui.select.cancel", "Esc");
  return {
    move: keys.movement ?? "↑↓",
    confirm: keys.primary("tui.select.confirm", "Enter"),
    cancel: cancel.key,
    cancelAliases: cancel.aliases,
  };
};
