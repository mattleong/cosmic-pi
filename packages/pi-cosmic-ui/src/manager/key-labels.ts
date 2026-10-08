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

/** Pi's keybindings as full-screen manager options. Labels fall back without `getKeys`. */
export const fullScreenKeybindingOptions = (keybindings: {
  matches(data: string, id: FullScreenSelectionKeybindingId): boolean;
  getKeys?(id: FullScreenSelectionKeybindingId): ReadonlyArray<string>;
}) => ({
  matchesKeybinding: (data: string, id: FullScreenSelectionKeybindingId) =>
    keybindings.matches(data, id),
  keybindingLabel: (id: FullScreenSelectionKeybindingId, fallback: string) =>
    (Predicate.isFunction(keybindings.getKeys) ? keybindings.getKeys(id) : [])
      .map(formatFullScreenKeyId)
      .join("/") || fallback,
});

const SHIFT_LABEL_PREFIX = "⇧";

/**
 * Drops configured key labels that collide with screen-reserved printable actions, so hints
 * never advertise a reserved shortcut as movement. Bare printable labels ("m") and
 * shift-modified printable labels ("⇧J") are matched against their effective printable
 * (case-sensitively, mirroring the keymap's reserved-key check). Named labels such as Space
 * can also be reserved. A label that is exactly the
 * "/" key is treated as that printable. Multi-key labels that contain a "/" key cannot be
 * distinguished from the "/" separators of this display representation without an API
 * redesign, so such labels are deliberately returned unchanged instead of being parsed
 * unsafely. Returns the fallback when nothing is left to show.
 */
const filterReservedKeyLabel = (
  label: string,
  reservedKeys: ReadonlySet<string>,
  fallback: string,
): string => {
  if (label === "/") return reservedKeys.has("/") ? fallback : label;
  const parts = label.split("/");
  // An empty segment means a literal "/" key inside a multi-key label; deferred as ambiguous.
  if (parts.some((part) => part.length === 0)) return label;
  const collides = (part: string): boolean =>
    reservedKeys.has(part) ||
    (part.length === 2 &&
      part.startsWith(SHIFT_LABEL_PREFIX) &&
      reservedKeys.has(part.slice(SHIFT_LABEL_PREFIX.length)));
  return parts.filter((part) => !collides(part)).join("/") || fallback;
};

/** Text input owns printable keys even when they are configured as selection bindings. */
export const TEXT_INPUT_KEY_LABELS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)),
  "Space",
  "⇧Space",
]);

/**
 * Hint labels for configured selection keys, each minus the `reserved` keys its screen keeps
 * for typing or shortcuts. `movement` is the configured up/down pair, absent without
 * configured labels, and `navigation` adds it after the screen's own j/k.
 */
export const configuredKeyLabels = (
  keybindingLabel: ((id: FullScreenSelectionKeybindingId, fallback: string) => string) | undefined,
  reserved: ReadonlySet<string>,
) => {
  const key = (id: FullScreenSelectionKeybindingId, fallback: string): string =>
    filterReservedKeyLabel(keybindingLabel?.(id, fallback) || fallback, reserved, fallback);
  const movement = keybindingLabel
    ? `${key("tui.select.up", "↑")}/${key("tui.select.down", "↓")}`
    : undefined;
  return { key, movement, navigation: movement ? `j/k · ${movement}` : "j/k" };
};
