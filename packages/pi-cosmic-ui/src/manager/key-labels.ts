import type { FullScreenSelectionKeybindingId } from "./keymap.ts";

const SPECIAL_KEY_LABELS: Readonly<Record<string, string>> = {
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
};

const MODIFIER_LABELS: Readonly<Record<string, string>> = {
  ctrl: "C-",
  shift: "⇧",
  alt: "A-",
  super: "⌘",
};

export const formatFullScreenKeyId = (value: string): string => {
  const parts = value.split("+");
  const base = parts.pop() ?? value;
  const modifiers = parts.map((part) => MODIFIER_LABELS[part] ?? `${part}-`).join("");
  const label = SPECIAL_KEY_LABELS[base] ?? base;
  return `${modifiers}${parts.includes("shift") && base.length === 1 ? label.toUpperCase() : label}`;
};

export const fullScreenKeybindingLabel = (
  id: FullScreenSelectionKeybindingId,
  fallback: string,
  getKeys?: ((id: FullScreenSelectionKeybindingId) => ReadonlyArray<string>) | undefined,
): string => getKeys?.(id).map(formatFullScreenKeyId).join("/") || fallback;

const SHIFT_LABEL_PREFIX = "⇧";

/**
 * Drops configured key labels that collide with screen-reserved printable actions, so hints
 * never advertise a reserved shortcut as movement. Bare printable labels ("m") and
 * shift-modified printable labels ("⇧J") are matched against their effective printable
 * (case-sensitively, mirroring the keymap's reserved-key check). A label that is exactly the
 * "/" key is treated as that printable. Multi-key labels that contain a "/" key cannot be
 * distinguished from the "/" separators of this display representation without an API
 * redesign, so such labels are deliberately returned unchanged instead of being parsed
 * unsafely. Returns the fallback when nothing is left to show.
 */
export const filterReservedKeyLabel = (
  label: string,
  reservedKeys: ReadonlySet<string>,
  fallback: string,
): string => {
  if (label === "/") return reservedKeys.has("/") ? fallback : label;
  const parts = label.split("/");
  // An empty segment means a literal "/" key inside a multi-key label; deferred as ambiguous.
  if (parts.some((part) => part.length === 0)) return label;
  const collides = (part: string): boolean =>
    (part.length === 1 && reservedKeys.has(part)) ||
    (part.length === 2 &&
      part.startsWith(SHIFT_LABEL_PREFIX) &&
      reservedKeys.has(part.slice(SHIFT_LABEL_PREFIX.length)));
  return parts.filter((part) => !collides(part)).join("/") || fallback;
};
