import * as Predicate from "effect/Predicate";
import type { FullScreenSelectionKeybindingId } from "./keymap.ts";

const SPECIAL_KEY_LABELS = new Map(
  Object.entries({
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    enter: "Enter",
    escape: "Esc",
    pageUp: "PgUp",
    pageDown: "PgDn",
    home: "Home",
    end: "End",
    tab: "Tab",
    space: "Space",
  }),
);

const MODIFIER_LABELS = new Map(
  Object.entries({
    ctrl: "C-",
    shift: "⇧",
    alt: "A-",
    super: "⌘",
  }),
);

const formatFullScreenKeyId = (value: string): string => {
  const parts = value.split("+");
  const base = parts.pop() ?? value;
  const modifiers = parts.map((part) => MODIFIER_LABELS.get(part) ?? `${part}-`).join("");
  const label = SPECIAL_KEY_LABELS.get(base) ?? base;
  return `${modifiers}${parts.includes("shift") && base.length === 1 ? label.toUpperCase() : label}`;
};

export interface HostKeybindingSource {
  readonly matches: (data: string, id: FullScreenSelectionKeybindingId) => boolean;
  readonly getKeys?: (id: FullScreenSelectionKeybindingId) => ReadonlyArray<string>;
}

export const fullScreenKeybindingOptions = (keybindings: HostKeybindingSource) => ({
  matchesKeybinding: (data: string, id: FullScreenSelectionKeybindingId) =>
    keybindings.matches(data, id),
  keybindingLabel: (id: FullScreenSelectionKeybindingId, fallback: string) =>
    (Predicate.isFunction(keybindings.getKeys) ? keybindings.getKeys(id) : [])
      .map(formatFullScreenKeyId)
      .join("/") || fallback,
});

const SHIFT_LABEL_PREFIX = "⇧";

const filterReservedKeyLabel = (
  label: string,
  reservedKeys: ReadonlySet<string>,
  fallback: string,
): string => {
  if (label === "/") return reservedKeys.has("/") ? fallback : label;
  const parts = label.split("/");
  if (parts.some((part) => part.length === 0)) return label;
  const collides = (part: string): boolean =>
    reservedKeys.has(part) ||
    (part.length === 2 &&
      part.startsWith(SHIFT_LABEL_PREFIX) &&
      reservedKeys.has(part.slice(SHIFT_LABEL_PREFIX.length)));
  return parts.filter((part) => !collides(part)).join("/") || fallback;
};

export const TEXT_INPUT_KEY_LABELS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)),
  "Space",
  "⇧Space",
]);

export const configuredKeyLabels = (
  keybindingLabel: ((id: FullScreenSelectionKeybindingId, fallback: string) => string) | undefined,
  reserved: ReadonlySet<string>,
) => {
  const key = (id: FullScreenSelectionKeybindingId, fallback: string): string => {
    const configured = keybindingLabel?.(id, fallback);
    const label = configured === undefined || configured === "" ? fallback : configured;
    return filterReservedKeyLabel(label, reserved, fallback);
  };
  const movement = keybindingLabel
    ? `${key("tui.select.up", "↑")}/${key("tui.select.down", "↓")}`
    : undefined;
  return { key, movement, navigation: movement ? `j/k · ${movement}` : "j/k" };
};
